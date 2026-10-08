import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { addUsage, normalizeUsage, type ReportedUsage, type UsageSample } from '../core/cost.ts'
import { TurnTimeoutError, turnTimeoutMs, whenIdleOrStalled, whenIdleWithin } from './turn-timeout.ts'

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
  flush(): Promise<void>
}

interface AgentLike {
  session: SessionView & { id?: unknown }
  whenIdle(): Promise<void>
  followup(message: unknown): void
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
  const createOptions = {
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx: Context) => {
      installModelSelection(agentCtx as never, { current: selection, assembled: undefined })
      const allowed = (name: string) => !options.isolatedSystemPrompt && options.tools === 'research'
        && (name.startsWith('mcp__searchix__') || name === 'web_fetch')
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const result = await next()
        return { ...result, tools: result.tools.filter(tool => allowed(tool.name)) }
      })
      ;(agentCtx.get('tools') as { guard: (fn: (execution: { name: string }) => string | undefined) => unknown })
        .guard(execution => allowed(execution.name) ? undefined : '教学内容必须通过 runner 审查后发布，禁止模型调用此工具')
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
          await whenIdleOrStalled(() => agent.whenIdle(), () => agent.session.seq + streamTicks, turnTimeoutMs())
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
            const error = new Error(turnError)
            if (aborted) error.name = 'AbortError'
            throw error
          }
          return text
        } catch (error) {
          lastError = error
          // 停滞超时（连续无新事件）无法 abort：底层回合可能仍在后台跑，重试会在同一 session 叠加 followup。
          // 直接抛出，交给 runner 的 catch 保存进度并退出（重跑可从 session 断点续上）。
          if (error instanceof TurnTimeoutError || (error instanceof Error && error.name === 'AbortError')) throw error
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
