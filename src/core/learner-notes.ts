// 学员观察记录：错因档案、自评校准、课堂反馈信号——都按课程落盘为一个小型 JSON。
// 写入端可重复安全追加（读取端去重/封顶），读取端容忍损坏：辅助数据永不阻塞教学。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { COURSE_ID_PATTERN } from './store.ts'

export const LEARNER_NOTES_FILE = 'learner-notes.json'
export const ERROR_CAP = 5
export const CALIBRATION_CAP = 5
export const STYLE_CAP = 5
export const CALIBRATION_BIAS_THRESHOLD = 15

export type ErrorKind = 'quiz' | 'review' | 'interleave' | 'exam'

export interface ErrorNote {
  question: string
  your: string
  answer: string
  at: string
  kind: ErrorKind
}

export interface CalibrationNote {
  at: string
  node: string
  predicted: number
  actual: number
}

export interface StyleNote {
  at: string
  kind: 'confused' | 'resolved'
  detail: string
}

export interface LearnerNotes {
  errors: Record<string, ErrorNote[]>
  calibration: CalibrationNote[]
  style: StyleNote[]
}

function emptyNotes(): LearnerNotes {
  return { errors: {}, calibration: [], style: [] }
}

export class LearnerNotesStore {
  readonly file: string

  constructor(root: string, courseId: string) {
    if (!COURSE_ID_PATTERN.test(courseId)) throw new Error('非法课程 id')
    this.file = path.join(path.resolve(root), courseId, LEARNER_NOTES_FILE)
  }

  read(): LearnerNotes {
    if (!fs.existsSync(this.file)) return emptyNotes()
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LearnerNotes
      return {
        errors: value?.errors && typeof value.errors === 'object' && !Array.isArray(value.errors) ? value.errors : {},
        calibration: Array.isArray(value?.calibration) ? value.calibration : [],
        style: Array.isArray(value?.style) ? value.style : [],
      }
    } catch {
      return emptyNotes()
    }
  }

  // 同一题同一错答只保留最新一条；每节点封顶，防止档案无限膨胀。
  recordErrors(node: string, items: { question: string; your: string; answer: string }[], at: string, kind: ErrorKind): void {
    if (items.length === 0) return
    const notes = this.read()
    const merged = [...(notes.errors[node] ?? [])]
    for (const item of items) {
      const index = merged.findIndex((entry) => entry.question === item.question && entry.your === item.your)
      if (index >= 0) merged.splice(index, 1)
      merged.push({ ...item, at, kind })
    }
    notes.errors[node] = merged.slice(-ERROR_CAP)
    this.save(notes)
  }

  recordCalibration(note: CalibrationNote): void {
    const notes = this.read()
    notes.calibration = [...notes.calibration, note].slice(-CALIBRATION_CAP)
    this.save(notes)
  }

  recordStyle(note: StyleNote): void {
    const notes = this.read()
    notes.style = [...notes.style, note].slice(-STYLE_CAP)
    this.save(notes)
  }

  errorsFor(nodes: string[], perNode = 2, total = 4): { node: string; question: string; your: string }[] {
    const notes = this.read()
    const picked: { node: string; question: string; your: string }[] = []
    for (const node of nodes) {
      for (const item of (notes.errors[node] ?? []).slice(-perNode)) {
        picked.push({ node, question: item.question, your: item.your })
        if (picked.length >= total) return picked
      }
    }
    return picked
  }

  latestCalibration(): CalibrationNote | undefined {
    return this.read().calibration.at(-1)
  }

  recentStyle(limit = 3): StyleNote[] {
    return this.read().style.slice(-limit)
  }

  private save(notes: LearnerNotes): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify(notes, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(temp, this.file)
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    }
  }
}

export function parseConfidence(raw: string | null | undefined): number | undefined {
  const text = (raw ?? '').trim()
  if (!/^\d{1,3}$/.test(text)) return undefined
  const value = Number(text)
  return value >= 0 && value <= 100 ? value : undefined
}

const CONFUSED = /(没听懂|听不懂|听不明白|不明白|没明白|看不懂|跟不上|太快|太抽象|一头雾水|没跟上)/
const RESOLVED = /(懂了|明白了|清楚了|理解了|原来如此|学会了|想通了)/

export function detectStyleSignal(text: string): { kind: StyleNote['kind']; detail: string } | undefined {
  const detail = text.trim().slice(0, 40)
  if (CONFUSED.test(text)) return { kind: 'confused', detail }
  if (RESOLVED.test(text)) return { kind: 'resolved', detail }
  return undefined
}

// 自评与实际差距达到阈值时给出校准提示；否则不打扰（判断留在这里，界面与 prompt 只消费结论）。
export function calibrationInsight(note: CalibrationNote | undefined): { note: CalibrationNote; bias: number } | undefined {
  if (!note) return undefined
  const bias = Math.round(note.predicted - note.actual * 100)
  return Math.abs(bias) >= CALIBRATION_BIAS_THRESHOLD ? { note, bias } : undefined
}
