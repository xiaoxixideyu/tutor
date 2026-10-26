// OpenAI 兼容 Chat Completions 客户端：流式 SSE、工具调用、用量映射与错误分类。
// 与网关的传输细节集中在这里；上层（chat.ts）只关心结构化的 LlmResult 与 LlmFailure。
import type { ReportedUsage } from '../core/cost.ts'

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ApiToolCall[]
  tool_call_id?: string
}

export interface ApiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ApiToolDef {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface LlmRequest {
  messages: ApiMessage[]
  maxTokens?: number
  tools?: ApiToolDef[]
}

export interface LlmFailure {
  code: string
  message: string
  status?: number
  providerRetryAfterMs?: number
}

export type LlmResult =
  | { finish: 'stop' | 'tool_calls' | 'length'; text: string; toolCalls?: ApiToolCall[]; usage?: ReportedUsage }
  | { finish: 'error'; error: LlmFailure; usage?: ReportedUsage }

// onChunk 在每个流式帧到达时调用；参数为 true 表示正文文本增量（用于首字延迟诊断）。
export type LlmTransport = (request: LlmRequest, signal: AbortSignal, onChunk: (text: boolean) => void) => Promise<LlmResult>

export interface LlmTransportOptions {
  baseUrl: string
  apiKey: string
  model: string
  thinking: 'default' | 'on' | 'off'
  fetchImpl?: typeof fetch
}

// OpenAI/DeepSeek 的缓存字段互不重叠：prompt_tokens 含缓存命中/写入，input 只保留未缓存部分。
// 与 Harness 的计数语义一致（normalizeUsage 再把缓存加回总输入）。
export function mapOpenAiUsage(raw: unknown): ReportedUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, unknown>
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
  if (prompt === undefined || output === undefined) return undefined
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>
  const cacheRead = firstNumber([details.cached_tokens, usage.prompt_cache_hit_tokens, usage.cached_tokens]) ?? 0
  const cacheWrite = firstNumber([details.cache_write_tokens]) ?? 0
  const input = Math.max(0, prompt - cacheRead - cacheWrite)
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

function firstNumber(values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

export function parseRetryAfterMs(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms')
  if (ms !== null) {
    const parsed = Number(ms)
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 1_800_000)
  }
  const seconds = headers.get('retry-after')
  if (seconds !== null) {
    const parsed = Number(seconds)
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed * 1000, 1_800_000)
  }
  return undefined
}

export function classifyHttpFailure(status: number, body: string, headers?: Headers): LlmFailure {
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 700)
  const message = `${status}: ${detail || '请求失败'}`
  const providerRetryAfterMs = headers ? parseRetryAfterMs(headers) : undefined
  let code: string
  if (/insufficient_quota|billing_hard_limit|credit balance is too low/i.test(detail)) code = 'QUOTA_EXCEEDED'
  else if (status === 401 || status === 403) code = 'AUTH'
  else if (status === 429 || /rate.?limit/i.test(detail)) code = 'RATE_LIMIT'
  else if (status === 413 || status === 400 || status === 422) code = 'INVALID_REQUEST'
  else if (status >= 500) code = 'SERVER'
  else code = 'PI_AI_ERROR'
  return { code, message, status, ...(providerRetryAfterMs !== undefined ? { providerRetryAfterMs } : {}) }
}

export function classifyTransportFailure(error: unknown): LlmFailure {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return { code: 'TIMEOUT', message }
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return { code: 'TIMEOUT', message }
  return { code: 'TRANSPORT', message }
}

interface StreamDelta {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: {
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }[]
}

interface StreamChunk {
  choices?: { delta?: StreamDelta; finish_reason?: string | null; message?: { content?: string | null; tool_calls?: ApiToolCall[] } }[]
  usage?: unknown
  error?: { message?: string; code?: string | number; type?: string }
}

// 推理控制按模型族生效：不同厂商用不同参数名表达"推理强度"。
// - minimax-*：reasoning_effort（minimal < low < medium）。实测该渠道在"服务默认"下会把整份输出预算
//   烧在推理上、正文为空（8192 输出里 8192 是 reasoning），长结构化任务必然失败；因此 default 映射到 low，
//   保证默认设置就能拿到正文。
// - deepseek-*：官方 V4.1 文档的 reasoning_effort 取值为 low/high/max，默认 high；当前网关的
//   deepseek-v4.1-flash 会忽略单独的 thinking:{type}（reasoning_tokens=0），但接受 reasoning_effort。
//   网关的 v 系列/flash 路由在开启推理时同时下发 thinking 与最高档 max，兼容只识别其中一种的实现；
//   官方 chat/reasoner 仍只发 thinking。推理 token 数会因题目和采样波动，不能用来判断档位高低。
// - 其他模型：不加参数，跟随服务默认。
export function thinkingRequestParams(model: string, thinking: 'default' | 'on' | 'off'): Record<string, unknown> {
  if (/^minimax/i.test(model)) {
    const effort = thinking === 'off' ? 'minimal' : thinking === 'on' ? 'medium' : 'low'
    return { reasoning_effort: effort }
  }
  if (/^deepseek/i.test(model)) {
    if (thinking === 'off') return { thinking: { type: 'disabled' } }
    if (thinking === 'on') {
      const gatewayRoute = /^deepseek-v|flash/i.test(model)
      return gatewayRoute ? { thinking: { type: 'enabled' }, reasoning_effort: 'max' } : { thinking: { type: 'enabled' } }
    }
    return {}
  }
  if (thinking === 'on') return { thinking: { type: 'enabled' } }
  if (thinking === 'off') return { thinking: { type: 'disabled' } }
  return {}
}

function buildRequestBody(options: LlmTransportOptions, request: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.tools && request.tools.length > 0) body.tools = request.tools.map(tool => ({ type: 'function', function: tool }))
  Object.assign(body, thinkingRequestParams(options.model, options.thinking))
  return body
}

function parseCompletionBody(text: string): LlmResult | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  const chunk = parsed as StreamChunk
  if (chunk.error) return { finish: 'error', error: { code: 'PI_AI_ERROR', message: chunk.error.message ?? '网关返回错误' } }
  const choice = chunk.choices?.[0]
  if (!choice) return null
  const message = choice.message ?? { content: choice.delta?.content }
  const finishReason = choice.finish_reason ?? null
  const toolCalls = message.tool_calls?.length ? message.tool_calls : undefined
  const usage = mapOpenAiUsage(chunk.usage)
  if (finishReason === 'length') return { finish: 'length', text: message.content ?? '', ...(usage ? { usage } : {}) }
  if (toolCalls) return { finish: 'tool_calls', text: message.content ?? '', toolCalls, ...(usage ? { usage } : {}) }
  return { finish: 'stop', text: message.content ?? '', ...(usage ? { usage } : {}) }
}

export function openaiTransport(options: LlmTransportOptions): LlmTransport {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${options.apiKey}`,
    accept: 'text/event-stream',
  }
  return async (request, signal, onChunk) => {
    let response: Response
    try {
      response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(buildRequestBody(options, request)), signal })
    } catch (error) {
      if (signal.aborted) throw error
      return { finish: 'error', error: classifyTransportFailure(error) }
    }
    if (!response.ok) {
      let detail = ''
      try { detail = await response.text() } catch { /* 响应体不可读时只保留状态码 */ }
      return { finish: 'error', error: classifyHttpFailure(response.status, detail, response.headers) }
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const result = parseCompletionBody(await response.text())
      return result ?? { finish: 'error', error: { code: 'TRANSPORT', message: '网关返回了无法解析的 JSON 响应' } }
    }
    if (!response.body) return { finish: 'error', error: { code: 'TRANSPORT', message: '网关响应没有正文流' } }

    let text = ''
    let usage: ReportedUsage | undefined
    let finishReason: string | null = null
    let failure: LlmFailure | undefined
    const toolCalls: ApiToolCall[] = []
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    const consumeLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const payload = trimmed.slice('data:'.length).trim()
      if (payload === '' || payload === '[DONE]') return
      let chunk: StreamChunk
      try { chunk = JSON.parse(payload) as StreamChunk } catch { return }
      if (chunk.error) {
        failure = { code: 'PI_AI_ERROR', message: chunk.error.message ?? '流式响应中返回错误' }
        return
      }
      const mapped = mapOpenAiUsage(chunk.usage)
      if (mapped) usage = mapped
      const choice = chunk.choices?.[0]
      if (!choice) return
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason
      const delta = choice.delta
      if (!delta) return
      if (typeof delta.content === 'string' && delta.content !== '') {
        text += delta.content
        onChunk(true)
      } else if (typeof delta.reasoning_content === 'string' || typeof delta.reasoning === 'string') {
        onChunk(false)
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? toolCalls.length
        while (toolCalls.length <= index) toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
        const target = toolCalls[index]
        if (call.id) target.id = call.id
        if (call.function?.name) target.function.name += call.function.name
        if (call.function?.arguments) target.function.arguments += call.function.arguments
        onChunk(false)
      }
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        onChunk(false)
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          consumeLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
        }
      }
      if (buffer.trim() !== '') consumeLine(buffer)
    } catch (error) {
      if (signal.aborted) throw error
      return { finish: 'error', error: classifyTransportFailure(error) }
    }
    if (failure) return { finish: 'error', error: failure }
    if (finishReason === 'content_filter') return { finish: 'error', error: { code: 'PI_AI_ERROR', message: '网关按内容策略拦截了本次回复（content_filter）' } }
    const completeCalls = toolCalls.filter(call => call.id !== '' || call.function.name !== '')
    if (finishReason === 'length') return { finish: 'length', text, ...(usage ? { usage } : {}) }
    if (finishReason === 'tool_calls' || finishReason === 'function_call' || completeCalls.length > 0) {
      // 网关声明 tool_calls 却没有给出任何有效调用时不能继续循环：
      // 上层会把它当成"模型要求调用工具"，导致空转直到超时。
      if (completeCalls.length === 0) {
        return { finish: 'error', error: { code: 'PI_AI_ERROR', message: '模型返回 tool_calls 但没有可执行的工具调用' }, ...(usage ? { usage } : {}) }
      }
      return { finish: 'tool_calls', text, toolCalls: completeCalls, ...(usage ? { usage } : {}) }
    }
    return { finish: 'stop', text, ...(usage ? { usage } : {}) }
  }
}
