import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assemblePlan, buildPlanPath, masteredFromMastery, masteredFromProfile, validateMilestoneDraft } from '../core/plan.ts'
import type { KnowledgeMap, LearnerProfile, Mastery, Plan } from '../core/schema.ts'
import { createAgentChat } from './agent-chat.ts'
import { generateTurn, parseJsonBlock } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'

const name = 'tutor-plan-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({ courseId: z.string().required() })

interface StoreView {
  root: string
  exists(id: string): boolean
  has(id: string, kind: string): boolean
  read(id: string, kind: string): unknown
  write(id: string, kind: string, data: unknown): void
}

function masteredNodes(store: StoreView, courseId: string): Set<string> {
  if (store.has(courseId, 'mastery')) {
    return masteredFromMastery(store.read(courseId, 'mastery') as Mastery)
  }
  if (store.has(courseId, 'learner-profile')) {
    return masteredFromProfile(store.read(courseId, 'learner-profile') as LearnerProfile)
  }
  return new Set()
}

async function run(ctx: Context, config: { courseId: string }): Promise<void> {
  const courseState = ctx.get('courseState') as { store: StoreView } | undefined
  if (!courseState) throw new Error('tutor: 核心服务未就绪')
  const store = courseState.store
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  const out = process.stdout
  if (!store.exists(config.courseId)) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    process.stdin.destroy()
  exit(1)
    return
  }
  if (!store.has(config.courseId, 'knowledge-map')) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 缺少知识地图，请先运行 npm run agent -- assess ${config.courseId}\n`)
    process.stdin.destroy()
  exit(1)
    return
  }
  const map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
  const mastered = masteredNodes(store, config.courseId)
  const hasProfile = store.has(config.courseId, 'learner-profile')
  if (!hasProfile) out.write('提示：尚未摸底，按零基础全量规划（可先运行 assess）。\n')

  const path = buildPlanPath(map, mastered)
  const titles = new Map(map.nodes.map((n) => [n.id, n.title]))
  if (path.length === 0) {
    const plan = assemblePlan([], [])
    store.write(config.courseId, 'plan', plan)
    out.write('所有知识点均已掌握，无需生成教学路径。\n')
    process.stdin.destroy()
  exit(0)
    return
  }

  const masteryView = store.has(config.courseId, 'mastery')
    ? (store.read(config.courseId, 'mastery') as Mastery)
    : undefined
  const profileView = hasProfile ? (store.read(config.courseId, 'learner-profile') as LearnerProfile) : undefined
  const pathLines = path.map((node) => {
    const status = masteryView?.[node]?.status ?? 'unknown'
    const score = profileView?.nodes[node]?.score
    return `- ${node}（${titles.get(node) ?? node}${score !== undefined ? `，摸底 ${score}` : ''}，当前：${status}）`
  })
  out.write(`教学路径：${path.length} 个知识点待学。正在设计里程碑…\n`)

  const chat = await createAgentChat(ctx)
  if (!chat) throw new Error('tutor: 模型会话创建失败')
  const prompt = [
    '任务：为下列教学路径设计里程碑。',
    '',
    '教学路径（已按依赖排序，不得打乱）：',
    ...pathLines,
    '',
    '请输出里程碑 JSON（```json 代码块），milestones 为 2-4 个，每个含 title（可验收的目标式描述）与 nodes（路径中知识点 id，遵循先后顺序，可只覆盖部分路径节点）。',
  ].join('\n')
  const draft = await generateTurn(chat, prompt, (text) => {
    const data = parseJsonBlock(text)
    if (!data.ok) return data
    return validateMilestoneDraft(data.value, path)
  })
  const milestones = draft as { title: string; nodes: string[] }[]
  const plan: Plan = assemblePlan(path, milestones)
  store.write(config.courseId, 'plan', plan)

  out.write(`\n教学计划已生成（${store.root}/${config.courseId}/plan.yaml）：\n`)
  out.write(`路径：${plan.path.join(' → ')}\n`)
  for (const milestone of plan.milestones) {
    out.write(`- ${milestone.id}：${milestone.title}（${milestone.nodes.join('、')}）\n`)
  }
  out.write(`当前指针：${plan.current ?? '（无）'}\n`)
  await chat.flush()
  printSessionTotal(chat, out)
  process.stdin.destroy()
  exit(0)
}

export function apply(ctx: Context, config: { courseId: string }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-plan-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy()
  exit(1)
  })
}

export { name, inject, Config }
