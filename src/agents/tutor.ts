import { CourseService } from '../application/course-service.ts'
import { TeachingCapabilities } from '../capabilities/teaching.ts'
import { ModelService } from '../capabilities/model-service.ts'
import { domainAssert } from '../domain/model.ts'
import { ChatRuntime, ModelBudgetError } from '../runtime/chat.ts'
import { TutorToolset } from './toolset.ts'
import type { ReasoningLevel } from '../core/reasoning.ts'

export class TutorAgent {
  private readonly service: CourseService
  private readonly runtime: ChatRuntime
  private readonly capabilities: TeachingCapabilities
  private readonly role: (sessionId: string, role: string) => void
  constructor(options: {
    service: CourseService
    runtime: ChatRuntime
    model: ModelService
    role?: (sessionId: string, role: string) => void
  }) {
    this.service = options.service
    this.runtime = options.runtime
    this.capabilities = new TeachingCapabilities(options.service, options.model)
    this.role = options.role ?? (() => {})
  }

  async run(courseId: string, turnId: string, signal: AbortSignal): Promise<{ paused: boolean }> {
    let state = this.service.repository.read(courseId)
    const turn = state.turns[turnId]
    domainAssert(turn, 'INVALID_TURN', '教学回合不存在')
    if (turn.yielded) return { paused: state.tutorStatus === 'paused' }
    const toolset = new TutorToolset(this.service, this.capabilities, {
      courseId,
      turnId,
      intent: turn.intent,
      revision: state.revision,
    })
    const thinking = (this.runtime.env.TUTOR_AGENT_THINKING || 'low') as ReasoningLevel
    const model = this.runtime.env.TUTOR_AGENT_MODEL
    const maxToolSteps = Number(this.runtime.env.TUTOR_AGENT_MAX_STEPS || 6)
    domainAssert(
      Number.isSafeInteger(maxToolSteps) && maxToolSteps >= 1 && maxToolSteps <= 12,
      'INVALID_BUDGET',
      '业务动作预算需为 1–12',
    )
    const options = {
      toolset,
      maxToolSteps,
      retryOnLength: false,
      maxTokens: 16384,
      deadlineMs: 240000,
      thinking,
      ...(model ? { model } : {}),
    }
    let chat = state.sessionId ? await this.runtime.createChat({ ...options, resumeSessionId: state.sessionId }) : null
    if (!chat) {
      chat = await this.runtime.createChat(options)
      domainAssert(chat, 'MODEL_UNAVAILABLE', '无法建立导师会话', 503)
      this.service.repository.transact(
        courseId,
        { requestId: 'session:' + chat.sessionId, input: { sessionId: chat.sessionId } },
        (next) => {
          next.sessionId = chat!.sessionId
          return { sessionId: chat!.sessionId }
        },
      )
    }
    this.role(chat.sessionId, 'tutor')
    state = this.service.repository.read(courseId)
    toolset.revision = state.revision
    const user = this.service.repository.asset<{ text: string }>(courseId, turn.messageAsset)
    const prompt = JSON.stringify({
      trigger: turn.trigger ?? 'user',
      intent: turn.intent,
      learnerMessage: user.text,
      recovery:
        turn.trigger === 'resume'
          ? '已完成的判断和动作见 recentDecisions；不要重复执行，从未完成的内容修复或教学行动继续。'
          : undefined,
      observation: this.service.observation(courseId),
      execution: {
        availableCodeLanguages: ['javascript', 'python', 'go'].filter((language) =>
          this.capabilities.sandbox.available(language as 'javascript' | 'python' | 'go'),
        ),
        goRuntime: 'Go WASI/wasm32，标准输入输出，无网络和 cgo。不要要求本机平台特定行为。',
        maxBusinessSteps: maxToolSteps,
      },
    })
    try {
      signal.throwIfAborted()
      const reply = await chat.ask(prompt)
      signal.throwIfAborted()
      if (!toolset.yielded) {
        if (reply === '已交回学员') throw new ModelBudgetError('本轮检查达到工具上限，已保存完成的步骤，请继续')
        const current = this.service.repository.read(courseId)
        await this.capabilities.validation.message(current, reply)
        signal.throwIfAborted()
        this.service.message(courseId, reply, 'reply:' + turnId, turnId, current.revision, '依据当前目标与学员反馈回应')
      }
      return { paused: toolset.paused }
    } finally {
      await chat.flush()
    }
  }
}
