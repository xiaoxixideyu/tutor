import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { blindQuestions, contentIssues, contentKey, factProbes, FACT_PERSONA, MAP_REVIEW_CONTRACT, parseBlindSolutions, parseContentReview, parseFactChecks, QUALITY_POLICY, REVIEWER_PERSONA, SOLVER_PERSONA,
  requiredAssertions, teachingContent, validateContentInput, type ApprovedTeachingTurn, type ContentInput } from '../core/content-quality.ts'
import type { KnowledgeMap, Profile } from '../core/schema.ts'
import { QualityStore, type QualityRecord } from '../core/quality-store.ts'
import { createAgentChat, type AgentChat } from './agent-chat.ts'
import { generateTurn, parseJsonBlock, type ParseResult } from './generation.ts'
import { formatTurnCost } from '../core/cost.ts'
import { loadCostConfigFromRepo } from './cost-line.ts'

export interface ContentVerdict { approved: boolean; issues: string[]; cached: boolean; evidenceFile?: string }
type ChatFactory = (role: QualityRecord['calls'][number]['role'], systemPrompt: string) => Promise<AgentChat>

function batches<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
}

export class ContentGate {
  readonly store: QualityStore
  private readonly createChat: ChatFactory
  private readonly report: (record: QualityRecord) => void
  constructor(store: QualityStore, createChat: ChatFactory, report: (record: QualityRecord) => void = () => {}) {
    this.store = store; this.createChat = createChat; this.report = report
  }
  async review(input: ContentInput): Promise<ContentVerdict> {
    validateContentInput(input)
    if (this.store.approved(input)) return { approved: true, issues: [], cached: true }
    const record: QualityRecord = { id: randomUUID(), key: contentKey(input), policy: QUALITY_POLICY,
      input, startedAt: new Date().toISOString(), status: 'pending', calls: [] }
    this.store.save(record)
    const ask = async (role: QualityRecord['calls'][number]['role'], prompt: string): Promise<unknown> => {
      const call = { role, prompt, usage: { inputTokens: 0, outputTokens: 0 } } as QualityRecord['calls'][number]
      record.calls.push(call)
      this.store.save(record)
      let chat: AgentChat | undefined
      try {
        chat = await this.createChat(role, role === 'solver' ? SOLVER_PERSONA : role === 'facts' ? FACT_PERSONA : REVIEWER_PERSONA)
        call.sessionId = chat.sessionId; call.model = chat.model
        if (!call.sessionId || record.calls.some(c => c !== call && c.sessionId === call.sessionId)) throw new Error('审查必须使用独立新会话')
        call.reply = await chat.ask(prompt)
        const parsed = parseJsonBlock(call.reply)
        if (!parsed.ok) throw new Error(parsed.error)
        return parsed.value
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        if (chat) {
          call.usage = chat.totalUsage()
          try { await chat.flush() } catch (error) { call.error ??= `会话保存失败：${String(error)}` }
        }
        this.store.save(record)
        if (call.error) throw new Error(call.error)
      }
    }
    try {
      record.solutions = []
      record.facts = []
      record.review = { units: [] }
      const reviewPart = async (units: ContentInput['units']) => {
        const part = { ...input, units }
        record.review!.units.push(...parseContentReview(await ask('reviewer', JSON.stringify({
          ...(input.kind === 'map' ? { dataContract: MAP_REVIEW_CONTRACT } : {}), content: part,
          independentSolutions: record.solutions!.filter(s => units.some(u => u.id === s.id)),
          independentFactChecks: record.facts!.filter(f => units.some(u => requiredAssertions(input, u).some(a => f.id === `${u.id}/${a.id}`))),
          requiredAssertions: units.map(unit => ({ unitId: unit.id, assertions: requiredAssertions(part, unit) })) })), part).units)
      }
      const parts = batches(input.units, 3)
      // 地图先核对完整课时骨架；已经越界就不再花多轮审查后续资料。只有拒绝可提前结束。
      if (input.kind === 'map') await reviewPart(parts.shift()!)
      const earlyIssues = contentIssues(input, [], record.review)
      if (!earlyIssues.length) {
        for (const questions of batches(blindQuestions(input), 3)) {
          const part = { ...input, units: input.units.filter(unit => questions.some(q => q.id === unit.id)) }
          record.solutions.push(...parseBlindSolutions(await ask('solver', JSON.stringify({ questions })), part))
        }
        for (const claims of batches(factProbes(input), 4)) record.facts.push(...parseFactChecks(await ask('facts', JSON.stringify({ claims })), claims.map(c => c.id)))
        for (const units of parts) await reviewPart(units)
      }
      record.issues = contentIssues(input, record.solutions, record.review, record.facts)
      record.status = record.issues.length ? 'rejected' : 'approved'
    } catch (error) {
      record.status = 'error'; record.error = error instanceof Error ? error.message : String(error)
    } finally {
      record.completedAt = new Date().toISOString()
      this.store.save(record)
      this.report(record)
    }
    const evidenceFile = this.store.evidenceFile(record.id)
    if (record.status === 'error') throw new Error(`内容审查未完成，未发布内容。记录：${evidenceFile}（${record.error}）`)
    return { approved: record.status === 'approved', issues: record.issues ?? [], cached: false, evidenceFile }
  }
  async require(input: ContentInput): Promise<void> {
    const result = await this.review(input)
    if (!result.approved) throw new Error(`已有内容未通过审查，未进入教学。请修正或重新生成 ${input.kind}；记录：${result.evidenceFile}`)
  }
}

export function createContentGate(ctx: Context, store: { root: string }, courseId: string): ContentGate {
  return new ContentGate(new QualityStore(store.root, courseId), async (_role, systemPrompt) => {
    const chat = await createAgentChat(ctx, { isolatedSystemPrompt: systemPrompt })
    if (!chat) throw new Error('无法创建独立审查会话')
    return chat
  }, record => {
    const out = process.stdout
    out.write(`内容审查 ${record.input.kind}：${record.status === 'approved' ? '通过' : record.status === 'rejected' ? `拦截 ${record.issues?.length ?? 0} 处问题` : '未完成'}（记录已保存）。\n`)
    const cost = loadCostConfigFromRepo()
    for (const call of record.calls) if (call.model) out.write(`审查开销 ${call.role}：${formatTurnCost(call.usage, call.model, cost, out.isTTY === true)}\n`)
  })
}

export async function generateApproved<T>(chat: Pick<AgentChat, 'ask'> & Partial<Pick<AgentChat, 'flush'>>, prompt: string, parse: (text: string) => ParseResult | Promise<ParseResult>,
  gate: ContentGate, content: (value: T) => ContentInput): Promise<T> {
  const rejected = new Map<string, ContentVerdict>()
  try {
    return await generateTurn(chat, prompt, async text => {
      const result = await parse(text)
      if (!result.ok) return result
      const input = content(result.value as T)
      const key = contentKey(input)
      const verdict = rejected.get(key) ?? await gate.review(input)
      if (!verdict.approved) rejected.set(key, verdict)
      return verdict.approved ? result : { ok: false, error: `内容准入审查失败，请修复以下问题，仍须遵守原始任务与 JSON 结构：\n${verdict.issues.join('\n')}` }
    }) as T
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
