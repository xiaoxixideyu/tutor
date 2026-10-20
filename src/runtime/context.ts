// 上下文预算：按字符估算 token，按“回合”裁剪历史。
// 目标不是精确计费，而是在接近渠道窗口时仍能保留课程计划、上一回合和当前输入。
import type { ApiMessage } from './llm.ts'

const MESSAGE_OVERHEAD_TOKENS = 4
const DEFAULT_CONTEXT_WINDOW = 262144
const PROMPT_SAFETY_TOKENS = 512
const MIN_OUTPUT_TOKENS = 256

export class ContextWindowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextWindowError'
  }
}

export function normalizeContextWindow(value: number): number {
  return Number.isFinite(value) && value >= 1024 ? Math.floor(value) : DEFAULT_CONTEXT_WINDOW
}

// CJK 字符按 1 token 估算，其余字符按 4 字符/token 估算；偏保守，避免中文长文低估。
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    tokens += code >= 0x2e80 ? 1 : 0.25
  }
  return Math.ceil(tokens)
}

export function estimateMessageTokens(message: ApiMessage): number {
  const content = message.content ?? ''
  const toolCalls = message.tool_calls ? JSON.stringify(message.tool_calls) : ''
  return estimateTokens(content) + estimateTokens(toolCalls) + MESSAGE_OVERHEAD_TOKENS
}

export function outputTokenLimit(contextWindow: number, requested = 8192): number {
  const window = normalizeContextWindow(contextWindow)
  const wanted = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 8192
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(wanted, 8192, Math.floor(window * 0.3), window - 1024))
}

export interface FittedHistory {
  messages: ApiMessage[]
  omitted: number
}

// 把消息按 user 消息切成回合，始终保留当前回合；再尽量保留上一回合、首回合（课程计划/调研任务）。
// 丢弃中间回合时由调用方在 system 里追加一句省略说明，避免模型把跳过的对话当成完整事实。
export function fitHistory(systemTokens: number, messages: ApiMessage[], budget: number): FittedHistory {
  if (messages.length === 0) return { messages: [], omitted: 0 }
  if (systemTokens > budget) {
    throw new ContextWindowError(`系统提示词约 ${systemTokens} tokens，已超过当前上下文预算 ${budget}；请增大模型上下文长度`)
  }
  const segments: ApiMessage[][] = []
  for (const message of messages) {
    if (segments.length === 0 || message.role === 'user') segments.push([message])
    else segments[segments.length - 1].push(message)
  }
  const costs = segments.map((segment) => segment.reduce((sum, message) => sum + estimateMessageTokens(message), 0))
  const keep = new Set<number>()
  let used = systemTokens
  const keepSegment = (index: number): boolean => {
    if (used + costs[index] > budget) return false
    keep.add(index)
    used += costs[index]
    return true
  }
  // 当前回合必须在；否则模型看不到本次输入。
  if (!keepSegment(segments.length - 1)) {
    throw new ContextWindowError(`当前输入约 ${costs[segments.length - 1]} tokens，超过当前上下文预算 ${budget}；请缩小本次输入或增大模型上下文长度`)
  }
  // 优先保留上一回合，维持对话连续性。
  if (segments.length >= 2) keepSegment(segments.length - 2)
  // 再尝试保留首回合（课程计划/调研任务）；预算不够时它会先被牺牲。
  if (segments.length >= 2 && !keep.has(0)) keepSegment(0)
  // 剩余的旧回合从近到远填补预算。
  for (let index = segments.length - 1; index >= 0; index--) {
    if (!keep.has(index)) keepSegment(index)
  }
  const kept = segments.flatMap((segment, index) => keep.has(index) ? segment : [])
  return { messages: kept, omitted: messages.length - kept.length }
}
