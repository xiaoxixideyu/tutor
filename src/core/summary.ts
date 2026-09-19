import type { CourseStore } from './store.ts'
import { dueReviews, type DueReview } from './review.ts'
import type { KnowledgeMap, Mastery, Plan, Profile } from './schema.ts'
import type { MasteryStatusId } from './schema.ts'

export interface ProgressNode {
  id: string
  title?: string
  status: MasteryStatusId
  score?: number
  review_due?: string
}

export interface ProgressMilestone {
  id: string
  title: string
  nodes: string[]
  masteredCount: number
}

export interface CourseProgress {
  id: string
  goal?: string
  path: string[]
  current?: string
  nodes: ProgressNode[]
  counts: Record<MasteryStatusId, number>
  milestones: ProgressMilestone[]
  totalNodes: number
}

export interface CourseListItem {
  id: string
  goal: string
  current?: string
  mastered: number
  total: number
  dueCount?: number
}

export interface CourseReviewDue {
  id: string
  due: DueReview[]
  earliestDue?: string
}

const EMPTY_COUNTS: Record<MasteryStatusId, number> = { mastered: 0, learning: 0, weak: 0, unknown: 0 }

export function courseProgress(store: CourseStore, id: string): CourseProgress {
  if (!store.exists(id)) throw new Error(`课程 "${id}" 不存在`)
  const profile = store.has(id, 'profile') ? (store.read(id, 'profile') as Profile) : undefined
  const map = store.has(id, 'knowledge-map') ? (store.read(id, 'knowledge-map') as KnowledgeMap) : undefined
  const plan = store.has(id, 'plan') ? (store.read(id, 'plan') as Plan) : undefined
  const mastery = store.has(id, 'mastery') ? (store.read(id, 'mastery') as Mastery) : undefined
  const titles = new Map((map?.nodes ?? []).map((node) => [node.id, node.title]))

  const order: string[] = []
  const seen = new Set<string>()
  const push = (nodeId: string) => {
    if (!seen.has(nodeId)) {
      seen.add(nodeId)
      order.push(nodeId)
    }
  }
  for (const nodeId of map?.nodes.map((n) => n.id) ?? []) push(nodeId)
  for (const nodeId of plan?.path ?? []) push(nodeId)
  for (const nodeId of Object.keys(mastery ?? {})) push(nodeId)

  const nodes: ProgressNode[] = order.map((nodeId) => {
    const entry = mastery?.[nodeId]
    return {
      id: nodeId,
      ...(titles.has(nodeId) ? { title: titles.get(nodeId) } : {}),
      status: entry?.status ?? 'unknown',
      ...(entry?.score !== undefined ? { score: entry.score } : {}),
      ...(entry?.review_due !== undefined ? { review_due: entry.review_due } : {}),
    }
  })
  const counts = { ...EMPTY_COUNTS }
  for (const node of nodes) counts[node.status] += 1

  const milestones: ProgressMilestone[] = (plan?.milestones ?? []).map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    nodes: milestone.nodes,
    masteredCount: milestone.nodes.filter((nodeId) => mastery?.[nodeId]?.status === 'mastered').length,
  }))

  return {
    id,
    ...(profile?.goal !== undefined ? { goal: profile.goal } : {}),
    path: plan?.path ?? [],
    ...(plan?.current !== undefined ? { current: plan.current } : {}),
    nodes,
    counts,
    milestones,
    totalNodes: nodes.length,
  }
}

export function listCourseSummaries(store: CourseStore): CourseListItem[] {
  const today = new Date().toISOString().slice(0, 10)
  return store.list().map((id) => {
    const progress = courseProgress(store, id)
    const mastery = store.has(id, 'mastery') ? (store.read(id, 'mastery') as Mastery) : undefined
    const dueCount = mastery ? dueReviews(mastery, today).length : 0
    return {
      id,
      goal: progress.goal ?? '',
      ...(progress.current !== undefined ? { current: progress.current } : {}),
      mastered: progress.counts.mastered,
      total: progress.totalNodes,
      ...(dueCount > 0 ? { dueCount } : {}),
    }
  })
}

// 跨课程到期汇总：仅返回有到期项的课程，按 (earliestDue, id) 排序
export function listDueReviews(store: CourseStore, today: string): CourseReviewDue[] {
  const items: CourseReviewDue[] = []
  for (const id of store.list()) {
    const mastery = store.has(id, 'mastery') ? (store.read(id, 'mastery') as Mastery) : undefined
    if (!mastery) continue
    const due = dueReviews(mastery, today)
    if (due.length === 0) continue
    items.push({ id, due, earliestDue: due[0].review_due })
  }
  return items.sort(
    (a, b) => (a.earliestDue ?? '').localeCompare(b.earliestDue ?? '') || a.id.localeCompare(b.id)
  )
}
