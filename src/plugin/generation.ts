import { extractProfileJson } from '../core/interview.ts'
import type { AgentChat } from './agent-chat.ts'

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string }

export function parseJsonBlock(text: string): ParseResult {
  const data = extractProfileJson(text)
  if (data === null) return { ok: false, error: '未找到 JSON 代码块' }
  return { ok: true, value: data }
}

export function trySchema(schema: (data: unknown) => unknown, data: unknown): ParseResult {
  try {
    return { ok: true, value: schema(data) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.replace(/\n+/g, ' ') : String(error) }
  }
}

export async function generateTurn(chat: AgentChat, prompt: string, parse: (text: string) => ParseResult): Promise<unknown> {
  let reply = await chat.ask(prompt)
  for (let attempt = 0; attempt < 3; attempt++) {
    const parsed = parse(reply)
    if (parsed.ok) return parsed.value
    reply = await chat.ask(`你输出的 JSON 校验失败：${parsed.error}。请修正后重新输出完整 JSON 代码块，不要输出其他内容。`)
  }
  throw new Error('多次生成仍未通过校验，中止')
}
