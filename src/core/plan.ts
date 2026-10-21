import { topoOrder } from './knowledge.ts'
import type { KnowledgeMap, LearnerProfile, Mastery, Plan } from './schema.ts'

export const MASTERED_SCORE_THRESHOLD = 0.8

export function masteredFromMastery(mastery: Mastery): Set<string> {
  const mastered = new Set<string>()
  for (const [node, entry] of Object.entries(mastery)) {
    if (entry.status === 'mastered') mastered.add(node)
  }
  return mastered
}

export function masteredFromProfile(profile: LearnerProfile): Set<string> {
  const mastered = new Set<string>()
  for (const [node, entry] of Object.entries(profile.nodes)) {
    if (entry.score >= MASTERED_SCORE_THRESHOLD) mastered.add(node)
  }
  return mastered
}

export function buildPlanPath(map: KnowledgeMap, mastered: Set<string>): string[] {
  return topoOrder(map).filter((node) => !mastered.has(node))
}

// path 是规划时的待学路径，scope 是课程完整范围。旧计划从知识地图恢复范围，
// 不能因节点曾经 mastered 就永远把它排除在补救课之外。
export function courseNodeOrder(plan: Plan, map?: KnowledgeMap): string[] {
  // PlanSchema 会把缺失的 scope 补成 []；空数组不能当作“显式空范围”，
  // 否则旧计划（scope 字段出现之前的格式）会丢掉已掌握而跳过的节点。
  const scope = plan.scope && plan.scope.length > 0 ? plan.scope : (map ? topoOrder(map) : plan.path)
  const nodes = [...scope, ...plan.path]
  const ordered = nodes.length > 0 ? nodes : typeof plan.current === 'string' && plan.current !== '' ? [plan.current] : []
  return [...new Set(ordered)]
}

export interface PlanMapMismatch {
  missingFromMap: string[]
  notInPlan: string[]
}

// 计划是地图在规划时的快照。地图增删节点后必须先重新规划：
// 否则新节点永远不会被教到，已删除节点又会被 currentNode 选中并在内容审查处报晦涩错误。
export function planMapMismatch(plan: Plan, map: KnowledgeMap): PlanMapMismatch | null {
  const mapIds = map.nodes.map((node) => node.id)
  const mapSet = new Set(mapIds)
  const referenced = [...new Set([
    ...(plan.scope ?? []),
    ...plan.path,
    ...plan.milestones.flatMap((milestone) => milestone.nodes),
    // 完成全部知识点后 current 可能因历史数据为 null；它不是一个可引用的节点。
    ...(typeof plan.current === 'string' && plan.current !== '' ? [plan.current] : []),
  ])]
  const missingFromMap = referenced.filter((id) => !mapSet.has(id))
  // 与 courseNodeOrder 保持一致：缺失或空的 scope 都按旧格式回退到完整地图。
  const covered = plan.scope !== undefined && plan.scope.length > 0
    ? new Set([...plan.scope, ...plan.path])
    : new Set(mapIds)
  const notInPlan = mapIds.filter((id) => !covered.has(id))
  return missingFromMap.length > 0 || notInPlan.length > 0 ? { missingFromMap, notInPlan } : null
}

export function planMapMismatchText(mismatch: PlanMapMismatch): string {
  const parts: string[] = []
  if (mismatch.missingFromMap.length > 0) parts.push(`计划中的节点不在知识地图：${mismatch.missingFromMap.join('、')}`)
  if (mismatch.notInPlan.length > 0) parts.push(`知识地图中的节点未纳入计划：${mismatch.notInPlan.join('、')}`)
  return parts.join('；')
}

export interface MilestoneDraft {
  title: unknown
  nodes: unknown
}

// 大考试卷最多 10 题且每个里程碑知识点至少要有一题，里程碑节点数必须落在试卷容量内。
export const MAX_MILESTONE_NODES = 10

export function validateMilestoneDraft(draft: unknown, path: string[]): { ok: true; value: { title: string; nodes: string[] }[] } | { ok: false; error: string } {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    return { ok: false, error: 'JSON 根必须是对象，含 milestones 数组' }
  }
  const raw = (draft as { milestones?: unknown }).milestones
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'milestones 必须是非空数组' }
  }
  if (raw.length > 6) {
    return { ok: false, error: `milestones 数量过多（${raw.length} > 6）` }
  }
  const pathIndex = new Map(path.map((node, index) => [node, index]))
  const seen = new Map<string, number>()
  const milestones: { title: string; nodes: string[] }[] = []
  let previousPosition = -1
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: `milestones[${index}] 不是对象` }
    }
    const { title, nodes } = item as Record<string, unknown>
    if (typeof title !== 'string' || title.trim() === '') {
      return { ok: false, error: `milestones[${index}].title 缺失或为空` }
    }
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return { ok: false, error: `milestones[${index}].nodes 必须是非空数组` }
    }
    const milestoneNodes: string[] = []
    for (const node of nodes) {
      if (typeof node !== 'string') {
        return { ok: false, error: `milestones[${index}].nodes 含非字符串项` }
      }
      const position = pathIndex.get(node)
      if (position === undefined) {
        return { ok: false, error: `milestones[${index}] 的节点 "${node}" 不在教学路径中` }
      }
      if (seen.has(node)) {
        return { ok: false, error: `节点 "${node}" 出现在多个里程碑中` }
      }
      if (position < previousPosition) {
        return { ok: false, error: `milestones[${index}] 的节点 "${node}" 打乱了路径顺序` }
      }
      previousPosition = position
      seen.set(node, index)
      milestoneNodes.push(node)
    }
    if (milestoneNodes.length > MAX_MILESTONE_NODES) {
      return { ok: false, error: `milestones[${index}] 覆盖 ${milestoneNodes.length} 个知识点，超过单次大考上限 ${MAX_MILESTONE_NODES}；请拆成多个里程碑` }
    }
    milestones.push({ title: title.trim(), nodes: milestoneNodes })
  }
  return { ok: true, value: milestones }
}

export function assemblePlan(path: string[], milestones: { title: string; nodes: string[] }[], scope?: string[]): Plan {
  return {
    path,
    ...(scope ? { scope: [...scope] } : {}),
    milestones: milestones.map((milestone, index) => ({
      id: `m${index + 1}`,
      title: milestone.title,
      nodes: milestone.nodes,
    })),
    ...(path.length > 0 ? { current: path[0] } : {}),
  }
}
