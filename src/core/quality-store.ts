import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { COURSE_ID_PATTERN } from './store.ts'
import type { UsageSample } from './cost.ts'
import { bankContent, blindQuestions, contentIssues, contentKey, factProbes, parseBlindSolutions, parseContentReview, parseFactChecks, practiceContent, QUALITY_POLICY,
  validateContentInput, type BlindSolution, type ContentInput, type ContentReview, type FactCheck } from './content-quality.ts'
import type { DocKind, KnowledgeMap, PracticeTaskFile, Profile, QuestionBank } from './schema.ts'

export interface QualityCall {
  role: 'solver' | 'reviewer' | 'facts'
  sessionId?: string
  model?: string
  prompt: string
  reply?: string
  error?: string
  usage: UsageSample
}
export interface QualityRecord {
  id: string
  key: string
  policy: string
  status: 'pending' | 'approved' | 'rejected' | 'error'
  input: ContentInput
  startedAt: string
  completedAt?: string
  calls: QualityCall[]
  solutions?: BlindSolution[]
  review?: ContentReview
  facts?: FactCheck[]
  issues?: string[]
  error?: string
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(tmp, file) }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
}

export class QualityStore {
  readonly directory: string
  constructor(root: string, courseId: string) {
    if (!COURSE_ID_PATTERN.test(courseId)) throw new Error('非法课程 id')
    this.directory = path.join(path.resolve(root), courseId, 'quality')
  }
  evidenceFile(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('非法审查记录 id')
    return path.join(this.directory, 'reviews', `${id}.json`)
  }
  save(record: QualityRecord): void {
    atomicJson(this.evidenceFile(record.id), record)
    if (record.status === 'approved') {
      // 即使调用方误设 status，也不能为不完整或未通过的记录签发准入缓存。
      if (!this.validApproval(record, record.input)) throw new Error('不能保存无效的准入记录')
      atomicJson(path.join(this.directory, 'approved', `${record.key}.json`), record)
    }
  }
  approved(input: ContentInput): boolean {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(this.directory, 'approved', `${contentKey(input)}.json`), 'utf8')) as QualityRecord
      return this.validApproval(record, input)
    } catch { return false }
  }
  private validApproval(record: QualityRecord, input: ContentInput): boolean {
    try {
      validateContentInput(input)
      if (record.status !== 'approved' || record.policy !== QUALITY_POLICY || record.key !== contentKey(input) || contentKey(record.input) !== record.key) return false
      const solver = record.calls.filter(c => c.role === 'solver')
      const reviewers = record.calls.filter(c => c.role === 'reviewer')
      if (!reviewers.length || record.calls.some(call => !call.sessionId || call.error) || new Set(record.calls.map(call => call.sessionId)).size !== record.calls.length) return false
      if (blindQuestions(input).length && !solver.length) return false
      if (factProbes(input).length && !record.calls.some(call => call.role === 'facts')) return false
      const solutions = parseBlindSolutions({ solutions: record.solutions }, input)
      const facts = parseFactChecks({ claims: record.facts }, factProbes(input).map(fact => fact.id))
      const review = parseContentReview(record.review, input)
      return contentIssues(input, solutions, review, facts).length === 0
    } catch { return false }
  }
  require(input: ContentInput, command: string): void {
    if (!this.approved(input)) throw new Error(`内容尚未通过审查或已发生变化，请先运行 ${command}`)
  }
}

interface SavedStore { root: string; read(id: string, kind: DocKind): unknown }
export function requireReviewedBank(store: SavedStore, id: string, bank: QuestionBank, node: string): void {
  const profile = store.read(id, 'profile') as Profile
  const map = store.read(id, 'knowledge-map') as KnowledgeMap
  new QualityStore(store.root, id).require(bankContent(bank, node, profile, map), `npm run agent -- audit-content ${id}`)
}
export function requireReviewedPractice(store: SavedStore, id: string, file: PracticeTaskFile, node: string): void {
  const profile = store.read(id, 'profile') as Profile
  const map = store.read(id, 'knowledge-map') as KnowledgeMap
  new QualityStore(store.root, id).require(practiceContent(file.tasks.filter(t => t.node === node), node, profile, map), `npm run agent -- audit-content ${id}`)
}
