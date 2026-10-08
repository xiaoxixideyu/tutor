import type { CourseStore } from './store.ts'
import { dueReviews, type DueReview } from './review.ts'
import { currentNode } from './lesson.ts'
import type { KnowledgeMap, Mastery, Plan, PracticeTaskFile, Profile } from './schema.ts'
import type { MasteryStatusId } from './schema.ts'

export interface ProgressNode {
  id: string
  title?: string
  status: MasteryStatusId
  score?: number
  review_due?: string
  practiceCount: number
}

export interface ProgressMilestone {
  id: string
  title: string
  nodes: string[]
  masteredCount: number
  // 大考状态：examPassed=已通过（不再提示考）；examable=全部节点已掌握且未通过（可参加大考）。
  examPassed: boolean
  examable: boolean
  examScore?: number
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
  // 是否已生成实践任务（practice.yaml 存在）——决定看板给「去实践」还是「生成实践任务」入口。
  hasPractice: boolean
  hasPlan: boolean
}

// 课程阶段：决定看板上该课的下一步入口，避免把「只建档没计划」的半成品课丢进课堂死路。
//   need-assess：摸底未完成（教研生成地图不代表已摸底）→ 去摸底或续测
//   need-plan：已有能力画像但没教学计划 → 去生成计划
//   ready：有计划，可上课
export type CourseStage = 'need-assess' | 'need-plan' | 'ready'

export interface CourseListItem {
  id: string
  goal: string
  current?: string
  mastered: number
  total: number
  dueCount?: number
  stage: CourseStage
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
  const practice = store.has(id, 'practice') ? (store.read(id, 'practice') as PracticeTaskFile) : undefined
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
      practiceCount: practice?.tasks.filter((task) => task.node === nodeId).length ?? 0,
      ...(entry?.score !== undefined ? { score: entry.score } : {}),
      ...(entry?.review_due !== undefined ? { review_due: entry.review_due } : {}),
    }
  })
  const counts = { ...EMPTY_COUNTS }
  for (const node of nodes) counts[node.status] += 1

  const milestones: ProgressMilestone[] = (plan?.milestones ?? []).map((milestone) => {
    const masteredCount = milestone.nodes.filter((nodeId) => mastery?.[nodeId]?.status === 'mastered').length
    const examPassed = milestone.exam_passed === true
    return {
      id: milestone.id,
      title: milestone.title,
      nodes: milestone.nodes,
      masteredCount,
      examPassed,
      // 可考 = 未通过 且 有节点且全部已掌握（与 exam.ts#nextMilestone 的判定一致）
      examable: !examPassed && milestone.nodes.length > 0 && masteredCount === milestone.nodes.length,
      ...(milestone.exam_score !== undefined ? { examScore: milestone.exam_score } : {}),
    }
  })

  return {
    id,
    ...(profile?.goal !== undefined ? { goal: profile.goal } : {}),
    path: plan?.path ?? [],
    ...(plan && currentNode(plan, mastery, map) ? { current: currentNode(plan, mastery, map)! } : {}),
    nodes,
    counts,
    milestones,
    totalNodes: nodes.length,
    hasPractice: store.has(id, 'practice'),
    hasPlan: !!plan,
  }
}

export function listCourseSummaries(store: CourseStore, today = new Date().toISOString().slice(0, 10)): CourseListItem[] {
  return store.list().map((id) => {
    const progress = courseProgress(store, id)
    const mastery = store.has(id, 'mastery') ? (store.read(id, 'mastery') as Mastery) : undefined
    const dueCount = mastery ? dueReviews(mastery, today).length : 0
    const stage: CourseStage = store.has(id, 'assessment')
      ? 'need-assess'
      : store.has(id, 'plan')
      ? 'ready'
      : store.has(id, 'knowledge-map') && store.has(id, 'learner-profile')
        ? 'need-plan'
        : 'need-assess'
    return {
      id,
      goal: progress.goal ?? '',
      ...(progress.current !== undefined ? { current: progress.current } : {}),
      mastered: progress.counts.mastered,
      total: progress.totalNodes,
      ...(dueCount > 0 ? { dueCount } : {}),
      stage,
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
