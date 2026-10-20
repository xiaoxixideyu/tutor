import type { CourseStore } from './store.ts'
import { localDate } from './dates.ts'
import { dueReviews, type DueReview } from './review.ts'
import { currentNode } from './lesson.ts'
import type { KnowledgeMap, Mastery, Plan, PracticeTaskFile, Profile, QuestionBank } from './schema.ts'
import type { MasteryStatusId } from './schema.ts'
import { ResearchProgressStore } from './research.ts'
import { QualityStore } from './quality-store.ts'
import { memoryCard } from './scheduler.ts'
import { mapContent, bankContent, planContent, type ContentInput } from './content-quality.ts'

export interface ProgressNode {
  id: string
  title?: string
  status: MasteryStatusId
  score?: number
  review_due?: string
  // 今日记忆保留率估计（仅在存有实测锚点时给出）：看板据此提示"可能已生锈"。
  retention?: number
  // 该节点的已收录资料条数：与 researchStatus 一起判断"已保存但一条来源都没有"的节点。
  researchResources?: number
  practiceCount: number
  researchStatus?: 'pending' | 'saved' | 'verified'
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
  // 已有知识地图是否通过独立内容审查。false = 地图在，但准入未过——上课/教研会在门前退出，需先修复重审。
  // 仅反映地图这一主闸；个别节点题库/教案的准入另算（看板给总体提示，不逐节点判定）。
  contentReady: boolean
  research?: { completed: number; verified: number; pending: number; total: number }
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
  // 见 CourseProgress.contentReady：地图准入未过时看板提示"内容待重新审查"，不甩会 dead-end 的入口。
  contentReady: boolean
  // 单门课程状态文件损坏时的可读错误；列表仍返回其他课程，不因一门坏数据整体失败。
  error?: string
}

export interface CourseReviewDue {
  id: string
  due: DueReview[]
  earliestDue?: string
}

const EMPTY_COUNTS: Record<MasteryStatusId, number> = { mastered: 0, learning: 0, weak: 0, unknown: 0 }

export function courseProgress(store: CourseStore, id: string, today = localDate()): CourseProgress {
  if (!store.exists(id)) throw new Error(`课程 "${id}" 不存在`)
  const profile = store.has(id, 'profile') ? (store.read(id, 'profile') as Profile) : undefined
  const map = store.has(id, 'knowledge-map') ? (store.read(id, 'knowledge-map') as KnowledgeMap) : undefined
  const plan = store.has(id, 'plan') ? (store.read(id, 'plan') as Plan) : undefined
  const mastery = store.has(id, 'mastery') ? (store.read(id, 'mastery') as Mastery) : undefined
  const practice = store.has(id, 'practice') ? (store.read(id, 'practice') as PracticeTaskFile) : undefined
  const titles = new Map((map?.nodes ?? []).map((node) => [node.id, node.title]))
  const research = new ResearchProgressStore(store.root, id)

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

  const researchStatuses = map && profile ? research.statuses(map, profile, map.nodes.map(node => node.id)) : {}

  const nodes: ProgressNode[] = order.map((nodeId) => {
    const entry = mastery?.[nodeId]
    const mapNode = map?.nodes.find(node => node.id === nodeId)
    const researchStatus = mapNode && map && profile ? researchStatuses[nodeId] : undefined
    const card = entry ? memoryCard(entry, today) : undefined
    return {
      id: nodeId,
      ...(titles.has(nodeId) ? { title: titles.get(nodeId) } : {}),
      status: entry?.status ?? 'unknown',
      practiceCount: practice?.tasks.filter((task) => task.node === nodeId).length ?? 0,
      ...(researchStatus ? { researchStatus } : {}),
      ...(researchStatus ? { researchResources: (map?.resources ?? []).filter(resource => resource.node === nodeId).length } : {}),
      ...(entry?.score !== undefined ? { score: entry.score } : {}),
      ...(entry?.review_due !== undefined ? { review_due: entry.review_due } : {}),
      ...(card !== undefined ? { retention: card.retention } : {}),
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

  // 地图主闸准入：地图在但未过审 → 上课/教研会在门前退出，看板据此提示而非甩死路入口。
  // 查准入出任何意外都按"就绪"处理：宁可不提示也不误报，更不能拖垮看板。
  let contentReady = true
  try {
    if (map && profile) contentReady = new QualityStore(store.root, id).approved(mapContent(map, profile))
  } catch { contentReady = true }

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
    contentReady,
    ...(map ? { research: {
      completed: nodes.filter(node => node.researchStatus === 'saved' || node.researchStatus === 'verified').length,
      verified: nodes.filter(node => node.researchStatus === 'verified').length,
      pending: nodes.filter(node => node.researchStatus === 'pending').length, total: map.nodes.length,
    } } : {}),
  }
}

export function listCourseSummaries(store: CourseStore, today = localDate()): CourseListItem[] {
  return store.list().map((id) => {
    try {
      const progress = courseProgress(store, id, today)
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
        contentReady: progress.contentReady,
      }
    } catch (error) {
      // 一门课的损坏数据不能拖垮整个课程列表；UI 依据 error 显示修复提示。
      return {
        id,
        goal: '（课程数据无法读取）',
        mastered: 0,
        total: 0,
        stage: 'need-assess',
        contentReady: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

// 跨课程到期汇总：仅返回有到期项的课程，按 (earliestDue, id) 排序
// 当前课程里未通过内容审查的条目及具体问题（给 UI 显示"哪条没过"，而不是只甩证据文件路径）。
// 按当前内容快照判定：修复后内容键会变、旧的被拒记录自然失配，不会误报已修好的内容。
export function courseContentIssues(store: CourseStore, id: string): { kind: string; node?: string; issues: string[] }[] {
  if (!store.exists(id)) return []
  const profile = store.has(id, 'profile') ? (store.read(id, 'profile') as Profile) : undefined
  const map = store.has(id, 'knowledge-map') ? (store.read(id, 'knowledge-map') as KnowledgeMap) : undefined
  if (!profile || !map) return []
  const plan = store.has(id, 'plan') ? (store.read(id, 'plan') as Plan) : undefined
  const bank = store.has(id, 'question-bank') ? (store.read(id, 'question-bank') as QuestionBank) : undefined
  const inputs: ContentInput[] = [mapContent(map, profile)]
  if (plan) inputs.push(planContent(plan, profile, map))
  if (bank) for (const node of map.nodes) if (bank[node.id]?.length) inputs.push(bankContent(bank, node.id, profile, map))
  try { return new QualityStore(store.root, id).issuesFor(inputs) } catch { return [] }
}

export function listDueReviews(store: CourseStore, today: string): CourseReviewDue[] {
  const items: CourseReviewDue[] = []
  for (const id of store.list()) {
    try {
      const mastery = store.has(id, 'mastery') ? (store.read(id, 'mastery') as Mastery) : undefined
      if (!mastery) continue
      const due = dueReviews(mastery, today)
      if (due.length === 0) continue
      items.push({ id, due, earliestDue: due[0].review_due })
    } catch {
      // 单门课程状态损坏时跳过它，跨课程复习汇总不能被一门坏课程打断。
      continue
    }
  }
  return items.sort(
    (a, b) => (a.earliestDue ?? '').localeCompare(b.earliestDue ?? '') || a.id.localeCompare(b.id)
  )
}
