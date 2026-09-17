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

export interface MilestoneDraft {
  title: unknown
  nodes: unknown
}

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
    milestones.push({ title: title.trim(), nodes: milestoneNodes })
  }
  return { ok: true, value: milestones }
}

export function assemblePlan(path: string[], milestones: { title: string; nodes: string[] }[]): Plan {
  return {
    path,
    milestones: milestones.map((milestone, index) => ({
      id: `m${index + 1}`,
      title: milestone.title,
      nodes: milestone.nodes,
    })),
    ...(path.length > 0 ? { current: path[0] } : {}),
  }
}
