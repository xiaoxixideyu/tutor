import { buildPracticeGenPrompt, practiceGenerationNodes, validatePracticeTasks } from '../core/practice.ts'
import type { KnowledgeMap, Plan, PracticeTaskFile, Profile } from '../core/schema.ts'
import { parseJsonBlock } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'
import { recordChatTotal } from './cost-ledger.ts'
import { mapContent, planContent, practiceContent } from '../core/content-quality.ts'
import { createContentGate, generateApproved } from './content-gate.ts'
import { profileScope } from '../core/interview.ts'
import { applyPracticeEdits, PRACTICE_REPAIR_PERSONA, practiceRepairPrompt } from '../core/content-edit.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'
import { requirePlanMapConsistency } from './consistency.ts'

export async function runPracticeGen(deps: FlowDeps, config: { courseId: string; batchSize?: number; nodeId?: string }): Promise<void> {
  const batchSize = config.batchSize ?? 3
  const { store, io } = deps
  if (!store.exists(config.courseId)) {
    io.err(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    throw new FlowExit(1)
  }
  if (!store.has(config.courseId, 'knowledge-map') || !store.has(config.courseId, 'plan')) {
    io.err(`tutor: 课程 "${config.courseId}" 缺少知识地图或教学计划，请先运行 assess 与 plan\n`)
    throw new FlowExit(1)
  }
  const profile = store.read(config.courseId, 'profile') as Profile
  const map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
  const plan = store.read(config.courseId, 'plan') as Plan
  requirePlanMapConsistency(deps, config.courseId, plan, map)
  const gate = createContentGate(deps, config.courseId)
  await gate.require(mapContent(map, profile))
  await gate.require(planContent(plan, profile, map))
  const file: PracticeTaskFile = store.has(config.courseId, 'practice')
    ? (store.read(config.courseId, 'practice') as PracticeTaskFile)
    : { generated_at: deps.today(), tasks: [] }
  if (store.has(config.courseId, 'practice')) io.out(`已有实践任务（${file.tasks.length} 个），继续补齐。\n`)

  const queue = practiceGenerationNodes(plan, map, file, config.nodeId)
  const repairs = new Map<string, string[]>()
  // 老任务不因文件存在而跳过；逐节点审查，通过后才可复用，修复通过后才替换。
  for (const node of new Set(file.tasks.map(task => task.node))) {
    if (config.nodeId && config.nodeId !== node) continue
    const verdict = await gate.review(practiceContent(file.tasks.filter(task => task.node === node), node, profile, map))
    if (!verdict.approved) {
      repairs.set(node, verdict.issues)
      if (!queue.includes(node)) queue.push(node)
    }
  }
  if (queue.length === 0) {
    io.out('所选知识点均已有实践任务，无需生成。\n')
    throw new FlowExit(0)
  }
  io.out(`待生成实践任务的知识点 ${queue.length} 个（${queue.join('、')}）。\n`)

  const titles = new Map(map.nodes.map((n) => [n.id, n]))
  const failed: { node: string; reason: string }[] = []
  for (let i = 0; i < queue.length; i += batchSize) {
    const batch = queue.slice(i, i + batchSize)
    for (const node of batch) {
      const issues = repairs.get(node)
      io.out(`\n正在${issues ? '修复旧任务' : '出题'}：${node}（${titles.get(node)?.title ?? node}）…\n`)
      let result: PracticeTaskFile
      try {
        if (issues) {
          const oldTasks = file.tasks.filter(task => task.node === node)
          const repairChat = await deps.createChat({ isolatedSystemPrompt: PRACTICE_REPAIR_PERSONA, maxTokens: 8192, retryOnLength: false })
          result = await generateApproved<PracticeTaskFile>(repairChat, practiceRepairPrompt(oldTasks, profile, issues), text => {
            const data = parseJsonBlock(text)
            return data.ok ? applyPracticeEdits(oldTasks, data.value, node, deps.today()) : data
          }, gate, value => practiceContent(value.tasks, node, profile, map), { out: io.out })
          await repairChat.flush()
          recordChatTotal(deps.costs, repairChat, 'practice-repair')
          printSessionTotal(repairChat, deps)
        } else {
          // 每个知识点独立会话：避免上一个知识点的任务 JSON、测试命令和提示词污染下一个。
          const chat = await deps.createChat({ retryOnLength: false })
          result = await generateApproved<PracticeTaskFile>(chat, buildPracticeGenPrompt({
            courseId: config.courseId,
            node,
            title: titles.get(node)?.title,
            summary: titles.get(node)?.summary,
            goal: profileScope(profile),
            background: profile.background,
            style: profile.style,
          }), (text) => {
            const data = parseJsonBlock(text)
            if (!data.ok) return data
            // 校验单节点任务（node 不匹配、任务数超限等由 validatePracticeTasks 拦）
            return validatePracticeTasks({ generated_at: deps.today(), tasks: (data.value as { tasks?: unknown[] }).tasks ?? data.value }, node)
          }, gate, value => practiceContent(value.tasks, node, profile, map), { out: io.out })
          await chat.flush()
          recordChatTotal(deps.costs, chat, 'practice-gen')
          printSessionTotal(chat, deps)
        }
      } catch (error) {
        // 单个知识点失败不该拖垮整批：其余知识点继续出题，失败节点记录下来重跑即可补齐。
        const reason = error instanceof Error ? error.message : String(error)
        failed.push({ node, reason })
        io.err(`tutor: 知识点 "${node}" 的实践任务生成失败，已跳过（${reason.split('\n')[0]}）\n`)
        continue
      }
      file.tasks = file.tasks.filter(task => task.node !== node)
      file.tasks.push(...result.tasks)
      file.generated_at = deps.today()
      store.write(config.courseId, 'practice', file)
      io.out(`  已保存（practice.yaml 累计 ${file.tasks.length} 个任务，可随时中断）\n`)
    }
  }

  const covered = new Set(file.tasks.map(t => t.node))
  io.out(`\n实践任务生成完成：覆盖 ${covered.size} 个知识点。\n`)
  if (failed.length > 0) {
    io.out(`${failed.length} 个知识点未完成：${failed.map(item => item.node).join('、')}。\n`)
    for (const item of failed) io.out(`- ${item.node}：${item.reason.split('\n')[0]}\n`)
    io.out('重新运行 practice-gen 会只补齐未完成的知识点。\n')
    throw new FlowExit(1)
  }
  throw new FlowExit(0)
}
