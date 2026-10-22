import { randomUUID } from 'node:crypto'
import { blindQuestions, contentIssues, contentKey, factProbes, FACT_PERSONA, MAP_REVIEW_CONTRACT, MAP_NODE_REVIEW_CONTRACT, MAP_OUTLINE_REVIEW_CONTRACT, MAP_RESOURCE_REVIEW_CONTRACT, mapReviewContext, mapTeachingTime, TEACHING_REVIEW_CONTRACT, PRACTICE_REVIEW_CONTRACT, parseBlindSolutions, parseContentReview, parseFactChecks, QUALITY_POLICY, REVIEWER_PERSONA, SOLVER_PERSONA,
  requiredAssertions, teachingContent, validateContentInput, type ApprovedTeachingTurn, type ContentInput } from '../core/content-quality.ts'
import type { KnowledgeMap, Profile } from '../core/schema.ts'
import { QualityStore, type QualityRecord } from '../core/quality-store.ts'
import { OutputLimitError, type AgentChat } from '../runtime/chat.ts'
import { TurnTimeoutError } from '../runtime/timeouts.ts'
import { generateTurn, parseJsonBlock, type ParseResult } from './generation.ts'
import { formatTurnCost } from '../core/cost.ts'
import { loadCostConfigFromRepo } from './cost-line.ts'
import type { FlowDeps } from './deps.ts'

export interface ContentVerdict { approved: boolean; issues: string[]; cached: boolean; evidenceFile?: string }
export class ContentReviewError extends Error {
  constructor(message: string, cause: unknown) { super(message, { cause }); this.name = 'ContentReviewError' }
}
export const CONTENT_REVIEW_LIMITS = { maxTokens: 8192, deadlineMs: 240_000, retryOnLength: false } as const
type ChatFactory = (role: QualityRecord['calls'][number]['role'], systemPrompt: string) => Promise<AgentChat>

function batches<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
}

// 按单元稳定分批：同一单元的断言永远落在同一个请求里，不受其他单元增删影响。
// （旧版按全局位置两两配对，某节点补资料会让后续所有批次错位，导致旧单元的已完成检查无法复用、被重新判定。）
function unitBatches<T extends { id: string }>(items: T[], size: number): T[][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const separator = item.id.lastIndexOf('/')
    const unit = separator > 0 ? item.id.slice(0, separator) : item.id
    if (!groups.has(unit)) groups.set(unit, [])
    groups.get(unit)!.push(item)
  }
  return [...groups.values()].flatMap(group => batches(group, size))
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
    const ask = async (role: QualityRecord['calls'][number]['role'], prompt: string, takeOverAfterError: boolean): Promise<string> => {
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
        return call.reply
      } catch (error) {
        failed = true
        call.error = error instanceof Error ? error.message : String(error)
        if (chat && takeOverAfterError && (error instanceof OutputLimitError || error instanceof TurnTimeoutError)) call.splitAfterError = true
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
      const parseReply = (text: string): R[] => {
        const parsed = parseJsonBlock(text)
        if (!parsed.ok) throw new Error(parsed.error)
        return parse(parsed.value, items)
      }
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
      let reply: string
      // 超限/超时的失败总是由更小任务接管（拆小或紧凑重问），因此标记可接管，批准校验才认这条证据。
      try { reply = await ask(role, request, true) }
      catch (error) {
        if (!(error instanceof OutputLimitError || error instanceof TurnTimeoutError)) throw error
        if (items.length > 1) return split()
        // 单条任务已经拆不动了：换成明确要求紧凑结论的一次重问。直接上抛会让此前所有检查报废。
        const compact = `${request}\n\n只审查这一条并给出结论：explanation 一句话内，不要复述或逐项抄写被审查内容。`
        try { return parseReply(await ask(role, compact, false)) } catch { throw error }
      }
      try { return parseReply(reply) }
      catch (first) {
        // 模型偶尔回显输入而不给结论，或漏掉/多写 JSON 括号。重问一次比把整份已花掉的审查报废便宜；
        // 重问仍不合格就保留首次错误，语义拒绝不会被这层重问绕过。
        const reminder = `${request}\n\n只输出一个完整 JSON 代码块，按 outputContract 给出结论字段，不要回显输入内容，也不要多余的收尾括号。`
        try { return parseReply(await ask(role, reminder, items.length > 1)) } catch { throw first }
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
        await parallelParts(unitBatches(factProbes(input), 2), async claims => {
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
          // 地图按单元逐个复核（单元稳定，可跨版本复用）；其余内容类型批次本就是单单元。
          const parts = input.kind === 'map' || input.kind === 'plan' ? remaining.map(unit => [unit]) : batches(remaining, 1)
          await parallelParts(parts, reviewPart)
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

export function createContentGate(deps: FlowDeps, courseId: string): ContentGate {
  const labels: Record<ContentInput['kind'], string> = { map: '课程地图', plan: '学习计划', bank: '摸底题目', lesson: '教案', practice: '实践任务', exam: '试卷', teaching: '讲授' }
  return new ContentGate(new QualityStore(deps.store.root, courseId), async (_role, systemPrompt) => {
    return deps.createChat({ isolatedSystemPrompt: systemPrompt, ...CONTENT_REVIEW_LIMITS })
  }, record => {
    const out = deps.io.out
    out(`内容审查 ${record.input.kind}：${record.status === 'approved' ? '通过' : record.status === 'rejected' ? `拦截 ${record.issues?.length ?? 0} 处问题` : '未完成'}（记录已保存）。\n`)
    const cost = loadCostConfigFromRepo(deps.workspace)
    const reused = record.calls.filter(call => call.reusedFrom).length
    if (reused) out(`复用同一内容的 ${reused} 项已完成检查，原始证据与费用保留；本次不重复计费。\n`)
    for (const call of record.calls) if (call.model && !call.reusedFrom) {
      deps.costs?.record(call.model, call.usage, `review:${call.role}`)
      out(`审查开销 ${call.role}：${formatTurnCost(call.usage, call.model, cost, deps.io.tty)}\n`)
    }
  }, {
    onStart: record => {
      const message = `正在核对${labels[record.input.kind]}的范围与正确性…`
      deps.io.out(message + '\n')
      deps.status({ phase: 'review', message })
    },
    onProgress: (record, call) => {
      if (call.reusedFrom) return
      const completed = record.calls.filter(item => item.elapsedMs !== undefined && !item.reusedFrom && !item.error).length
      const reused = record.calls.filter(item => item.reusedFrom).length
      const message = `${labels[record.input.kind]}核查中：已完成 ${completed} 项新检查${reused ? `，复用 ${reused} 项已有检查` : ''}。`
      deps.io.out(message + '\n')
      deps.status({ phase: 'review', message })
    },
  })
}

// 推理型模型在长结构化任务上可能把单次输出预算烧在推理里、正文为空（reasoning 与正文共用同一个上限）。
// 这类失败不是内容问题，靠"重试一次"救不回来，必须显式要求压缩输出：只给最终结果、不写过程、字段与条目精简。
const COMPACT_RETRY_HINT = [
  '【紧凑模式】上一次输出为空或超出单次输出上限，请压缩后重新输出：',
  '- 只给最终结果，不要任何解释、前言、推理过程、复盘或总结；',
  '- 字段值精简到能表达意思的最小长度；条目总数取最少必要数量；',
  '- 严格沿用上一次要求的 JSON 结构与字段名。',
].join('\n')

function isCompactableFailure(error: unknown): boolean {
  if (error instanceof OutputLimitError) return true
  if (!(error instanceof Error)) return false
  // Chat 层把多次重试后的最后一次错误包装成普通 Error（消息里保留原始原因），两种都要认。
  return error.message.includes('没有返回正文') || error.message.includes('达到 token 上限')
}

export async function generateApproved<T>(chat: Pick<AgentChat, 'ask'> & Partial<Pick<AgentChat, 'flush'>>, prompt: string, parse: (text: string) => ParseResult | Promise<ParseResult>,
  gate: ContentGate, content: (value: T) => ContentInput, options: { reviewLimitRepair?: string; out?: (text: string) => void } = {}): Promise<T> {
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
  const parseAndGate = async (text: string): Promise<ParseResult> => {
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
      options.out?.('资料审查达到时限或输出上限，正在精简本知识点资料后重新核查…\n')
      return { ok: false, error: issue }
    }
    if (!verdict.approved) {
      rejected.set(key, verdict)
      gate.store.saveCandidate(prompt, { reply: text, inputKey: key, status: 'rejected', issues: verdict.issues })
    }
    return verdict.approved ? result : { ok: false, error: `内容准入审查失败，请修复以下问题，仍须遵守原始任务与 JSON 结构：\n${verdict.issues.join('\n')}\n修复要求：逐条对应上面的问题改写；被判定为不成立或无法核实的说法，直接删除或换成有把握的表述，不要换个说法重复同一断言；涉及数值、算式或代码输出的，必须按题目重新算一遍再写，不能沿用原值或只改措辞；不要为了保留内容而重新组织原句。` }
  }
  try {
    let value: T
    try {
      value = await generateTurn(generation, prompt, parseAndGate) as T
    } catch (error) {
      // 输出为空或撞上限：换紧凑提示重生成一次（内容问题仍按原逻辑处理）。
      if (!isCompactableFailure(error)) throw error
      options.out?.('模型输出为空或超出单次上限，正在按紧凑模式重新生成…\n')
      replayCandidate = false
      seedRepair = false
      value = await generateTurn({ ask: (request: string) => chat.ask(`${request}\n${COMPACT_RETRY_HINT}`) },
        prompt, parseAndGate) as T
    }
    gate.store.clearCandidate(prompt)
    return value
  } finally { await chat.flush?.() }
}

// 讲授正文是纯文本（不是 JSON），紧凑提示只压长度、不改结构。
const COMPACT_TEACHING_HINT = '请直接对学员开讲，控制在 800 字以内：只保留讲解要点与必要的例子，不要写开场铺垫、复盘、总结清单或任何推理过程。'

export async function generateApprovedTeaching(chat: AgentChat, prompt: string, gate: ContentGate,
  scope: { node: string; profile: Profile; map: KnowledgeMap; learnerMessage: string; previousReply: string }): Promise<ApprovedTeachingTurn> {
  let request = prompt
  const seen = new Set<string>()
  for (let attempt = 0; attempt < 3; attempt++) {
    let reply: string
    try {
      reply = await chat.ask(request)
    } catch (error) {
      // 推理型模型可能把输出预算烧在推理里、正文为空或超上限：压缩后重试一次。
      if (attempt === 0 && isCompactableFailure(error)) { request = `${prompt}\n${COMPACT_TEACHING_HINT}`; continue }
      throw error
    } finally { await chat.flush() }
    if (!reply.trim()) {
      if (attempt === 0) { request = `${prompt}\n${COMPACT_TEACHING_HINT}`; continue }
      throw new Error('讲授回复为空或未按审查意见修复，未展示内容')
    }
    if (seen.has(reply)) throw new Error('讲授回复为空或未按审查意见修复，未展示内容')
    seen.add(reply)
    const turn = { reply, learnerMessage: scope.learnerMessage, previousReply: scope.previousReply }
    const verdict = await gate.review(teachingContent(turn, scope.node, scope.profile, scope.map))
    if (verdict.approved) return turn
    request = `上一段回复未通过内容审查，尚未向学员展示。修复以下问题后重新输出这段讲授，直接对学员说话，不输出 JSON 或审查说明，不要求学员检查草稿：\n${verdict.issues.join('\n')}`
  }
  throw new Error('讲授多次修复仍未通过内容审查，保留上一个已批准断点')
}
