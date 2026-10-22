// FSRS-lite 记忆调度：纯函数、零模型成本、可复算。
// 参考 FSRS（Free Spaced Repetition Scheduler）的 DSR 思想，简化为单一记忆稳定性 S：
//   R(t) = 0.9^(t/S)：距上次成功提取 t 天后，可提取性的估计；S 即保留率降到 90% 所需天数。
//   lapses：复习失败累计次数。
// 时间只用于预测与调度（何时复习、是否提示热身），状态升降仍由实测结果决定。

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy'

export const TARGET_RETENTION = 0.9
export const MIN_STABILITY = 1
export const MAX_STABILITY = 365
export const INITIAL_STABILITY = 1.5
export const FAIL_DECAY = 0.3
export const RETRY_INTERVAL_DAYS = 1
export const OVERDUE_BONUS_PER_UNIT = 0.3
export const OVERDUE_BONUS_MAX = 0.6
// 低于该保留率的前置节点在开课前建议先做回忆热身。
export const WARMUP_RETENTION_THRESHOLD = 0.85

export const REVIEW_GRADE_MULTIPLIERS = { hard: 1.4, good: 1.8, easy: 2.4 } as const

// 旧数据（无 stability）按 review_stage 迁移，与旧阶梯 1/3/7/14 天对齐。
export const STAGE_STABILITY: Record<number, number> = { 1: 1, 2: 3, 3: 7, 4: 14 }

export interface MemoryCard {
  elapsedDays: number
  stability: number
  retention: number
}

export interface StabilityCarrier {
  stability?: number
  review_stage?: number
  last_touched_at?: string
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.round((end - start) / 86_400_000)
}

export function gradeForScore(score: number): ReviewGrade {
  if (score < 0.5) return 'again'
  if (score < 0.75) return 'hard'
  if (score < 1) return 'good'
  return 'easy'
}

export function retrievability(elapsedDays: number, stability: number): number {
  if (!(stability > 0)) return 0
  if (elapsedDays <= 0) return 1
  return Math.round(0.9 ** (elapsedDays / stability) * 1000) / 1000
}

export function stabilityOf(entry: StabilityCarrier | undefined): number | undefined {
  if (!entry) return undefined
  if (entry.stability !== undefined) return entry.stability
  if (entry.review_stage !== undefined) return STAGE_STABILITY[entry.review_stage]
  return undefined
}

// 按目标保留率反推复习间隔；target 0.9 时间隔即 stability 本身。
export function intervalDays(stability: number, targetRetention: number = TARGET_RETENTION): number {
  const raw = stability * Math.log(targetRetention) / Math.log(0.9)
  return Math.max(1, Math.min(MAX_STABILITY, Math.round(raw)))
}

function clampStability(value: number): number {
  return Math.round(Math.min(MAX_STABILITY, Math.max(MIN_STABILITY, value)) * 100) / 100
}

// 逾期后成功回忆是更强的编码信号：超出 stability 的逾期越久奖励越大（封顶）。
// 间隔扩张必须来自时间流逝：当天重复答对（考试未过 → 重学重测）不能按"已巩固"把间隔放大，
// 否则连考几次满分就能把稳定性顶到上限、把复习推到一年之后（实测同日 6 次满分即 stability 365）。
export function nextStability(previous: number | undefined, grade: ReviewGrade, elapsedDays?: number): number {
  if (grade === 'again') return clampStability((previous ?? INITIAL_STABILITY) * FAIL_DECAY)
  const base = (previous ?? INITIAL_STABILITY) * REVIEW_GRADE_MULTIPLIERS[grade]
  if (previous === undefined || previous <= 0 || elapsedDays === undefined) return clampStability(base)
  // 已流逝的时间占上一轮间隔的比例：提前或当天复习只按这个比例给扩张，逾期不再另算（下面单独加成）。
  const spacing = Math.min(1, Math.max(0, elapsedDays) / Math.max(1, previous))
  const growth = 1 + (REVIEW_GRADE_MULTIPLIERS[grade] - 1) * spacing
  const overdue = elapsedDays / previous
  const bonus = 1 + Math.min(OVERDUE_BONUS_MAX, Math.max(0, overdue - 1) * OVERDUE_BONUS_PER_UNIT)
  return clampStability(previous * growth * bonus)
}

// 记忆状态卡：仅在存有实测锚点（last_touched_at）与稳定性时可得；旧数据返回 undefined，不猜。
export function memoryCard(entry: StabilityCarrier | undefined, today: string): MemoryCard | undefined {
  const stability = stabilityOf(entry)
  if (stability === undefined || entry?.last_touched_at === undefined) return undefined
  const elapsedDays = Math.max(0, daysBetween(entry.last_touched_at, today))
  return { elapsedDays, stability, retention: retrievability(elapsedDays, stability) }
}

export function retentionEstimate(entry: StabilityCarrier | undefined, today: string): number | undefined {
  return memoryCard(entry, today)?.retention
}
