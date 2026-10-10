import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { addUsage, normalizeUsage, type ReportedUsage, type UsageSample } from '../core/cost.ts'
import { ModelWaitClock, ModelWaitTimeoutError, TurnTimeoutError, turnTimeoutMs, whenIdleOrStalled, whenIdleWithin } from './turn-timeout.ts'
import { ResearchBudget } from './research-budget.ts'
import { ModelRateLimitError, ModelRequestQueueError, modelRateLimiterFromEnvironment } from '../core/model-rate-limit.ts'
import { MODEL_RECOVERY_LIMITS, ModelRecoveryError, recoveryDelay, transientModelFailure, transientRouteFailure } from '../core/model-recovery.ts'
import { researchStatus } from './research-status.ts'

interface SessionEventView {
  type: string
  data?: {
    reason?: { kind: string; error?: { code: string; message: string } }
    usage?: ReportedUsage
    message?: { content: { type: string; text?: string }[]; usage?: ReportedUsage }
  }
}

interface SessionView {
  seq: number
  eventAt(seq: unknown): SessionEventView | undefined
}

export interface AgentChat {
  sessionId: string
  model: string
  ask(prompt: string): Promise<string>
  lastTurnUsage(): UsageSample
  totalUsage(): UsageSample
  lastReply(): string
  lastReplySeq?(): number | null
  flush(): Promise<void>
}

interface AgentLike {
  session: SessionView & { id?: unknown }
  whenIdle(): Promise<void>
  followup(message: unknown): void
  cancel?(cause: { kind: 'hook'; reason: string }): void
}

interface AgentsRegistry {
  create(options: Record<string, unknown>): Promise<{ agent: AgentLike }>
  resume(options: Record<string, unknown>): Promise<{ agent: AgentLike }>
}

interface SessionsRegistry {
  flush(session: unknown): Promise<void>
}

export interface CreateAgentChatOptions {
  resumeSessionId?: string
  isolatedSystemPrompt?: string
  tools?: 'none' | 'research'
  deadlineMs?: number
  maxWaitMs?: number
  maxTokens?: number
  retryOnLength?: boolean
  onProgress?: (message: string) => void
}

export class OutputLimitError extends Error {
  constructor() { super('模型输出达到 token 上限，请缩小本次任务后重试'); this.name = 'OutputLimitError' }
}

function requestDeadline(options: CreateAgentChatOptions): number {
  const value = options.deadlineMs ?? Number(options.tools === 'research'
    ? process.env.TUTOR_RESEARCH_DEADLINE_MS ?? process.env.TUTOR_LLM_DEADLINE_MS : process.env.TUTOR_LLM_DEADLINE_MS)
  return Number.isFinite(value) && value > 0 ? value : options.tools === 'research' ? 480_000 : 300_000
}

export function permanentModelError(error: unknown): boolean {
  // 已观察到的具体网关路由 404 可恢复；模型不存在、认证失败与权限错误仍立即结束。
  const seen = new Set<Error>()
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    if (error instanceof ModelRecoveryError || error instanceof ModelRequestQueueError || error instanceof ModelWaitTimeoutError) return true
    const transientRoute = transientRouteFailure(error.message)
    if (!transientRoute && /\b(400|401|403|404|422)\b|model is not found|not_found_error|UNSUPPORTED_REASONING_EFFORT/i.test(error.message)) return true
    error = error.cause
  }
  return false
}

export async function createAgentChat(ctx: Context, options: CreateAgentChatOptions = {}): Promise<AgentChat | null> {
  if (options.resumeSessionId && options.isolatedSystemPrompt) throw new Error('独立审查禁止恢复历史会话')
  await (ctx.get('loader' as never) as { await(): Promise<void> } | undefined)?.await()
  const agentDefaultModel = ctx.get('agentDefaultModel') as
    | { currentSelection(): { provider: string; model: string } }
    | undefined
  const agents = ctx.get('agents') as AgentsRegistry | undefined
  const sessions = ctx.get('sessions') as SessionsRegistry | undefined
  if (!agentDefaultModel || !agents || !sessions) throw new Error('tutor: 核心服务未就绪')
  const selection = agentDefaultModel.currentSelection()
  // 流式活性计数：dsh 的 session.seq 只在事件边界前进（工具调用/结果、单条消息生成完毕），单条消息
  // 「流式吐字」期间并不 +1。若只拿 seq 当停滞看门狗的进展信号，assess/plan 这类「一次大生成、不调
  // 工具」的回合会在正常吐字途中被误判卡死。这里订阅逐块流帧：中转站每吐一块（chunk）就 +1，于是
  // 「正在吐字」= 有进展，真正的「完全没有字节返回」才会累积停滞。事件缺失时降级为 seq-only（不劣于原状）。
  let streamTicks = 0
  const research = options.tools === 'research' ? new ResearchBudget(options.onProgress) : undefined
  const limiter = selection.provider === 'tutor' ? modelRateLimiterFromEnvironment() : undefined
  let requestFailure: ModelRecoveryError | ModelRequestQueueError | undefined
  let recoveryStep = ''
  let recoveryFailures = 0
  let requestKey = ''
  const waiting = new ModelWaitClock()
  const progress = options.onProgress ?? ((message: string) => {
    (process.env.TUTOR_RESEARCH_PROGRESS === '1' ? process.stdout : process.stderr).write(`tutor: ${message}\n`)
  })
  const createOptions = {
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx: Context) => {
      installModelSelection(agentCtx as never, { current: selection, assembled: undefined })
      agentCtx.on('agent/request', async ({ turn, step, signal }, next) => {
        if (requestFailure) throw requestFailure
        requestKey = `${turn}:${step}`
        research?.checkRequest(requestKey)
        const request = await next()
        try {
          await waiting.wait(async () => limiter?.acquire(signal, ms => {
            const message = `等待渠道额度，约 ${Math.ceil(ms / 1000)} 秒后自动继续；已保存的教研进度保留。`
            progress(message)
            researchStatus({ phase: 'waiting', message, retryAt: Date.now() + ms,
              ...(requestKey === recoveryStep ? { retry: recoveryFailures, maxRetries: MODEL_RECOVERY_LIMITS.retries } : {}) })
          }))
        }
        catch (error) {
          if (error instanceof ModelRequestQueueError) requestFailure = error
          throw error
        }
        signal.throwIfAborted()
        research?.startRequest(requestKey)
        researchStatus({ phase: 'request', message: requestKey === recoveryStep ? '等待结束，正在重新请求模型。' : '正在请求模型，等待回复。' })
        return { ...request, maxTokens: Math.min(request.maxTokens ?? 8192, options.maxTokens ?? 8192) }
      })
      if (limiter) agentCtx.on('agent/request-error', async ({ turn, step, failure, signal }, next) => {
        if (!transientModelFailure(failure)) return next()
        const key = `${turn}:${step}`
        if (key !== recoveryStep) { recoveryStep = key; recoveryFailures = 0 }
        recoveryFailures++
        try {
          const wait = await limiter.cooldown(signal, recoveryDelay(failure, recoveryFailures))
          if (recoveryFailures > MODEL_RECOVERY_LIMITS.retries) {
            requestFailure = failure.code === 'RATE_LIMIT' ? new ModelRateLimitError(recoveryFailures)
              : new ModelRecoveryError(failure.code, recoveryFailures)
            throw requestFailure
          }
          const message = `渠道暂时${failure.code === 'RATE_LIMIT' ? '限流（429）' : '不可用'}，第 ${recoveryFailures}/${MODEL_RECOVERY_LIMITS.retries} 次恢复：等待至少 ${Math.ceil(wait / 1000)} 秒后自动重试。`
          progress(message)
          researchStatus({ phase: 'retry', message, code: failure.code, retry: recoveryFailures,
            maxRetries: MODEL_RECOVERY_LIMITS.retries, retryAt: Date.now() + wait })
        } catch (error) {
          if (error instanceof ModelRequestQueueError) requestFailure = error
          throw error
        }
        // 保留 Harness 的错误与重试事件；额外退避统一由跨进程队列执行。
        return waiting.wait(async () => await next() ?? { kind: 'retry' })
      }, { prepend: true })
      const allowed = (name: string) => !options.isolatedSystemPrompt && options.tools === 'research'
        && (name.startsWith('mcp__searchix__') || name === 'web_fetch')
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const result = await next()
        return { ...result, tools: result.tools.filter(tool => allowed(tool.name) && (!research || research.available(tool.name, !research.hasRequest(requestKey)))),
          sections: research ? [...result.sections, { name: 'tutor:research-budget', text: research.instruction() }] : result.sections }
      })
      ;(agentCtx.get('tools') as { guard: (fn: (execution: { name: string }) => string | undefined) => unknown })
        .guard(execution => allowed(execution.name) ? research?.claim(execution.name) : '教学内容必须通过 runner 审查后发布，禁止模型调用此工具')
      if (research) agentCtx.on('tools/post-execute', async (execution, result, next) => {
        const decision = await next()
        if (decision.kind === 'block' || 'value' in decision) return decision
        return { ...decision, content: research.result(execution.name, decision.content ?? result.content, result.isError) }
      })
      if (options.isolatedSystemPrompt) {
        // Agent 局部作用域，避免教学生成角色、课程插件上下文和工具泄漏进盲解/审查会话。
        agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(),
          sections: [{ name: 'tutor:isolated-review', text: options.isolatedSystemPrompt! }], contexts: [], tools: [], variables: {} }))
      }
      ;(agentCtx as { on?: (name: string, listener: (payload: { frame?: { type?: string } }) => void) => unknown })
        .on?.('agent/assistant-stream', (payload) => {
          if (payload?.frame?.type === 'chunk') streamTicks++
        })
    },
  }
  let agent: AgentLike
  try {
    if (options.resumeSessionId) {
      const resumed = await agents.resume({
        resumeSessionId: brandString(options.resumeSessionId) as never,
        ...createOptions,
      })
      agent = resumed.agent
    } else {
      const created = await agents.create({
        sessionId: brandString(`session-${randomUUID()}`) as never,
        ...createOptions,
      })
      agent = created.agent
    }
  } catch (error) {
    if (options.resumeSessionId) return null
    throw error
  }
  await whenIdleWithin(() => agent.whenIdle(), turnTimeoutMs())

  let turnUsage: UsageSample = { inputTokens: 0, outputTokens: 0 }
  let total: UsageSample = { inputTokens: 0, outputTokens: 0 }
  let usageCursor = 0
  function accountUsage(): void {
    for (; usageCursor < agent.session.seq; usageCursor++) {
      const event = agent.session.eventAt(SessionSeq(usageCursor))
      if (event?.type !== 'assistant/message' && event?.type !== 'assistant/attempt') continue
      const sample = normalizeUsage(event.data?.usage ?? event.data?.message?.usage)
      if (!sample) continue
      total = addUsage(total, sample)
      turnUsage = addUsage(turnUsage, sample)
    }
  }
  accountUsage()
  turnUsage = { inputTokens: 0, outputTokens: 0 }

  return {
    sessionId: String(agent.session.id ?? ''),
    model: selection.model,
    lastReply(): string {
      let text = ''
      for (let seq = 0; seq < agent.session.seq; seq++) {
        const event = agent.session.eventAt(SessionSeq(seq))
        if (event?.type === 'assistant/message' && event.data?.message) {
          const joined = event.data.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('')
          if (joined !== '') text = joined
        }
      }
      return text
    },
    lastReplySeq(): number | null {
      for (let seq = agent.session.seq - 1; seq >= 0; seq--) {
        const event = agent.session.eventAt(SessionSeq(seq))
        if (event?.type === 'assistant/message' && event.data?.message?.content.some(block => block.type === 'text' && block.text)) return seq
      }
      return null
    },
    async ask(prompt: string): Promise<string> {
      accountUsage()
      turnUsage = { inputTokens: 0, outputTokens: 0 }
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const cursor = agent.session.seq
          agent.followup(
            createUserMessage({
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'user' },
            })
          )
          await whenIdleOrStalled(() => agent.whenIdle(), () => agent.session.seq + streamTicks, turnTimeoutMs(), 1000, requestDeadline(options),
            { milliseconds: waiting.waitingMs, limitMs: options.maxWaitMs ?? MODEL_RECOVERY_LIMITS.waitingMs })
          if (requestFailure) throw requestFailure
          if (research?.failure) throw research.failure
          let text = ''
          let turnError: string | null = null
          let aborted = false
          for (let seq = cursor; seq < agent.session.seq; seq++) {
            const event = agent.session.eventAt(SessionSeq(seq))
            if (!event) continue
            if (event.type === 'assistant/message' && event.data?.message) {
              const joined = event.data.message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('')
              if (joined !== '') text = joined
            }
            if (event.type === 'turn/end' && event.data?.reason && event.data.reason.kind !== 'completed') {
              aborted = event.data.reason.kind === 'aborted'
              turnError = event.data.reason.error
                ? `${event.data.reason.error.code}: ${event.data.reason.error.message}`
                : event.data.reason.kind
            }
          }
          if (turnError !== null) {
            if (turnError === 'max-tokens') throw new OutputLimitError()
            const error = new Error(turnError)
            if (aborted) error.name = 'AbortError'
            throw error
          }
          if (!text.trim()) throw new Error('模型回合结束但没有返回正文')
          return text
        } catch (error) {
          lastError = error
          if (requestFailure) throw requestFailure
          if (research?.failure) throw research.failure
          if (error instanceof TurnTimeoutError || error instanceof ModelWaitTimeoutError) {
            // Harness 支持按 agent 取消；先收敛旧请求，禁止在仍运行的会话叠加 followup。
            agent.cancel?.({ kind: 'hook', reason: error.message })
            if (agent.cancel) try { await whenIdleWithin(() => agent.whenIdle(), 5000) } catch {}
            throw error
          }
          if ((error instanceof Error && error.name === 'AbortError') || permanentModelError(error)
            || (error instanceof OutputLimitError && options.retryOnLength === false)) throw error
          if (attempt === 0) {
            process.stderr.write(`tutor: 模型回合异常（${error instanceof Error ? error.message : String(error)}），重试一次…\n`)
            await new Promise((resolve) => setTimeout(resolve, 1500))
          }
        } finally {
          // 截断、失败与重试也可能计费；按日志游标累计一次，不以成功返回为前提。
          accountUsage()
        }
      }
      throw new Error(`模型回合失败——${lastError instanceof Error ? lastError.message : String(lastError)}`)
    },
    lastTurnUsage(): UsageSample {
      accountUsage()
      return { ...turnUsage }
    },
    totalUsage(): UsageSample {
      accountUsage()
      return { ...total }
    },
    async flush(): Promise<void> {
      await sessions.flush(agent.session)
      accountUsage()
    },
  }
}
