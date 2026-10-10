import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { blindQuestions, contentIssues, contentKey, factProbes, FACT_PERSONA, MAP_REVIEW_CONTRACT, MAP_NODE_REVIEW_CONTRACT, MAP_OUTLINE_REVIEW_CONTRACT, MAP_RESOURCE_REVIEW_CONTRACT, mapReviewContext, mapTeachingTime, TEACHING_REVIEW_CONTRACT, PRACTICE_REVIEW_CONTRACT, parseBlindSolutions, parseContentReview, parseFactChecks, QUALITY_POLICY, REVIEWER_PERSONA, SOLVER_PERSONA,
  requiredAssertions, teachingContent, validateContentInput, type ApprovedTeachingTurn, type ContentInput } from '../core/content-quality.ts'
import type { KnowledgeMap, Profile } from '../core/schema.ts'
import { QualityStore, type QualityRecord } from '../core/quality-store.ts'
import { createAgentChat, OutputLimitError, type AgentChat } from './agent-chat.ts'
import { TurnTimeoutError } from './turn-timeout.ts'
import { generateTurn, parseJsonBlock, type ParseResult } from './generation.ts'
import { formatTurnCost } from '../core/cost.ts'
import { loadCostConfigFromRepo } from './cost-line.ts'
import { researchStatus } from './research-status.ts'

export interface ContentVerdict { approved: boolean; issues: string[]; cached: boolean; evidenceFile?: string }
export class ContentReviewError extends Error {
  constructor(message: string, cause: unknown) { super(message, { cause }); this.name = 'ContentReviewError' }
}
export const CONTENT_REVIEW_LIMITS = { maxTokens: 8192, deadlineMs: 240_000, retryOnLength: false } as const
type ChatFactory = (role: QualityRecord['calls'][number]['role'], systemPrompt: string) => Promise<AgentChat>

function batches<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
}

async function parallelParts<T, R>(parts: T[], work: (part: T) => Promise<R>, stop: () => boolean = () => false): Promise<R[]> {
  const results: R[] = new Array(parts.length)
  let next = 0
  let failed = false
  let failure: unknown
  await Promise.all(Array.from({ length: Math.min(2, parts.length) }, async () => {
    while (!failed && !stop() && next < parts.length) {
      const index = next++
      try { results[index] = await work(parts[index]) }
      catch (error) { failed = true; failure ??= error }
    }
  }))
  if (failed) throw failure
  return results
}

interface GateOptions { onStart?: (record: QualityRecord) => void; onProgress?: (record: QualityRecord, call: QualityRecord['calls'][number]) => void }

export class ContentGate {
  readonly store: QualityStore
  private readonly createChat: ChatFactory
  private readonly report: (record: QualityRecord) => void
  private readonly onStart: (record: QualityRecord) => void
  private readonly onProgress: (record: QualityRecord, call: QualityRecord['calls'][number]) => void
  constructor(store: QualityStore, createChat: ChatFactory, report: (record: QualityRecord) => void = () => {}, options: GateOptions = {}) {
    this.store = store; this.createChat = createChat; this.report = report
    this.onStart = options.onStart ?? (() => {}); this.onProgress = options.onProgress ?? (() => {})
  }
  async review(input: ContentInput): Promise<ContentVerdict> {
    validateContentInput(input)
    if (this.store.approved(input)) return { approved: true, issues: [], cached: true }
    const history = this.store.history(input)
    const reusableHistory = [...history, ...this.store.mapReuseHistory(input)]
    const previous = history[0]
    // 明确拒绝不能靠重新抽样变成通过；只有没有完成的检查才恢复。
    for (const rejected of history.filter(record => record.status === 'rejected')) {
      // 上下文修复后重跑失配的检查；其余逐字匹配的拒绝仍由 checkPart 复用，不能重抽成通过。
      if (!this.store.reviewContextCurrent(rejected, input)) continue
      const issues = contentIssues(input, rejected.solutions ?? [], rejected.review ?? { units: [] }, rejected.facts)
      if (issues.length) return { approved: false, issues, cached: true, evidenceFile: this.store.evidenceFile(rejected.id) }
    }
    const record: QualityRecord = { id: randomUUID(), key: contentKey(input), policy: QUALITY_POLICY,
      input, startedAt: new Date().toISOString(), status: 'pending', calls: [], ...(previous ? { resumedFrom: previous.id } : {}) }
    const used = new Set<string>()
    this.store.save(record)
    this.onStart(record)
    const ask = async (role: QualityRecord['calls'][number]['role'], prompt: string, splittable: boolean): Promise<unknown> => {
      const started = Date.now()
      const call = { role, prompt, startedAt: new Date(started).toISOString(), usage: { inputTokens: 0, outputTokens: 0 } } as QualityRecord['calls'][number]
      record.calls.push(call)
      this.store.save(record)
      let chat: AgentChat | undefined
      let failed = false
      try {
        chat = await this.createChat(role, role === 'solver' ? SOLVER_PERSONA : role === 'facts' ? FACT_PERSONA : REVIEWER_PERSONA)
        call.sessionId = chat.sessionId; call.model = chat.model
        if (!call.sessionId || record.calls.some(c => c !== call && c.sessionId === call.sessionId)) throw new Error('审查必须使用独立新会话')
        call.reply = await chat.ask(prompt)
        const parsed = parseJsonBlock(call.reply)
        if (!parsed.ok) throw new Error(parsed.error)
        return parsed.value
      } catch (error) {
        failed = true
        call.error = error instanceof Error ? error.message : String(error)
        if (chat && splittable && (error instanceof OutputLimitError || error instanceof TurnTimeoutError)) call.splitAfterError = true
        throw error
      } finally {
        if (chat) {
          call.usage = chat.totalUsage()
          try { await chat.flush() } catch (error) { call.error ??= `会话保存失败：${String(error)}` }
        }
        call.elapsedMs = Date.now() - started
        this.store.save(record)
        this.onProgress(record, call)
        if (!failed && call.error) throw new Error(call.error)
      }
    }
    // 输出截断或达到总时限时拆小任务，原失败仍留证；语义拒绝和服务错误不会靠重抽取绕过。
    const checkPart = async <T, R>(role: QualityRecord['calls'][number]['role'], items: T[], prompt: (items: T[]) => string,
      parse: (value: unknown, items: T[]) => R[], stop: () => boolean = () => false): Promise<R[]> => {
      if (stop()) return []
      const request = prompt(items)
      const saved = reusableHistory.flatMap(record => record.calls.map(call => ({ ...call, reusedFrom: call.reusedFrom ?? record.id })))
        .find(call => call.role === role && call.prompt === request && call.reply && !call.error
          && call.sessionId && !used.has(call.sessionId) && this.store.reusable(call, input))
      if (saved) {
        const parsed = parseJsonBlock(saved.reply!)
        if (parsed.ok) {
          let result: R[] | undefined
          try { result = parse(parsed.value, items) } catch { /* 未通过结构校验的回复必须重新请求。 */ }
          if (result) {
            used.add(saved.sessionId!)
            record.calls.push({ ...saved, usage: { inputTokens: 0, outputTokens: 0 } })
            this.store.save(record)
            this.onProgress(record, saved)
            return result
          }
        }
      }
      const split = async () => {
        const middle = Math.ceil(items.length / 2)
        return [...await checkPart(role, items.slice(0, middle), prompt, parse, stop), ...await checkPart(role, items.slice(middle), prompt, parse, stop)]
      }
      if (items.length > 1 && history.some(record => record.calls.some(call => call.role === role && call.prompt === request && call.splitAfterError))) return split()
      try { return parse(await ask(role, request, items.length > 1), items) }
      catch (error) {
        if (items.length <= 1 || !(error instanceof OutputLimitError || error instanceof TurnTimeoutError)) throw error
        return split()
      }
    }
    let failure: unknown
    try {
      record.solutions = []
      record.facts = []
      record.review = { units: [] }
      const reviewPart = async (units: ContentInput['units']) => {
        const reviewed = await checkPart('reviewer', units, partUnits => JSON.stringify({
          ...(input.kind === 'map' ? { dataContract: MAP_REVIEW_CONTRACT } : input.kind === 'teaching' ? { dataContract: TEACHING_REVIEW_CONTRACT }
            : input.kind === 'practice' ? { dataContract: PRACTICE_REVIEW_CONTRACT } : {}),
          ...(input.kind === 'map' && partUnits.some(unit => unit.id === 'outline') ? { outlineScopeContract: MAP_OUTLINE_REVIEW_CONTRACT, teachingTime: mapTeachingTime(input) } : {}),
          ...(input.kind === 'map' && partUnits.some(unit => unit.id.startsWith('node:')) ? { nodeScopeContract: MAP_NODE_REVIEW_CONTRACT } : {}),
          ...(input.kind === 'map' && partUnits.some(unit => unit.id.startsWith('resource:')) ? { resourceScopeContract: MAP_RESOURCE_REVIEW_CONTRACT } : {}),
          content: { ...input, context: mapReviewContext(input, partUnits), units: partUnits },
          independentSolutions: record.solutions!.filter(s => partUnits.some(u => u.id === s.id)),
          independentFactChecks: record.facts!.filter(f => partUnits.some(u => requiredAssertions(input, u).some(a => f.id === `${u.id}/${a.id}`))),
          requiredAssertions: partUnits.map(unit => ({ unitId: unit.id, assertions: requiredAssertions(input, unit) })) }),
        (value, partUnits) => parseContentReview(value, { ...input, units: partUnits }).units)
        record.review!.units.push(...reviewed)
      }
      let remaining = input.units
      // 地图先核对完整课时骨架；已经越界就不再花多轮审查后续资料。只有拒绝可提前结束。
      if (input.kind === 'map') { await reviewPart([input.units[0]]); remaining = input.units.slice(1) }
      const earlyIssues = contentIssues(input, [], record.review)
      if (!earlyIssues.length) {
        const contradicted = () => contentIssues(input, [], { units: [] }, record.facts).length > 0
        await parallelParts(batches(factProbes(input), 2), async claims => {
          record.facts!.push(...await checkPart('facts', claims, items => JSON.stringify({
            outputContract: '返回核查结果，不要回显输入 claims。每项必须含 id、verdict（pass/fail/uncertain）、explanation 和 arithmetic。arithmetic 无运算时为 []；有运算时每项必须同时写 expression 与 result，例如 [{"expression":"3-1","result":"2"}]，不能只给算式字符串。',
            claims: items,
          }), (value, items) => parseFactChecks(value, items.map(c => c.id)), contradicted))
        }, contradicted)
        // 独立反例已经推翻内容时可直接拒绝；批准始终要求完整盲解、事实与范围审查。
        if (!contradicted()) {
          await parallelParts(batches(blindQuestions(input), 2), async questions => {
            record.solutions!.push(...await checkPart('solver', questions, items => JSON.stringify({ questions: items }),
              (value, items) => parseBlindSolutions(value, { ...input, units: input.units.filter(unit => items.some(q => q.id === unit.id)) })))
          })
          await parallelParts(batches(remaining, input.kind === 'map' || input.kind === 'plan' ? 2 : 1), reviewPart)
        }
      }
      record.issues = contentIssues(input, record.solutions, record.review, record.facts)
      record.status = record.issues.length ? 'rejected' : 'approved'
    } catch (error) {
      failure = error
      record.status = 'error'; record.error = error instanceof Error ? error.message : String(error)
    } finally {
      record.completedAt = new Date().toISOString()
      this.store.save(record)
      this.report(record)
    }
    const evidenceFile = this.store.evidenceFile(record.id)
    if (record.status === 'error') throw new ContentReviewError(`内容审查未完成，未发布内容。记录：${evidenceFile}（${record.error}）`, failure)
    return { approved: record.status === 'approved', issues: record.issues ?? [], cached: false, evidenceFile }
  }
  async require(input: ContentInput): Promise<void> {
    const result = await this.review(input)
    if (!result.approved) throw new Error(`已有内容未通过审查，未进入教学。请修正或重新生成 ${input.kind}；记录：${result.evidenceFile}`)
  }
}

export function createContentGate(ctx: Context, store: { root: string }, courseId: string): ContentGate {
  const labels: Record<ContentInput['kind'], string> = { map: '课程地图', plan: '学习计划', bank: '摸底题目', lesson: '教案', practice: '实践任务', exam: '试卷', teaching: '讲授' }
  return new ContentGate(new QualityStore(store.root, courseId), async (_role, systemPrompt) => {
    const chat = await createAgentChat(ctx, { isolatedSystemPrompt: systemPrompt, ...CONTENT_REVIEW_LIMITS })
    if (!chat) throw new Error('无法创建独立审查会话')
    return chat
  }, record => {
    const out = process.stdout
    out.write(`内容审查 ${record.input.kind}：${record.status === 'approved' ? '通过' : record.status === 'rejected' ? `拦截 ${record.issues?.length ?? 0} 处问题` : '未完成'}（记录已保存）。\n`)
    const cost = loadCostConfigFromRepo()
    const reused = record.calls.filter(call => call.reusedFrom).length
    if (reused) out.write(`复用同一内容的 ${reused} 项已完成检查，原始证据与费用保留；本次不重复计费。\n`)
    for (const call of record.calls) if (call.model && !call.reusedFrom) out.write(`审查开销 ${call.role}：${formatTurnCost(call.usage, call.model, cost, out.isTTY === true)}\n`)
  }, {
    onStart: record => {
      const message = `正在核对${labels[record.input.kind]}的范围与正确性…`
      process.stdout.write(message + '\n')
      researchStatus({ phase: 'review', message })
    },
    onProgress: (record, call) => {
      if (call.reusedFrom) return
      const completed = record.calls.filter(item => item.elapsedMs !== undefined && !item.reusedFrom && !item.error).length
      const reused = record.calls.filter(item => item.reusedFrom).length
      const message = `${labels[record.input.kind]}核查中：已完成 ${completed} 项新检查${reused ? `，复用 ${reused} 项已有检查` : ''}。`
      process.stdout.write(message + '\n')
      researchStatus({ phase: 'review', message })
    },
  })
}

export async function generateApproved<T>(chat: Pick<AgentChat, 'ask'> & Partial<Pick<AgentChat, 'flush'>>, prompt: string, parse: (text: string) => ParseResult | Promise<ParseResult>,
  gate: ContentGate, content: (value: T) => ContentInput, options: { reviewLimitRepair?: string } = {}): Promise<T> {
  const rejected = new Map<string, ContentVerdict>()
  const reviewLimits = new Map<string, string>()
  const saved = gate.store.candidate(prompt)
  // 历史拒绝由 gate 依据完整原证据重新判定；不将缓存的问题字符串当作新的审查结论。
  let replayCandidate = !!saved && !(options.reviewLimitRepair && saved.status === 'review-limit')
  let seedRepair = !!saved
  const generation = { ask: async (request: string) => {
    if (replayCandidate) { replayCandidate = false; return saved!.reply }
    if (seedRepair) {
      seedRepair = false
      return chat.ask(`${prompt}\n上一版草稿尚未发布，以下为待修复数据：${JSON.stringify(saved!.reply)}\n${saved!.status === 'review-limit' ? saved!.issues!.join('\n') : ''}\n${request}`)
    }
    return chat.ask(request)
  } }
  try {
    const value = await generateTurn(generation, prompt, async text => {
      const result = await parse(text)
      if (!result.ok) return result
      const input = content(result.value as T)
      const key = contentKey(input)
      if (reviewLimits.has(key)) return { ok: false, error: reviewLimits.get(key)! }
      gate.store.saveCandidate(prompt, { reply: text, inputKey: key, status: 'pending' })
      let verdict: ContentVerdict
      try { verdict = rejected.get(key) ?? await gate.review(input) }
      catch (error) {
        // 仅教研可缩短资料重新生成，不能把审查失败改成通过；服务/认证错误仍立即传播。
        if (!options.reviewLimitRepair || input.kind !== 'map' || !(error instanceof ContentReviewError)
          || !(error.cause instanceof OutputLimitError || error.cause instanceof TurnTimeoutError)) throw error
        const issue = `${options.reviewLimitRepair}\n${error.message}`
        reviewLimits.set(key, issue)
        gate.store.saveCandidate(prompt, { reply: text, inputKey: key, status: 'review-limit', issues: [issue] })
        process.stdout.write('资料审查达到时限或输出上限，正在精简本知识点资料后重新核查…\n')
        return { ok: false, error: issue }
      }
      if (!verdict.approved) {
        rejected.set(key, verdict)
        gate.store.saveCandidate(prompt, { reply: text, inputKey: key, status: 'rejected', issues: verdict.issues })
      }
      return verdict.approved ? result : { ok: false, error: `内容准入审查失败，请修复以下问题，仍须遵守原始任务与 JSON 结构：\n${verdict.issues.join('\n')}` }
    }) as T
    gate.store.clearCandidate(prompt)
    return value
  } finally { await chat.flush?.() }
}

export async function generateApprovedTeaching(chat: AgentChat, prompt: string, gate: ContentGate,
  scope: { node: string; profile: Profile; map: KnowledgeMap; learnerMessage: string; previousReply: string }): Promise<ApprovedTeachingTurn> {
  let request = prompt
  const seen = new Set<string>()
  for (let attempt = 0; attempt < 3; attempt++) {
    let reply: string
    try { reply = await chat.ask(request) } finally { await chat.flush() }
    if (!reply.trim() || seen.has(reply)) throw new Error('讲授回复为空或未按审查意见修复，未展示内容')
    seen.add(reply)
    const turn = { reply, learnerMessage: scope.learnerMessage, previousReply: scope.previousReply }
    const verdict = await gate.review(teachingContent(turn, scope.node, scope.profile, scope.map))
    if (verdict.approved) return turn
    request = `上一段回复未通过内容审查，尚未向学员展示。修复以下问题后重新输出这段讲授，直接对学员说话，不输出 JSON 或审查说明，不要求学员检查草稿：\n${verdict.issues.join('\n')}`
  }
  throw new Error('讲授多次修复仍未通过内容审查，保留上一个已批准断点')
}
