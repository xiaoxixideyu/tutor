import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { addUsage, type UsageSample } from '../core/cost.ts'

interface SessionEventView {
  type: string
  data?: {
    reason?: { kind: string; error?: { code: string; message: string } }
    usage?: { inputTokens?: number; outputTokens?: number }
    message?: { content: { type: string; text?: string }[]; usage?: { inputTokens?: number; outputTokens?: number } }
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
}

export async function createAgentChat(ctx: Context, options: CreateAgentChatOptions = {}): Promise<AgentChat | null> {
  await (ctx.get('loader' as never) as { await(): Promise<void> } | undefined)?.await()
  const agentDefaultModel = ctx.get('agentDefaultModel') as
    | { currentSelection(): { provider: string; model: string } }
    | undefined
  const agents = ctx.get('agents') as AgentsRegistry | undefined
  const sessions = ctx.get('sessions') as SessionsRegistry | undefined
  if (!agentDefaultModel || !agents || !sessions) throw new Error('tutor: 核心服务未就绪')
  const selection = agentDefaultModel.currentSelection()
  const createOptions = {
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx: Context) => {
      installModelSelection(agentCtx as never, { current: selection, assembled: undefined })
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
  await agent.whenIdle()

  function usageAt(event: SessionEventView): UsageSample | null {
    const usage = event.data?.usage ?? event.data?.message?.usage
    if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return null
    return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  }

  const initialTotal: UsageSample = { inputTokens: 0, outputTokens: 0 }
  for (let seq = 0; seq < agent.session.seq; seq++) {
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event?.type === 'assistant/message') {
      const usage = usageAt(event)
      if (usage) initialTotal.inputTokens += usage.inputTokens
      if (usage) initialTotal.outputTokens += usage.outputTokens
    }
  }
  let turnUsage: UsageSample = { inputTokens: 0, outputTokens: 0 }
  let total: UsageSample = { ...initialTotal }

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
          await agent.whenIdle()
          let text = ''
          let turnError: string | null = null
          let usage: UsageSample = { inputTokens: 0, outputTokens: 0 }
          for (let seq = cursor; seq < agent.session.seq; seq++) {
            const event = agent.session.eventAt(SessionSeq(seq))
            if (!event) continue
            if (event.type === 'assistant/message' && event.data?.message) {
              const joined = event.data.message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join('')
              if (joined !== '') text = joined
              const sample = usageAt(event)
              if (sample) {
                usage = addUsage(usage, sample)
              }
            }
            if (event.type === 'turn/end' && event.data?.reason && event.data.reason.kind !== 'completed') {
              turnError = event.data.reason.error
                ? `${event.data.reason.error.code}: ${event.data.reason.error.message}`
                : event.data.reason.kind
            }
          }
          if (turnError !== null) throw new Error(turnError)
          turnUsage = usage
          total = addUsage(total, usage)
          return text
        } catch (error) {
          lastError = error
          if (attempt === 0) {
            process.stderr.write(`tutor: 模型回合异常（${error instanceof Error ? error.message : String(error)}），重试一次…\n`)
            await new Promise((resolve) => setTimeout(resolve, 1500))
          }
        }
      }
      throw new Error(`模型回合失败——${lastError instanceof Error ? lastError.message : String(lastError)}`)
    },
    lastTurnUsage(): UsageSample {
      return { ...turnUsage }
    },
    totalUsage(): UsageSample {
      return { ...total }
    },
    async flush(): Promise<void> {
      await sessions.flush(agent.session)
    },
  }
}
