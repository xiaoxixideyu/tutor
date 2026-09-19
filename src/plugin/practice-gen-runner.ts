import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { buildPracticeGenPrompt, validatePracticeTasks } from '../core/practice.ts'
import type { Mastery, Plan, PracticeTaskFile, Profile } from '../core/schema.ts'
import { createAgentChat, type AgentChat } from './agent-chat.ts'
import { generateTurn, parseJsonBlock } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'

const name = 'tutor-practice-gen-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({ courseId: z.string().required(), batchSize: z.number().default(3) })

interface StoreView {
  root: string
  exists(id: string): boolean
  has(id: string, kind: string): boolean
  read(id: string, kind: string): unknown
  write(id: string, kind: string, data: unknown): void
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function run(ctx: Context, config: { courseId: string; batchSize: number }): Promise<void> {
  const courseState = ctx.get('courseState') as { store: StoreView } | undefined
  if (!courseState) throw new Error('tutor: 核心服务未就绪')
  const store = courseState.store
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  const out = process.stdout
  if (!store.exists(config.courseId)) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    exit(1)
    return
  }
  if (!store.has(config.courseId, 'knowledge-map') || !store.has(config.courseId, 'plan')) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 缺少知识地图或教学计划，请先运行 assess 与 plan\n`)
    exit(1)
    return
  }
  const profile = store.read(config.courseId, 'profile') as Profile
  const map = store.read(config.courseId, 'knowledge-map') as { nodes: { id: string; title?: string; summary?: string }[] }
  const plan = store.read(config.courseId, 'plan') as Plan
  const mastery = store.has(config.courseId, 'mastery') ? (store.read(config.courseId, 'mastery') as Mastery) : undefined
  const file: PracticeTaskFile = store.has(config.courseId, 'practice')
    ? (store.read(config.courseId, 'practice') as PracticeTaskFile)
    : { generated_at: today(), tasks: [] }
  if (store.has(config.courseId, 'practice')) out.write(`已有实践任务（${file.tasks.length} 个），继续补齐。\n`)

  const covered = new Set(file.tasks.map((task) => task.node))
  const queue = plan.path.filter((nodeId) => mastery?.[nodeId]?.status !== 'mastered' && !covered.has(nodeId))
  if (queue.length === 0) {
    out.write('路径上的知识点均已有实践任务（或已掌握），无需生成。\n')
    exit(0)
    return
  }
  out.write(`待生成实践任务的知识点 ${queue.length} 个（${queue.join('、')}）。\n`)

  const chat: AgentChat | null = await createAgentChat(ctx)
  if (!chat) throw new Error('tutor: 模型会话创建失败')

  const titles = new Map(map.nodes.map((n) => [n.id, n]))
  for (let i = 0; i < queue.length; i += config.batchSize) {
    const batch = queue.slice(i, i + config.batchSize)
    for (const node of batch) {
      out.write(`\n正在出题：${node}（${titles.get(node)?.title ?? node}）…\n`)
      const result = (await generateTurn(chat, buildPracticeGenPrompt({
        courseId: config.courseId,
        node,
        title: titles.get(node)?.title,
        summary: titles.get(node)?.summary,
        goal: profile.goal,
        background: profile.background,
        style: profile.style,
      }), (text) => {
        const data = parseJsonBlock(text)
        if (!data.ok) return data
        // 校验单节点任务（node 不匹配、任务数超限等由 validatePracticeTasks 拦）
        return validatePracticeTasks({ generated_at: today(), tasks: (data.value as { tasks?: unknown[] }).tasks ?? data.value }, node)
      })) as PracticeTaskFile
      file.tasks.push(...result.tasks)
      file.generated_at = today()
      store.write(config.courseId, 'practice', file)
      out.write(`  已保存（practice.yaml 累计 ${file.tasks.length} 个任务，可随时中断）\n`)
    }
  }

  out.write(`\n实践任务生成完成：覆盖 ${new Set(file.tasks.map((t) => t.node)).size} 个知识点。\n`)
  await chat.flush()
  printSessionTotal(chat, out)
  exit(0)
}

export function apply(ctx: Context, config: { courseId: string; batchSize: number }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-practice-gen-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}

export { name, inject, Config }
