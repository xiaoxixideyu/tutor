// 教研工具：MCP searchix 搜索（官方 SDK，streamable-http）与 web_fetch 正文抓取。
// 预算/截断由 ResearchBudget 负责；这里只做单次调用与结果文本化。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ApiToolDef } from './llm.ts'
import { readBodyLimited, safeFetch, ResponseTooLargeError, UnsafeUrlError } from './url-safety.ts'

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

// failure 区分"模型把参数写错"与"服务本身不可用"：前者可自纠，不应耗尽本知识点的预算。
// auth 是 401/403 这类密钥问题，重试没有意义，需要直接停用并提示检查 Token。
export interface ToolResult { text: string; isError: boolean; failure?: 'argument' | 'service' | 'auth' }

// 搜索服务的参数校验错误（如 Tavily 的 "Invalid value for include_answer"）属可纠正失败。
const ARGUMENT_ERROR_PATTERN = /(Invalid value for|Field required|Input should be|validation error|not a valid|is not of type|missing required|Unprocessable)/i
// 密钥无效或权限不足：Exa 返回 "Invalid API key"，Tavily 网关返回 401/403。
const AUTH_ERROR_PATTERN = /(\b401\b|\b403\b|unauthori[sz]ed|invalid api key|forbidden|authentication failed)/i

export function classifyToolError(text: string): 'argument' | 'service' | 'auth' {
  if (AUTH_ERROR_PATTERN.test(text)) return 'auth'
  return ARGUMENT_ERROR_PATTERN.test(text) ? 'argument' : 'service'
}

type JsonSchema = Record<string, unknown>

function schemaType(schema: JsonSchema | undefined): string | undefined {
  if (!schema) return undefined
  const type = schema.type
  if (typeof type === 'string') return type
  if (Array.isArray(type)) {
    const found = type.find(item => typeof item === 'string' && item !== 'null')
    return typeof found === 'string' ? found : undefined
  }
  if (schema.properties || schema.required) return 'object'
  return undefined
}

function inEnum(value: unknown, schema: JsonSchema): boolean {
  return Array.isArray(schema.enum) && schema.enum.some(item => item === value)
}

// 值是否已经符合该 schema 的类型（用于 oneOf 分支选择：先接受本来就正确的值，再尝试归一）。
function matchesType(value: unknown, schema: JsonSchema): boolean {
  if (inEnum(value, schema)) return true
  const type = schemaType(schema)
  if (!type) return !Array.isArray(schema.enum)
  switch (type) {
    case 'boolean': return typeof value === 'boolean'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'string': return Array.isArray(schema.enum) ? false : typeof value === 'string'
    case 'array': return Array.isArray(value)
    case 'object': return typeof value === 'object' && !Array.isArray(value)
    default: return true
  }
}

// 弱模型常把布尔和数字写成字符串（"false"、"5"）。按 schema 归一后再发，
// 比让服务端报错、再吃掉一次搜索预算要划算。
function coerceValue(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema || value === null || value === undefined) return value
  if (inEnum(value, schema)) return value
  // Tavily 的 include_answer 就是 oneOf: [boolean, enum] 这种形状，没有顶层 type；
  // 逐个分支试归一，第一个能改变值的分支胜出，枚举值保持原样。
  const branches = [...(Array.isArray(schema.oneOf) ? schema.oneOf : []), ...(Array.isArray(schema.anyOf) ? schema.anyOf : [])] as JsonSchema[]
  if (branches.length > 0) {
    if (branches.some(branch => matchesType(value, branch))) return value
    for (const branch of branches) {
      const next = coerceValue(value, branch)
      if (next !== value) return next
    }
    return value
  }
  switch (schemaType(schema)) {
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') {
        const text = value.trim().toLowerCase()
        if (text === 'true' || text === '1' || text === 'yes') return true
        if (text === 'false' || text === '0' || text === 'no') return false
      }
      if (value === 1 || value === 0) return value === 1
      return value
    }
    case 'integer':
    case 'number': {
      if (typeof value === 'number') return value
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
      return value
    }
    case 'string': {
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return value
    }
    case 'array': {
      let items: unknown = value
      if (typeof value === 'string') {
        const text = value.trim()
        if (text.startsWith('[')) { try { items = JSON.parse(text) } catch { items = [value] } }
        else if (text !== '') items = [value]
      }
      if (!Array.isArray(items)) return items
      const itemSchema = schema.items as JsonSchema | undefined
      return items.map(item => coerceValue(item, itemSchema))
    }
    case 'object': {
      let entries: unknown = value
      if (typeof value === 'string') {
        const text = value.trim()
        if (!text.startsWith('{')) return value
        try { entries = JSON.parse(text) } catch { return value }
      }
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return entries
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>
      const next: Record<string, unknown> = { ...(entries as Record<string, unknown>) }
      for (const [key, item] of Object.entries(next)) next[key] = coerceValue(item, properties[key])
      return next
    }
    default:
      return value
  }
}

export function coerceArguments(args: Record<string, unknown>, schema: JsonSchema | undefined): Record<string, unknown> {
  const properties = (schema?.properties ?? undefined) as Record<string, JsonSchema> | undefined
  if (!properties) return args
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) next[key] = coerceValue(value, properties[key])
  return next
}

// 归一之后仍然类型不符的字段，直接告诉模型期望类型，不再白跑一次网络请求。
export function argumentMismatches(args: Record<string, unknown>, schema: JsonSchema | undefined): string[] {
  const properties = (schema?.properties ?? undefined) as Record<string, JsonSchema> | undefined
  if (!properties) return []
  const mismatches: string[] = []
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key]
    if (!property || value === null || value === undefined || inEnum(value, property)) continue
    if (property.oneOf || property.anyOf || property.allOf || property.$ref) continue
    const type = schemaType(property)
    if (!type) continue
    if (matchesType(value, property)) continue
    const actual = Array.isArray(value) ? 'array' : typeof value
    mismatches.push(`${key} 需要 ${type}，收到 ${actual}（${JSON.stringify(value).slice(0, 60)}）`)
  }
  return mismatches
}

export async function webFetch(url: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ToolResult> {
  let target: URL
  try { target = new URL(String(url)) } catch { return { text: 'URL 非法：需要完整的 http(s) 链接', isError: true } }
  if (!['http:', 'https:'].includes(target.protocol)) return { text: 'URL 非法：只支持 http(s)', isError: true }
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  try {
    // safeFetch 会逐跳校验重定向，拒绝本机/内网/云元数据地址。
    const { response, url: finalUrl } = await safeFetch(target.toString(), {
      signal: combined,
      fetchImpl,
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'user-agent': 'tutor/0.1 (local study agent)' },
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { text: `抓取失败：HTTP ${response.status}`, isError: true }
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    const buffer = await readBodyLimited(response, FETCH_BYTES_LIMIT)
    const raw = buffer.toString('utf8')
    const text = contentType.includes('html') ? htmlToText(raw) : raw
    const trimmed = text.slice(0, FETCH_TEXT_LIMIT)
    if (!trimmed) return { text: '页面没有可读正文', isError: true }
    return { text: `来源 ${finalUrl.toString()}\n\n${trimmed}`, isError: false }
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof ResponseTooLargeError) return { text: `页面过大（超过 ${Math.round(FETCH_BYTES_LIMIT / 1024)}KB），未读取`, isError: true }
    if (error instanceof UnsafeUrlError) return { text: `抓取失败：${error.message}`, isError: true }
    return { text: `抓取失败：${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}

export interface ResearchTools {
  definitions(): Promise<ApiToolDef[]>
  call(name: string, argsJson: string, signal: AbortSignal): Promise<ToolResult>
  close(): Promise<void>
}

export interface SearchSettings {
  url: string
  token: string
}

// Exa 官方文档要求 x-api-key，Tavily 网关用 Bearer；同时发送两个头互不干扰。
export function searchHeaders(url: string, token: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  try {
    if (/(^|\.)exa\.ai$/i.test(new URL(url).hostname)) headers['x-api-key'] = token
  } catch { /* 地址在配置层已校验；解析失败时只发 Bearer */ }
  return headers
}

// 从环境变量解析搜索服务（网页保存的配置会映射到这两个变量，优先于 .env；同名时以传入 env 为准）。
export function searchSettingsFromEnv(env: NodeJS.ProcessEnv): SearchSettings | undefined {
  const url = env.TUTOR_MCP_SEARCH_URL
  const token = env.TUTOR_MCP_SEARCH_TOKEN
  return url && token ? { url, token } : undefined
}

// searchix / Tavily Hikari 等搜索服务：MCP over HTTP，延迟连接；
// 连接失败时不暴露搜索工具（web_fetch 仍可用），不使整个流程失败。
export function createResearchTools(settings: SearchSettings, onNotice: (message: string) => void = () => {}): ResearchTools {
  const url = settings.url
  const token = settings.token
  let client: Client | undefined
  let definitions: ApiToolDef[] | undefined
  let schemas: Map<string, JsonSchema> | undefined
  let failed = false
  let connecting: Promise<void> | undefined

  const connect = async (): Promise<void> => {
    if (client || failed || !url || !token) { if (!url || !token) failed = true; return }
    connecting ??= (async () => {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: searchHeaders(url, token) },
        })
        const next = new Client({ name: 'tutor', version: '0.1.0' })
        await next.connect(transport)
        const listed = await next.listTools()
        client = next
        schemas = new Map(listed.tools.map(tool => [tool.name, tool.inputSchema as JsonSchema]))
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
      if (!client) return { text: '搜索服务不可用，请使用 web_fetch 或依据已有资料收束。', isError: true, failure: 'service' }
      let args: Record<string, unknown>
      try { args = argsJson.trim() === '' ? {} : JSON.parse(argsJson) as Record<string, unknown> }
      catch { return { text: '工具参数不是合法 JSON，请重新调用（未计入预算）', isError: true, failure: 'argument' } }
      const bare = name.slice(MCP_SEARCH_PREFIX.length)
      const schema = schemas?.get(bare)
      const coerced = coerceArguments(args, schema)
      const mismatches = argumentMismatches(coerced, schema)
      if (mismatches.length > 0) {
        return { text: `工具参数类型不符，未发出请求（未计入预算）：${mismatches.join('；')}。请按 schema 修正后重试。`,
          isError: true, failure: 'argument' }
      }
      try {
        const result = await client.callTool({ name: bare, arguments: coerced }, undefined,
          { timeout: 120_000, signal })
        const blocks: { type?: string; text?: string }[] = Array.isArray(result.content) ? result.content as { type?: string; text?: string }[] : []
        const text = blocks
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text)
          .join('\n')
        if (result.isError !== true) return { text: text || '（无文本结果）', isError: false }
        const failure = classifyToolError(text)
        return { text: failure === 'argument' ? `参数未被搜索服务接受（可修正后重试）：${text}` : text || '（无文本结果）',
          isError: true, failure }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { text: `搜索服务调用失败：${message}`, isError: true, failure: 'service' }
      }
    },
    async close(): Promise<void> {
      try { await client?.close() } catch { /* 连接已断开 */ }
      client = undefined
    },
  }
}
