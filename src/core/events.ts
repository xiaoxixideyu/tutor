// 课程学习事件流（append-only JSONL）：YAML 是现状视图，事件流是学习曲线的数据底座。
// 写入端允许重复追加（例如考试提交重试），读取端按 key 去重（保留首次出现），单行损坏不拖垮曲线。
import fs from 'node:fs'
import path from 'node:path'
import { COURSE_ID_PATTERN } from './store.ts'
import { addDays, daysBetween } from './scheduler.ts'

export type MasteryEventKind = 'quiz' | 'interleave' | 'review' | 'practice' | 'exam' | 'warmup'

export interface MasteryEvent {
  key: string
  at: string
  node: string
  kind: MasteryEventKind
  score?: number
  passed?: boolean
}

export const MASTERY_EVENTS_FILE = 'mastery-events.jsonl'

const KINDS = new Set<string>(['quiz', 'interleave', 'review', 'practice', 'exam', 'warmup'])

export function masteryEventsFile(root: string, courseId: string): string {
  if (!COURSE_ID_PATTERN.test(courseId)) throw new Error('非法课程 id')
  return path.join(path.resolve(root), courseId, MASTERY_EVENTS_FILE)
}

export function validMasteryEvent(value: unknown): value is MasteryEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  return typeof event.key === 'string' && event.key !== ''
    && typeof event.at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.at)
    && typeof event.node === 'string' && event.node !== ''
    && typeof event.kind === 'string' && KINDS.has(event.kind)
    && (event.score === undefined || (typeof event.score === 'number' && event.score >= 0 && event.score <= 1))
    && (event.passed === undefined || typeof event.passed === 'boolean')
}

export function appendMasteryEvent(root: string, courseId: string, event: MasteryEvent): void {
  const file = masteryEventsFile(root, courseId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(event) + '\n')
}

export function readMasteryEvents(root: string, courseId: string): MasteryEvent[] {
  const file = masteryEventsFile(root, courseId)
  if (!fs.existsSync(file)) return []
  const seen = new Set<string>()
  const events: MasteryEvent[] = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (!validMasteryEvent(value) || seen.has(value.key)) continue
      seen.add(value.key)
      events.push(value)
    } catch { /* 单行损坏不拖垮曲线 */ }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at) || a.node.localeCompare(b.node))
}

export interface DailyActivity {
  date: string
  count: number
  kinds: Partial<Record<MasteryEventKind, number>>
}

// 最近 days 天（含今天）的逐日活动量；没有活动的日子补零，供曲线直接画柱。
export function dailyActivity(events: MasteryEvent[], days: number, today: string): DailyActivity[] {
  const start = addDays(today, -(days - 1))
  const byDate = new Map<string, DailyActivity>()
  for (let index = 0; index < days; index++) {
    const date = addDays(start, index)
    byDate.set(date, { date, count: 0, kinds: {} })
  }
  for (const event of events) {
    const entry = byDate.get(event.at)
    if (!entry) continue
    entry.count += 1
    entry.kinds[event.kind] = (entry.kinds[event.kind] ?? 0) + 1
  }
  return [...byDate.values()]
}

// 学习节奏：活跃天数与平均间隔（天）。
export function learningPace(events: MasteryEvent[], days: number, today: string): { sessions: number; averageGapDays?: number } {
  const start = addDays(today, -(days - 1))
  const dates = [...new Set(events.filter((event) => event.at >= start && event.at <= today).map((event) => event.at))].sort()
  if (dates.length < 2) return { sessions: dates.length }
  let total = 0
  for (let index = 1; index < dates.length; index++) total += daysBetween(dates[index - 1], dates[index])
  return { sessions: dates.length, averageGapDays: Math.round((total / (dates.length - 1)) * 10) / 10 }
}

// 每节点最近 limit 条成绩轨迹（按时间正序），只收录有实测成绩的事件。
export function nodeTrails(events: MasteryEvent[], limit = 8): { node: string; points: MasteryEvent[] }[] {
  const byNode = new Map<string, MasteryEvent[]>()
  for (const event of events) {
    if (event.score === undefined) continue
    if (!byNode.has(event.node)) byNode.set(event.node, [])
    byNode.get(event.node)!.push(event)
  }
  return [...byNode.entries()]
    .map(([node, points]) => ({ node, points: points.slice(-limit) }))
    .sort((a, b) => a.node.localeCompare(b.node))
}
