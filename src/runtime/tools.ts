// 教研工具：MCP searchix 搜索（官方 SDK，streamable-http）与 web_fetch 正文抓取。
// 预算/截断由 ResearchBudget 负责；这里只做单次调用与结果文本化。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ApiToolDef } from './llm.ts'

export const MCP_SEARCH_PREFIX = 'mcp__searchix__'

export const WEB_FETCH_TOOL: ApiToolDef = {
  name: 'web_fetch',
  description: '抓取一个网页的正文并返回纯文本（只读）。参数：{"url": "完整 http(s) 链接"}。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: '要抓取的完整 http(s) 链接' } },
    required: ['url'],
    additionalProperties: false,
  },
}

const FETCH_BYTES_LIMIT = 2_000_000
const FETCH_TEXT_LIMIT = 200_000
const FETCH_TIMEOUT_MS = 20_000

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–',
}

export function htmlToText(html: string): string {
  const withoutHidden = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const withBreaks = withoutHidden.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
  const text = withBreaks.replace(/<[^>]+>/g, ' ')
  const decoded = text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16) || 32)
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10) || 32)
    return ENTITIES[entity.toLowerCase()] ?? raw
  })
  return decoded
    .split('\n')
    .map(line => line.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .trim()
}

export interface ToolResult { text: string; isError: boolean }

export async function webFetch(url: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ToolResult> {
  let target: URL
  try { target = new URL(String(url)) } catch { return { text: 'URL 非法：需要完整的 http(s) 链接', isError: true } }
  if (!['http:', 'https:'].includes(target.protocol)) return { text: 'URL 非法：只支持 http(s)', isError: true }
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  try {
    const response = await fetchImpl(target.toString(), { method: 'GET', redirect: 'follow', signal: combined,
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'user-agent': 'tutor/0.1 (local study agent)' } })
    if (!response.ok) return { text: `抓取失败：HTTP ${response.status}`, isError: true }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > FETCH_BYTES_LIMIT) return { text: `页面过大（超过 ${Math.round(FETCH_BYTES_LIMIT / 1024)}KB），未读取`, isError: true }
    const raw = buffer.toString('utf8')
    const text = contentType.includes('html') ? htmlToText(raw) : raw
    const trimmed = text.slice(0, FETCH_TEXT_LIMIT)
    if (!trimmed) return { text: '页面没有可读正文', isError: true }
    return { text: `来源 ${response.url}\n\n${trimmed}`, isError: false }
  } catch (error) {
    if (signal.aborted) throw error
    return { text: `抓取失败：${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}

export interface ResearchTools {
  definitions(): Promise<ApiToolDef[]>
  call(name: string, argsJson: string, signal: AbortSignal): Promise<ToolResult>
  close(): Promise<void>
}

// searchix 搜索服务：延迟连接；连接失败时不暴露搜索工具（web_fetch 仍可用），不使整个流程失败。
export function createResearchTools(env: NodeJS.ProcessEnv, onNotice: (message: string) => void = () => {}): ResearchTools {
  const url = env.TUTOR_MCP_SEARCH_URL
  const token = env.TUTOR_MCP_SEARCH_TOKEN
  let client: Client | undefined
  let definitions: ApiToolDef[] | undefined
  let failed = false
  let connecting: Promise<void> | undefined

  const connect = async (): Promise<void> => {
    if (client || failed || !url || !token) { if (!url || !token) failed = true; return }
    connecting ??= (async () => {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        })
        const next = new Client({ name: 'tutor', version: '0.1.0' })
        await next.connect(transport)
        const listed = await next.listTools()
        client = next
        definitions = listed.tools.map(tool => ({
          name: `${MCP_SEARCH_PREFIX}${tool.name}`,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.inputSchema as Record<string, unknown>,
        }))
      } catch (error) {
        failed = true
        onNotice(`搜索服务连接失败（${error instanceof Error ? error.message : String(error)}）；本次仅使用正文抓取。`)
      }
    })()
    await connecting
  }

  return {
    async definitions(): Promise<ApiToolDef[]> {
      await connect()
      return definitions ?? []
    },
    async call(name: string, argsJson: string, signal: AbortSignal): Promise<ToolResult> {
      await connect()
      if (!client) return { text: '搜索服务不可用，请使用 web_fetch 或依据已有资料收束。', isError: true }
      let args: Record<string, unknown>
      try { args = argsJson.trim() === '' ? {} : JSON.parse(argsJson) as Record<string, unknown> }
      catch { return { text: '工具参数不是合法 JSON，请重新调用', isError: true } }
      try {
        const result = await client.callTool({ name: name.slice(MCP_SEARCH_PREFIX.length), arguments: args }, undefined,
          { timeout: 120_000, signal })
        const blocks: { type?: string; text?: string }[] = Array.isArray(result.content) ? result.content as { type?: string; text?: string }[] : []
        const text = blocks
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text)
          .join('\n')
        return { text: text || '（无文本结果）', isError: result.isError === true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { text: `搜索服务调用失败：${message}`, isError: true }
      }
    },
    async close(): Promise<void> {
      try { await client?.close() } catch { /* 连接已断开 */ }
      client = undefined
    },
  }
}
