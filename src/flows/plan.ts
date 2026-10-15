import { assemblePlan, buildPlanPath, masteredFromMastery, masteredFromProfile, validateMilestoneDraft } from '../core/plan.ts'
import type { KnowledgeMap, LearnerProfile, Mastery, Plan, Profile } from '../core/schema.ts'
import { parseJsonBlock } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'
import { topoOrder } from '../core/knowledge.ts'
import { mapContent, planContent } from '../core/content-quality.ts'
import { createContentGate, generateApproved } from './content-gate.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'

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

export async function runPlan(deps: FlowDeps, config: { courseId: string }): Promise<void> {
  const { store, io } = deps
  if (!store.exists(config.courseId)) {
    io.err(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    io.closeInput()
    throw new FlowExit(1)
  }
  if (!store.has(config.courseId, 'knowledge-map')) {
    io.err(`tutor: 课程 "${config.courseId}" 缺少知识地图，请先运行 npm run agent -- assess ${config.courseId}\n`)
    io.closeInput()
    throw new FlowExit(1)
  }
  const map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
  const profile = store.read(config.courseId, 'profile') as Profile
  const gate = createContentGate(deps, config.courseId)
  await gate.require(mapContent(map, profile))
  const mastered = masteredNodes(store, config.courseId)
  const hasProfile = store.has(config.courseId, 'learner-profile')
  if (!hasProfile) io.out('提示：尚未摸底，按零基础全量规划（可先运行 assess）。\n')

  const path = buildPlanPath(map, mastered)
  const titles = new Map(map.nodes.map((n) => [n.id, n.title]))
  if (path.length === 0) {
    const plan = assemblePlan([], [], topoOrder(map))
    await gate.require(planContent(plan, profile, map))
    store.write(config.courseId, 'plan', plan)
    io.out('所有知识点均已掌握，无需生成教学路径。\n')
    io.closeInput()
    throw new FlowExit(0)
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
  io.out(`教学路径：${path.length} 个知识点待学。正在设计里程碑…\n`)

  const chat = await deps.createChat()
  const prompt = [
    '任务：为下列教学路径设计里程碑。',
    `学员原始档案（目标、范围和排除项优先）：${JSON.stringify(profile)}`,
    '',
    '教学路径（已按依赖排序，不得打乱）：',
    ...pathLines,
    '',
    `请输出里程碑 JSON（\`\`\`json 代码块），milestones 为 1-${Math.min(4, path.length)} 个，每个含 title（可验收的目标式描述）与 nodes（路径中知识点 id，遵循先后顺序，可只覆盖部分路径节点）。`,
    '里程碑标题只能要求它所属节点的技能，不能将下一课内容或课程排除项变成验收要求。',
  ].join('\n')
  const draft = await generateApproved<{ title: string; nodes: string[] }[]>(chat, prompt, (text) => {
    const data = parseJsonBlock(text)
    if (!data.ok) return data
    return validateMilestoneDraft(data.value, path)
  }, gate, value => planContent(assemblePlan(path, value, topoOrder(map)), profile, map))
  const milestones = draft as { title: string; nodes: string[] }[]
  const plan: Plan = assemblePlan(path, milestones, topoOrder(map))
  store.write(config.courseId, 'plan', plan)

  io.out(`\n教学计划已生成（${store.root}/${config.courseId}/plan.yaml）：\n`)
  io.out(`路径：${plan.path.join(' → ')}\n`)
  for (const milestone of plan.milestones) {
    io.out(`- ${milestone.id}：${milestone.title}（${milestone.nodes.join('、')}）\n`)
  }
  io.out(`当前指针：${plan.current ?? '（无）'}\n`)
  await chat.flush()
  printSessionTotal(chat, deps)
  io.closeInput()
  throw new FlowExit(0)
}
