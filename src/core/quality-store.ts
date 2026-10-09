import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { COURSE_ID_PATTERN } from './store.ts'
import type { UsageSample } from './cost.ts'
import { bankContent, blindQuestions, canonicalJson, contentIssues, contentKey, factProbes, MAP_REVIEW_CONTRACT, MAP_NODE_REVIEW_CONTRACT, MAP_OUTLINE_REVIEW_CONTRACT, MAP_RESOURCE_REVIEW_CONTRACT, mapReviewContext, mapTeachingTime, parseBlindSolutions, parseContentReview, parseFactChecks, practiceContent, QUALITY_POLICY, requiredAssertions,
  validateContentInput, type ApprovedTeachingTurn, type BlindSolution, type ContentInput, type ContentReview, type FactCheck } from './content-quality.ts'
import type { DocKind, KnowledgeMap, PracticeTaskFile, Profile, QuestionBank } from './schema.ts'

export interface QualityCall {
  role: 'solver' | 'reviewer' | 'facts'
  sessionId?: string
  model?: string
  prompt: string
  reply?: string
  error?: string
  usage: UsageSample
  startedAt?: string
  elapsedMs?: number
  splitAfterError?: boolean
  reusedFrom?: string
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
  resumedFrom?: string
}

export interface PublishedTurn {
  sessionId: string
  seq: number
  node: string
  reply: string
  qualityKey: string
  publishedAt: string
}

export interface GeneratedCandidate {
  reply: string
  inputKey: string
  status: 'pending' | 'rejected' | 'review-limit'
  issues?: string[]
}

interface ApprovalCheck { visiting: Set<string>; results: Map<string, boolean> }

// 仅地图允许跨版本复用：范围、完整课时骨架或单元中的任一字段变更都会使相应请求失配。
function mapCallMatches(call: QualityCall, input: ContentInput): boolean {
  try {
    if (input.kind !== 'map') return false
    const request = JSON.parse(call.prompt)
    if (call.role === 'facts') {
      const expected = new Map(factProbes(input).map(claim => [claim.id, canonicalJson(claim)]))
      return Array.isArray(request.claims) && request.claims.length > 0
        && new Set(request.claims.map((claim: { id: string }) => claim.id)).size === request.claims.length
        && request.claims.every((claim: { id: string }) => expected.get(claim.id) === canonicalJson(claim))
    }
    if (call.role !== 'reviewer' || request.dataContract !== MAP_REVIEW_CONTRACT || request.content?.kind !== 'map') return false
    const units = request.content.units as ContentInput['units']
    return Array.isArray(units) && units.length > 0 && new Set(units.map(unit => unit.id)).size === units.length
      && units.every(unit => input.units.some(current => current.id === unit.id && canonicalJson(current) === canonicalJson(unit)))
      && canonicalJson(request.content.context) === canonicalJson(mapReviewContext(input, units))
      && request.outlineScopeContract === (units.some(unit => unit.id === 'outline') ? MAP_OUTLINE_REVIEW_CONTRACT : undefined)
      && canonicalJson(request.teachingTime) === canonicalJson(units.some(unit => unit.id === 'outline') ? mapTeachingTime(input) : undefined)
      && request.nodeScopeContract === (units.some(unit => unit.id.startsWith('node:')) ? MAP_NODE_REVIEW_CONTRACT : undefined)
      && request.resourceScopeContract === (units.some(unit => unit.id.startsWith('resource:')) ? MAP_RESOURCE_REVIEW_CONTRACT : undefined)
      && canonicalJson(request.requiredAssertions) === canonicalJson(units.map(unit => ({ unitId: unit.id, assertions: requiredAssertions(input, unit) })))
  } catch { return false }
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
  private records(): QualityRecord[] {
    const dir = path.join(this.directory, 'reviews')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).flatMap(file => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as QualityRecord
        return record.input && Array.isArray(record.calls) && typeof record.startedAt === 'string' ? [record] : []
      } catch { return [] }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }
  history(input: ContentInput): QualityRecord[] {
    const key = contentKey(input)
    return this.records().filter(record => record.policy === QUALITY_POLICY && record.key === key && contentKey(record.input) === key)
  }
  reviewContextCurrent(record: QualityRecord, input: ContentInput): boolean {
    // 内容摘要相同也不代表审查上下文相同。旧版空节点清单的结论只能留作历史证据。
    return input.kind !== 'map' || record.calls.filter(call => !call.error).every(call => mapCallMatches(call, input))
  }
  mapReuseHistory(input: ContentInput): QualityRecord[] {
    if (input.kind !== 'map') return []
    const key = contentKey(input)
    return this.records().filter(record => record.policy === QUALITY_POLICY && record.status === 'approved'
      && record.input.kind === 'map' && record.key !== key && record.key === contentKey(record.input)
      && canonicalJson(record.input.context) === canonicalJson(input.context))
  }
  unfinishedTeaching(node: string, reply: string, previousReply: string): ApprovedTeachingTurn | undefined {
    for (const record of this.records()) {
      if (!['pending', 'error', 'approved'].includes(record.status) || record.input.kind !== 'teaching') continue
      const unit = record.input.units?.[0]
      const turn = unit?.content as ApprovedTeachingTurn | undefined
      // 只恢复曾完整生成并交给准入的文本；未知或截断的日志尾部没有这份证据。
      if (unit?.node === node && turn?.reply === reply && turn.previousReply === previousReply && typeof turn.learnerMessage === 'string') return turn
    }
    return undefined
  }
  reusable(call: QualityCall, input: ContentInput, check: ApprovalCheck = { visiting: new Set(), results: new Map() }): boolean {
    if (!call.reusedFrom) return true
    try {
      const original = JSON.parse(fs.readFileSync(this.evidenceFile(call.reusedFrom), 'utf8')) as QualityRecord
      if (original.policy !== QUALITY_POLICY || contentKey(original.input) !== original.key
        || !original.calls.some(saved => !saved.error && !saved.reusedFrom && saved.sessionId === call.sessionId
          && saved.role === call.role && saved.prompt === call.prompt && saved.reply === call.reply)) return false
      if (original.key === contentKey(input)) return true
      return original.input.kind === 'map' && input.kind === 'map'
        && canonicalJson(original.input.context) === canonicalJson(input.context)
        && mapCallMatches(call, input) && this.validApproval(original, original.input, check)
    } catch { return false }
  }
  private candidateFile(prompt: string): string {
    const key = createHash('sha256').update(`${QUALITY_POLICY}\n${prompt}`).digest('hex')
    return path.join(this.directory, 'generation', `${key}.json`)
  }
  candidate(prompt: string): GeneratedCandidate | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.candidateFile(prompt), 'utf8')) as GeneratedCandidate
      if (typeof value.reply !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputKey) || !['pending', 'rejected', 'review-limit'].includes(value.status)
        || (value.status !== 'pending' && (!Array.isArray(value.issues) || !value.issues.length || value.issues.some(issue => typeof issue !== 'string')))) return undefined
      return value
    } catch { return undefined }
  }
  saveCandidate(prompt: string, value: GeneratedCandidate): void { atomicJson(this.candidateFile(prompt), value) }
  clearCandidate(prompt: string): void { fs.rmSync(this.candidateFile(prompt), { force: true }) }
  private publicationDirectory(sessionId: string): string {
    return path.join(this.directory, 'published', createHash('sha256').update(sessionId).digest('hex'))
  }
  publish(input: ContentInput, sessionId: string, seq: number): void {
    if (input.kind !== 'teaching' || !sessionId || !Number.isSafeInteger(seq) || seq < 0 || !this.approved(input)) throw new Error('不能记录未通过准入或缺少事件编号的讲授发布')
    const reply = (input.units[0].content as { reply: string }).reply
    const receipt: PublishedTurn = { sessionId, seq, node: input.units[0].node!, reply, qualityKey: contentKey(input), publishedAt: new Date().toISOString() }
    const file = path.join(this.publicationDirectory(sessionId), `${seq}.json`)
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as PublishedTurn
      if (saved.reply !== reply) throw new Error('相同课堂事件不能对应不同发布内容')
      return // 恢复时回放同一事件不重复计作新讲授。
    }
    atomicJson(file, receipt)
  }
  published(sessionId: string): PublishedTurn[] {
    const dir = this.publicationDirectory(sessionId)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter(name => /^\d+\.json$/.test(name)).flatMap(name => {
      try {
        const receipt = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as PublishedTurn
        if (receipt.sessionId !== sessionId || !Number.isSafeInteger(receipt.seq) || receipt.seq < 0 || !/^[a-f0-9]{64}$/.test(receipt.qualityKey)) return []
        const admission = JSON.parse(fs.readFileSync(path.join(this.directory, 'approved', `${receipt.qualityKey}.json`), 'utf8')) as QualityRecord
        // 审计历史发布依据当时的批准记录，不能因当前策略升级将已发布历史抹掉。
        if (admission.status !== 'approved' || admission.key !== receipt.qualityKey || admission.input.kind !== 'teaching'
          || (admission.input.units[0].content as { reply?: string }).reply !== receipt.reply || admission.input.units[0].node !== receipt.node) return []
        return [receipt]
      } catch { return [] }
    }).sort((a, b) => a.seq - b.seq)
  }
  private validApproval(record: QualityRecord, input: ContentInput, check: ApprovalCheck = { visiting: new Set(), results: new Map() }): boolean {
    const marker = record.id + ':' + contentKey(input)
    if (check.results.has(marker)) return check.results.get(marker)!
    if (check.visiting.has(marker)) return false
    check.visiting.add(marker)
    let valid = false
    try { valid = this.inspectApproval(record, input, check) }
    finally { check.visiting.delete(marker); check.results.set(marker, valid) }
    return valid
  }
  private inspectApproval(record: QualityRecord, input: ContentInput, check: ApprovalCheck): boolean {
    try {
      validateContentInput(input)
      if (record.status !== 'approved' || record.policy !== QUALITY_POLICY || record.key !== contentKey(input) || contentKey(record.input) !== record.key) return false
      if (!this.reviewContextCurrent(record, input)) return false
      const solver = record.calls.filter(c => c.role === 'solver')
      const reviewers = record.calls.filter(c => c.role === 'reviewer')
      if (!reviewers.length || record.calls.some(call => !call.sessionId || (call.error && !call.splitAfterError)) || new Set(record.calls.map(call => call.sessionId)).size !== record.calls.length) return false
      if (record.calls.some(call => !this.reusable(call, input, check))) return false
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
