// 模型会话运行时（单进程）：OpenAI 兼容传输 + 工具循环 + 会话事件日志 + 可靠性护栏。
// 一个 chat 会话对应一个知识点/一次生成任务；ask() 是一次完整回合（含工具循环与传输重试）。
import { randomUUID } from 'node:crypto'
import { MODEL_RECOVERY_LIMITS, ModelRecoveryError, recoveryDelay, transientModelFailure } from '../core/model-recovery.ts'
import { ModelRateLimitError, ModelRequestQueueError, ModelRateLimiter } from '../core/model-rate-limit.ts'
import { addUsage, normalizeUsage, type ReportedUsage, type UsageSample } from '../core/cost.ts'
import { ModelWaitClock, ModelWaitTimeoutError, TurnTimeoutError, turnTimeoutMs, whenIdleOrStalled, whenIdleWithin } from './timeouts.ts'
import { ResearchBudget } from './budget.ts'
import { ContextWindowError, estimateTokens, fitHistory, normalizeContextWindow, outputTokenLimit } from './context.ts'
import { SessionLog } from './session.ts'
import { openaiTransport, type ApiMessage, type ApiToolCall, type ApiToolDef, type LlmFailure, type LlmRequest, type LlmResult, type LlmTransport } from './llm.ts'
import { MCP_SEARCH_PREFIX, WEB_FETCH_TOOL, createResearchTools, searchSettingsFromEnv, webFetch, type ResearchTools, type SearchSettings } from './tools.ts'
import type { ResearchStatusSink } from './status.ts'

export interface ModelSettings {
  baseUrl: string
  apiKey: string
  model: string
  thinking: 'default' | 'on' | 'off'
  contextWindow: number
  requestsPerMinute: number
  researchDeadlineMs: number
}

export interface CreateChatOptions {
  resumeSessionId?: string
  isolatedSystemPrompt?: string
  tools?: 'none' | 'research'
  deadlineMs?: number
  maxWaitMs?: number
  maxTokens?: number
  retryOnLength?: boolean
  onProgress?: (message: string) => void
}

export interface AgentChat {
  sessionId: string
  model: string
  ask(prompt: string): Promise<string>
  lastTurnUsage(): UsageSample
  totalUsage(): UsageSample
  lastReply(): string
  lastReplySeq(): number | null
  flush(): Promise<void>
}

export class OutputLimitError extends Error {
  constructor() { super('模型输出达到 token 上限，请缩小本次任务后重试'); this.name = 'OutputLimitError' }
}

export class ModelRequestError extends Error {
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  constructor(code: string, message: string, extras: { status?: number; providerRetryAfterMs?: number } = {}) {
    super(message, { cause: code })
    this.name = 'ModelRequestError'
    this.code = code
    if (extras.status !== undefined) this.status = extras.status
    if (extras.providerRetryAfterMs !== undefined) this.providerRetryAfterMs = extras.providerRetryAfterMs
  }
}

export function permanentModelError(error: unknown): boolean {
  // 已观察到的具体网关路由 404 可恢复；模型不存在、认证失败与权限错误仍立即结束。
  const seen = new Set<Error>()
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    if (error instanceof ModelRecoveryError || error instanceof ModelRequestQueueError || error instanceof ModelWaitTimeoutError) return true
    const transientRoute = /404:\s*\{\s*"message"\s*:\s*"404 Route Not Found"/i.test(error.message)
      && /"type"\s*:\s*"bad_response_status_code"/i.test(error.message)
    if (!transientRoute && /\b(400|401|403|404|422)\b|model is not found|not_found_error|UNSUPPORTED_REASONING_EFFORT/i.test(error.message)) return true
    error = error.cause as Error
  }
  return false
}

// 验收/评测用观察事件：每个传输尝试的开始、结束与失败，不包含提示词或正文。
export type AttemptObservation =
  | { type: 'attempt-start'; sessionId: string; attemptId: string; time: string }
  | { type: 'attempt'; sessionId: string; model: string; attemptId: string; outcome: 'committed' | 'length' | 'error' | 'aborted'
      elapsedMs: number; firstChunkMs?: number; firstTextMs?: number; usage?: ReportedUsage }
  | { type: 'request-error'; sessionId: string; time: string; failure: LlmFailure }

export interface ChatRuntimeOptions {
  model: ModelSettings
  sessionsRoot: string
  workspace: string
  persona?: string
  env?: NodeJS.ProcessEnv
  out?: (text: string) => void
  err?: (text: string) => void
  status?: ResearchStatusSink
  transport?: LlmTransport
  rateLimiter?: ModelRateLimiter
  // 每回合重新解析模型渠道：网页保存新设置后，进行中的流程在下一回合生效；缺省沿用启动快照（CLI）。
  resolveModel?: () => ModelSettings
  // 渠道重建的注入点（测试/扩展）；固定的 transport/rateLimiter 优先于工厂与默认实现。
  transportFactory?: (settings: ModelSettings) => LlmTransport
  limiterFactory?: (settings: ModelSettings) => ModelRateLimiter
  researchTools?: ResearchTools
  // 教研搜索同样按回合解析：保存新搜索服务后，教研流程下一步即可用（缺省沿用启动环境快照）。
  resolveSearch?: () => SearchSettings | undefined
  researchToolsFactory?: (settings: SearchSettings) => ResearchTools
  signal?: AbortSignal
  observe?: (event: AttemptObservation) => void
  maxModelRequests?: number
}

type LlmSuccess = Extract<LlmResult, { finish: 'stop' | 'tool_calls' | 'length' }>

interface TurnResult { text: string; error?: 'max-tokens' | 'empty' | string; aborted?: boolean }

function requestDeadline(options: CreateChatOptions, env: NodeJS.ProcessEnv): number {
  const value = options.deadlineMs ?? Number(options.tools === 'research'
    ? env.TUTOR_RESEARCH_DEADLINE_MS ?? env.TUTOR_LLM_DEADLINE_MS : env.TUTOR_LLM_DEADLINE_MS)
  return Number.isFinite(value) && value > 0 ? value : options.tools === 'research' ? 480_000 : 300_000
}

export class ChatRuntime {
  private readonly options: ChatRuntimeOptions
  private readonly startupModel: ModelSettings
  private cachedChannel?: { key: string; transport: LlmTransport; limiter: ModelRateLimiter }
  readonly env: NodeJS.ProcessEnv

  constructor(options: ChatRuntimeOptions) {
    this.options = options
    this.startupModel = options.model
    this.env = options.env ?? process.env
  }

  // 当前渠道设置：resolveModel 由宿主注入（网页宿主每次读取最新保存的配置）。
  modelNow(): ModelSettings {
    return this.options.resolveModel?.() ?? this.startupModel
  }

  // transport 与限速器按 (baseUrl, apiKey, model, thinking, rpm) 缓存；设置变化时整体重建。
  private channel(settings: ModelSettings): { transport: LlmTransport; limiter: ModelRateLimiter } {
    const key = [settings.baseUrl, settings.apiKey, settings.model, settings.thinking, settings.requestsPerMinute].join('\n')
    if (this.cachedChannel?.key === key) return this.cachedChannel
    const transport = this.options.transport ?? this.options.transportFactory?.(settings) ?? openaiTransport({
      baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, thinking: settings.thinking,
    })
    const limiter = this.options.rateLimiter ?? this.options.limiterFactory?.(settings) ?? new ModelRateLimiter({
      file: this.env.TUTOR_MODEL_RATE_LIMIT_FILE ?? `${this.options.sessionsRoot}/../model-rate-limits.sqlite`,
      baseUrl: settings.baseUrl, apiKey: settings.apiKey, requestsPerMinute: settings.requestsPerMinute,
    })
    this.cachedChannel = { key, transport, limiter }
    return this.cachedChannel
  }

  transportNow(settings: ModelSettings = this.modelNow()): LlmTransport {
    return this.channel(settings).transport
  }

  limiterNow(settings: ModelSettings = this.modelNow()): ModelRateLimiter {
    return this.channel(settings).limiter
  }

  // 当前搜索服务：宿主注入 resolveSearch 时每回合读取最新设置，否则用启动环境快照。
  searchNow(): SearchSettings | undefined {
    return this.options.resolveSearch ? this.options.resolveSearch() : searchSettingsFromEnv(this.env)
  }

  async createChat(options: CreateChatOptions = {}): Promise<AgentChat | null> {
    if (options.resumeSessionId && options.isolatedSystemPrompt) throw new Error('独立审查禁止恢复历史会话')
    if (options.resumeSessionId) {
      const log = SessionLog.load(this.options.sessionsRoot, this.options.workspace, options.resumeSessionId)
      if (!log) return null
      return new Chat(this, this.options, log, options)
    }
    return new Chat(this, this.options, new SessionLog(this.options.sessionsRoot, this.options.workspace), options)
  }
}

class Chat implements AgentChat {
  readonly sessionId: string
  private readonly runtime: ChatRuntime
  private readonly options: ChatRuntimeOptions
  private readonly log: SessionLog
  private readonly chatOptions: CreateChatOptions
  private readonly deadline: number
  private readonly maxWaitMs: number
  private readonly waiting = new ModelWaitClock()
  private readonly research?: ResearchBudget
  private toolsCache?: { key: string; tools: ResearchTools }
  private readonly fetchImpl: typeof fetch
  private streamTicks = 0
  private turn = 0
  private requestFailure: ModelRecoveryError | ModelRequestQueueError | undefined
  private recoveryStep = ''
  private recoveryFailures = 0
  private turnUsage: UsageSample = { inputTokens: 0, outputTokens: 0 }
  private total: UsageSample = { inputTokens: 0, outputTokens: 0 }
  private settled: Promise<void> = Promise.resolve()
  private modelRequests = 0

  constructor(runtime: ChatRuntime, options: ChatRuntimeOptions, log: SessionLog, chatOptions: CreateChatOptions) {
    this.runtime = runtime
    this.options = options
    this.log = log
    this.chatOptions = chatOptions
    this.sessionId = log.id
    this.deadline = requestDeadline(chatOptions, runtime.env)
    this.maxWaitMs = chatOptions.maxWaitMs ?? MODEL_RECOVERY_LIMITS.waitingMs
    this.research = chatOptions.tools === 'research' && !chatOptions.isolatedSystemPrompt ? new ResearchBudget(message => this.progress(message)) : undefined
    this.fetchImpl = fetch
    for (const event of this.log.events) {
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
      const data = event.data as { usage?: ReportedUsage; message?: { usage?: ReportedUsage } } | undefined
      const sample = normalizeUsage(data?.usage ?? data?.message?.usage)
      if (sample) this.total = addUsage(this.total, sample)
    }
  }

  // 当前模型名（成本显示与事件记录用）：跟随热更新。
  get model(): string {
    return this.runtime.modelNow().model
  }

  private progress(message: string): void {
    if (this.chatOptions.onProgress) { this.chatOptions.onProgress(message); return }
    const text = `tutor: ${message}\n`
    if (this.runtime.env.TUTOR_RESEARCH_PROGRESS === '1') this.options.out?.(text)
    else this.options.err?.(text)
  }

  private systemPrompt(): string {
    if (this.chatOptions.isolatedSystemPrompt) return this.chatOptions.isolatedSystemPrompt
    return this.options.persona ?? ''
  }

  private apiMessages(): ApiMessage[] {
    const sections = [this.systemPrompt()]
    if (this.research) sections.push(this.research.instruction())
    const systemContent = sections.filter(section => section !== '').join('\n\n')
    const settings = this.runtime.modelNow()
    const maxOutput = outputTokenLimit(settings.contextWindow, this.chatOptions.maxTokens ?? 8192)
    const promptBudget = Math.max(256, normalizeContextWindow(settings.contextWindow) - maxOutput - 512)
    const fitted = fitHistory(estimateTokens(systemContent), this.log.messages, promptBudget)
    const content = fitted.omitted > 0
      ? `${systemContent}\n\n（较早的 ${fitted.omitted} 条对话已按上下文预算省略；请依据保留的课程计划与最近对话继续。）`
      : systemContent
    return [{ role: 'system', content }, ...fitted.messages]
  }

  private appendUser(prompt: string): void {
    this.log.messages.push({ role: 'user', content: prompt })
    this.log.persistMessages()
    this.log.appendEvent('user/message', { message: { role: 'user', content: [{ type: 'text', text: prompt }] } })
  }

  private account(sample: ReportedUsage): void {
    const normalized = normalizeUsage(sample)
    if (!normalized) return
    this.total = addUsage(this.total, normalized)
    this.turnUsage = addUsage(this.turnUsage, normalized)
  }

  // 搜索工具按当前搜索设置解析：设置变化时重建（下一步即用新服务），旧连接丢弃。
  private researchToolsNow(): ResearchTools | undefined {
    if (!this.research) return undefined
    if (this.options.researchTools) return this.options.researchTools
    const settings = this.runtime.searchNow()
    if (!settings) return undefined
    const key = `${settings.url}\n${settings.token}`
    if (this.toolsCache?.key !== key) {
      void this.toolsCache?.tools.close().catch(() => {})
      this.toolsCache = { key, tools: this.options.researchToolsFactory?.(settings) ?? createResearchTools(settings, message => this.progress(message)) }
    }
    return this.toolsCache.tools
  }

  private async advertisedTools(requestKey: string): Promise<ApiToolDef[]> {
    if (!this.research) return []
    const tools = this.researchToolsNow()
    const definitions = tools ? [WEB_FETCH_TOOL, ...(await tools.definitions())] : [WEB_FETCH_TOOL]
    return definitions.filter(tool => this.research!.available(tool.name, !this.research!.hasRequest(requestKey)))
  }

  private async executeTool(call: ApiToolCall, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const name = call.function.name
    const allowed = name === 'web_fetch' || name.startsWith(MCP_SEARCH_PREFIX)
    if (!allowed || !this.research) {
      return { text: '教学内容必须通过 runner 审查后发布，禁止模型调用此工具', isError: true }
    }
    const denial = this.research.claim(name)
    if (denial) return { text: denial, isError: true }
    let result: { text: string; isError: boolean }
    if (name === 'web_fetch') {
      let url = ''
      try { url = String((JSON.parse(call.function.arguments || '{}') as { url?: unknown }).url ?? '') } catch { /* 参数非法按空 URL 处理 */ }
      result = await webFetch(url, signal, this.fetchImpl)
    } else {
      const tools = this.researchToolsNow()
      if (!tools) return { text: '搜索服务未配置或暂不可用，请使用 web_fetch 或依据已有资料收束。', isError: true }
      result = await tools.call(name, call.function.arguments, signal)
    }
    const blocks = this.research.result(name, [{ type: 'text', text: result.text }], result.isError)
    return { text: blocks.map(block => block.text).join('\n'), isError: result.isError }
  }

  private async requestModel(requestKey: string, request: LlmRequest, signal: AbortSignal): Promise<LlmSuccess> {
    for (;;) {
      if (this.requestFailure) throw this.requestFailure
      // 每次尝试前读取当前渠道设置：网页保存新配置后，进行中的流程从下一次尝试起生效。
      const settings = this.runtime.modelNow()
      const transport = this.runtime.transportNow(settings)
      const limiter = this.runtime.limiterNow(settings)
      this.research?.checkRequest(requestKey)
      try {
        await this.waiting.wait(async () => limiter.acquire(signal, (ms, detail) => {
          const message = detail.reason === 'local-rate-limit'
            ? `按共享队列每分钟 ${detail.requestsPerMinute} 次的设置排队，约 ${Math.ceil(ms / 1000)} 秒后尝试发送请求。`
            : `渠道临时错误后的重试等待，约 ${Math.ceil(ms / 1000)} 秒后再次尝试。`
          this.progress(message)
          this.options.status?.({ phase: 'waiting', message, retryAt: Date.now() + ms, waitReason: detail.reason,
            requestsPerMinute: detail.requestsPerMinute,
            ...(requestKey === this.recoveryStep ? { retry: this.recoveryFailures, maxRetries: MODEL_RECOVERY_LIMITS.retries } : {}) })
        }))
      } catch (error) {
        if (error instanceof ModelRequestQueueError) this.requestFailure = error
        throw error
      }
      signal.throwIfAborted()
      this.research?.startRequest(requestKey)
      this.options.status?.({ phase: 'request', message: requestKey === this.recoveryStep ? '等待结束，正在重新请求模型。' : '正在请求模型，等待回复。' })
      this.modelRequests += 1
      if (this.options.maxModelRequests !== undefined && this.modelRequests > this.options.maxModelRequests) {
        throw new Error(`单阶段超过 ${this.options.maxModelRequests} 次模型请求，停止验收并检查原因`)
      }
      const attemptId = randomUUID()
      const started = Date.now()
      let firstChunkMs: number | undefined
      let firstTextMs: number | undefined
      const observe = this.options.observe
      observe?.({ type: 'attempt-start', sessionId: this.sessionId, attemptId, time: new Date(started).toISOString() })
      const capped: LlmRequest = { ...request,
        maxTokens: outputTokenLimit(settings.contextWindow, Math.min(request.maxTokens ?? 8192, this.chatOptions.maxTokens ?? 8192)) }
      let result: LlmResult
      try {
        result = await transport(capped, signal, (isText) => {
          this.streamTicks++
          if (firstChunkMs === undefined) firstChunkMs = Date.now() - started
          if (isText && firstTextMs === undefined) firstTextMs = Date.now() - started
        })
      } catch (error) {
        // 中止的尝试若已携带用量（流内已报告），仍要计入成本与日志。
        const abortedUsage = (error as { usage?: ReportedUsage } | null)?.usage
        if (abortedUsage) {
          this.account(abortedUsage)
          this.log.appendEvent('assistant/attempt', { usage: abortedUsage })
        }
        observe?.({ type: 'attempt', sessionId: this.sessionId, model: settings.model, attemptId, outcome: 'aborted',
          elapsedMs: Date.now() - started, ...(firstChunkMs !== undefined ? { firstChunkMs } : {}), ...(firstTextMs !== undefined ? { firstTextMs } : {}),
          ...(abortedUsage ? { usage: abortedUsage } : {}) })
        throw error
      }
      if (result.finish !== 'error') {
        observe?.({ type: 'attempt', sessionId: this.sessionId, model: settings.model, attemptId,
          outcome: result.finish === 'length' ? 'length' : 'committed', elapsedMs: Date.now() - started,
          ...(firstChunkMs !== undefined ? { firstChunkMs } : {}), ...(firstTextMs !== undefined ? { firstTextMs } : {}),
          ...(result.usage ? { usage: result.usage } : {}) })
        return result
      }
      const failure: LlmFailure = result.error
      if (result.usage) {
        this.account(result.usage)
        this.log.appendEvent('assistant/attempt', { usage: result.usage })
      }
      observe?.({ type: 'attempt', sessionId: this.sessionId, model: settings.model, attemptId, outcome: 'error', elapsedMs: Date.now() - started,
        ...(firstChunkMs !== undefined ? { firstChunkMs } : {}), ...(firstTextMs !== undefined ? { firstTextMs } : {}),
        ...(result.usage ? { usage: result.usage } : {}) })
      observe?.({ type: 'request-error', sessionId: this.sessionId, time: new Date().toISOString(), failure })
      if (!transientModelFailure(failure)) throw new ModelRequestError(failure.code, failure.message, failure)
      if (requestKey !== this.recoveryStep) { this.recoveryStep = requestKey; this.recoveryFailures = 0 }
      this.recoveryFailures += 1
      let wait: number
      try { wait = await limiter.cooldown(signal, recoveryDelay(failure, this.recoveryFailures)) }
      catch (error) {
        if (error instanceof ModelRequestQueueError) this.requestFailure = error
        throw error
      }
      if (this.recoveryFailures > MODEL_RECOVERY_LIMITS.retries) {
        this.requestFailure = failure.code === 'RATE_LIMIT' ? new ModelRateLimitError(this.recoveryFailures) : new ModelRecoveryError(failure.code, this.recoveryFailures)
        throw this.requestFailure
      }
      const message = `渠道暂时${failure.code === 'RATE_LIMIT' ? '限流（429）' : '不可用'}，第 ${this.recoveryFailures}/${MODEL_RECOVERY_LIMITS.retries} 次恢复：等待至少 ${Math.ceil(wait / 1000)} 秒后自动重试。`
      this.progress(message)
      this.options.status?.({ phase: 'retry', message, code: failure.code, retry: this.recoveryFailures,
        maxRetries: MODEL_RECOVERY_LIMITS.retries, retryAt: Date.now() + wait })
    }
  }

  private async converse(turnKey: string, signal: AbortSignal): Promise<TurnResult> {
    let text = ''
    let step = 0
    try {
      for (;;) {
        step += 1
        const requestKey = `${turnKey}:${step}`
        const tools = await this.advertisedTools(requestKey)
        const request: LlmRequest = { messages: this.apiMessages(), ...(tools.length > 0 ? { tools } : {}) }
        const result = await this.requestModel(requestKey, request, signal)
        if (result.usage) this.account(result.usage)
        if (result.finish === 'length') {
          if (result.usage) this.log.appendEvent('assistant/attempt', { usage: result.usage })
          this.log.appendEvent('turn/end', { reason: { kind: 'max-tokens' } })
          return { text, error: 'max-tokens' }
        }
        if (result.finish === 'tool_calls') {
          const calls = result.toolCalls ?? []
          const assistant: ApiMessage = { role: 'assistant', content: result.text || null,
            tool_calls: calls.map(call => ({ id: call.id || `call-${calls.indexOf(call)}`, type: 'function' as const,
              function: { name: call.function.name, arguments: call.function.arguments } })) }
          this.log.messages.push(assistant)
          if (result.usage) {
            if (result.text) this.log.appendEvent('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: result.text }] }, usage: result.usage })
            else this.log.appendEvent('assistant/attempt', { usage: result.usage })
          } else if (result.text) {
            this.log.appendEvent('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: result.text }] } })
          }
          for (const [index, call] of calls.entries()) {
            const toolCallId = assistant.tool_calls![index].id
            const output = await this.executeTool(call, signal)
            this.log.messages.push({ role: 'tool', tool_call_id: toolCallId, content: output.text })
          }
          this.log.persistMessages()
          continue
        }
        // finish === 'stop'
        if (!result.text.trim()) {
          this.log.appendEvent('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '' }] }, ...(result.usage ? { usage: result.usage } : {}) })
          this.log.appendEvent('turn/end', { reason: { kind: 'completed' } })
          return { text, error: 'empty' }
        }
        this.log.messages.push({ role: 'assistant', content: result.text })
        this.log.persistMessages()
        this.log.appendEvent('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: result.text }] }, ...(result.usage ? { usage: result.usage } : {}) })
        this.log.appendEvent('turn/end', { reason: { kind: 'completed' } })
        return { text: result.text }
      }
    } catch (error) {
      // 恢复耗尽/队列故障/预算错误：保留原始类型，由 ask() 原样抛出。
      if (this.requestFailure) throw error
      if (this.research?.failure) throw error
      // 上下文预算错误是确定性的，重试只会重复同一份超限请求。
      if (error instanceof ContextWindowError) throw error
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        this.log.appendEvent('turn/end', { reason: { kind: 'aborted' } })
        return { text, aborted: true }
      }
      const code = error instanceof ModelRequestError ? error.code : 'MODEL_ERROR'
      const message = error instanceof Error ? error.message : String(error)
      this.log.appendEvent('turn/end', { reason: { kind: 'error', error: { code, message } } })
      return { text, error: `${code}: ${message}` }
    }
  }

  private async runTurn(turnKey: string, controller: AbortController): Promise<TurnResult> {
    const task = this.converse(turnKey, controller.signal)
    this.settled = task.then(() => {}, () => {})
    try {
      await whenIdleOrStalled(() => task.then(() => {}), () => this.log.events.length + this.streamTicks,
        turnTimeoutMs(this.runtime.env), 1000, this.deadline,
        { milliseconds: this.waiting.waitingMs, limitMs: this.maxWaitMs })
    } catch (error) {
      // 看门狗超时（或等待超限）：先中止在途请求并等它收敛，禁止在未收敛的会话上叠加重试。
      controller.abort(error)
      try { await whenIdleWithin(() => this.settled, 5000) } catch { /* 已收敛或超时 */ }
      throw error
    }
    return await task
  }

  async ask(prompt: string): Promise<string> {
    this.turnUsage = { inputTokens: 0, outputTokens: 0 }
    this.turn += 1
    // 用户消息每回合只落盘一次：重试复用同一段历史，不能在会话里追加第二份相同提问。
    this.appendUser(prompt)
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const external = this.options.signal
      const relay = () => controller.abort(external?.reason ?? new Error('流程已停止'))
      if (external) {
        if (external.aborted) relay()
        else external.addEventListener('abort', relay, { once: true })
      }
      try {
        const result = await this.runTurn(`T${this.turn}`, controller)
        if (result.aborted) {
          const error = new Error('模型回合已被中止')
          error.name = 'AbortError'
          throw error
        }
        if (result.error === 'max-tokens') throw new OutputLimitError()
        if (result.error === 'empty') throw new Error('模型回合结束但没有返回正文')
        if (result.error !== undefined) throw new Error(result.error)
        return result.text
      } catch (error) {
        lastError = error
        if (this.requestFailure) throw this.requestFailure
        if (this.research?.failure) throw this.research.failure
        if (error instanceof TurnTimeoutError || error instanceof ModelWaitTimeoutError) {
          controller.abort(error)
          try { await whenIdleWithin(() => this.settled, 5000) } catch { /* 已收敛或超时 */ }
          throw error
        }
        if ((error instanceof Error && error.name === 'AbortError') || error instanceof ContextWindowError || permanentModelError(error)
          || (error instanceof OutputLimitError && this.chatOptions.retryOnLength === false)) throw error
        if (attempt === 0) {
          this.options.err?.(`tutor: 模型回合异常（${error instanceof Error ? error.message : String(error)}），重试一次…\n`)
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      } finally {
        if (external) external.removeEventListener('abort', relay)
      }
    }
    throw new Error(`模型回合失败——${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  lastTurnUsage(): UsageSample {
    return { ...this.turnUsage }
  }

  totalUsage(): UsageSample {
    return { ...this.total }
  }

  lastReply(): string {
    let text = ''
    for (const event of this.log.events) {
      if (event.type !== 'assistant/message') continue
      const message = (event.data as { message?: { content?: { type: string; text?: string }[] } } | undefined)?.message
      const joined = (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (joined !== '') text = joined
    }
    return text
  }

  lastReplySeq(): number | null {
    for (let index = this.log.events.length - 1; index >= 0; index--) {
      const event = this.log.events[index]
      if (event.type !== 'assistant/message') continue
      const message = (event.data as { message?: { content?: { type: string; text?: string }[] } } | undefined)?.message
      if ((message?.content ?? []).some(block => block.type === 'text' && block.text)) return event.seq
    }
    return null
  }

  async flush(): Promise<void> {
    const cache = this.toolsCache
    this.toolsCache = undefined
    try { await cache?.tools.close() } catch { /* 连接已断开 */ }
    try { await this.options.researchTools?.close() } catch { /* 测试替身 */ }
  }
}
