import { buildPracticeGenPrompt, practiceGenerationNodes, validatePracticeTasks } from '../core/practice.ts'
import type { KnowledgeMap, Plan, PracticeTaskFile, Profile } from '../core/schema.ts'
import { parseJsonBlock } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'
import { mapContent, planContent, practiceContent } from '../core/content-quality.ts'
import { createContentGate, generateApproved } from './content-gate.ts'
import { profileScope } from '../core/interview.ts'
import { applyPracticeEdits, PRACTICE_REPAIR_PERSONA, practiceRepairPrompt } from '../core/content-edit.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'
import { today } from './deps.ts'

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
  const gate = createContentGate(deps, config.courseId)
  await gate.require(mapContent(map, profile))
  await gate.require(planContent(plan, profile, map))
  const file: PracticeTaskFile = store.has(config.courseId, 'practice')
    ? (store.read(config.courseId, 'practice') as PracticeTaskFile)
    : { generated_at: today(), tasks: [] }
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

  const chat = await deps.createChat()

  const titles = new Map(map.nodes.map((n) => [n.id, n]))
  for (let i = 0; i < queue.length; i += batchSize) {
    const batch = queue.slice(i, i + batchSize)
    for (const node of batch) {
      const issues = repairs.get(node)
      io.out(`\n正在${issues ? '修复旧任务' : '出题'}：${node}（${titles.get(node)?.title ?? node}）…\n`)
      let result: PracticeTaskFile
      if (issues) {
        const oldTasks = file.tasks.filter(task => task.node === node)
        const repairChat = await deps.createChat({ isolatedSystemPrompt: PRACTICE_REPAIR_PERSONA, maxTokens: 8192, retryOnLength: false })
        result = await generateApproved<PracticeTaskFile>(repairChat, practiceRepairPrompt(oldTasks, profile, issues), text => {
          const data = parseJsonBlock(text)
          return data.ok ? applyPracticeEdits(oldTasks, data.value, node, today()) : data
        }, gate, value => practiceContent(value.tasks, node, profile, map), { out: io.out })
        printSessionTotal(repairChat, deps)
      } else result = await generateApproved<PracticeTaskFile>(chat, buildPracticeGenPrompt({
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
        return validatePracticeTasks({ generated_at: today(), tasks: (data.value as { tasks?: unknown[] }).tasks ?? data.value }, node)
      }, gate, value => practiceContent(value.tasks, node, profile, map), { out: io.out })
      file.tasks = file.tasks.filter(task => task.node !== node)
      file.tasks.push(...result.tasks)
      file.generated_at = today()
      store.write(config.courseId, 'practice', file)
      io.out(`  已保存（practice.yaml 累计 ${file.tasks.length} 个任务，可随时中断）\n`)
    }
  }

  io.out(`\n实践任务生成完成：覆盖 ${new Set(file.tasks.map((t) => t.node)).size} 个知识点。\n`)
  await chat.flush()
  printSessionTotal(chat, deps)
  throw new FlowExit(0)
}
