// 联网抓取的地址安全：只允许公网 http(s)，逐跳校验重定向，并限制响应体大小。
// DNS 解析后再检查所有地址，降低模型/网页把抓取引向本机或云元数据地址的风险。
// 说明：这是本地单用户应用的防护层，不是完整的网络沙箱；DNS rebinding 仍需系统级隔离才能彻底消除。
import { promises as dns } from 'node:dns'
import net from 'node:net'

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`响应超过 ${Math.round(limit / 1024)}KB 上限`)
    this.name = 'ResponseTooLargeError'
  }
}

function privateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

function privateIPv6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('::ffff:')) return privateIPv4(lower.slice('::ffff:'.length))
  // IPv4-compatible（::/96，如 ::127.0.0.1、::7f00:1）同样指向本机/内网，必须拦截。
  if (lower.startsWith('::')) return true
  // fc00::/7 唯一本地地址；fe00::/9 链路本地与站点本地；ff00::/8 组播。
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe')
    || lower.startsWith('ff')
}

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return privateIPv4(address)
  if (family === 6) return privateIPv6(address)
  return true
}

type Lookup = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>

export async function assertPublicUrl(url: URL, lookup: Lookup = dns.lookup as unknown as Lookup): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new UnsafeUrlError('只支持 http(s) 地址')
  if (url.username || url.password) throw new UnsafeUrlError('地址不能包含账号或密码')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw new UnsafeUrlError('不能访问本机地址')
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new UnsafeUrlError('不能访问内网、回环或保留地址')
    return
  }
  let addresses: { address: string; family: number }[]
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new UnsafeUrlError(`解析主机名 ${hostname} 超时`)), 5_000)
      }),
    ])
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error
    throw new UnsafeUrlError(`无法解析主机名 ${hostname}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new UnsafeUrlError('目标主机解析到内网、回环或保留地址')
  }
}

export interface SafeFetchOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  lookup?: Lookup
  maxRedirects?: number
}

// 逐跳校验重定向，避免第一次公网地址把请求重定向到 127.0.0.1 / 169.254.169.254。
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<{ response: Response; url: URL }> {
  let current: URL
  try { current = new URL(rawUrl) } catch { throw new UnsafeUrlError('URL 非法：需要完整的 http(s) 链接') }
  const fetchImpl = options.fetchImpl ?? fetch
  const maxRedirects = options.maxRedirects ?? 5
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    await assertPublicUrl(current, options.lookup)
    const response = await fetchImpl(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: options.signal,
      headers: options.headers,
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current }
    const location = response.headers.get('location')
    if (!location) return { response, url: current }
    await response.body?.cancel()
    try { current = new URL(location, current) } catch { throw new UnsafeUrlError('重定向地址非法') }
  }
  throw new UnsafeUrlError('重定向次数过多')
}

export async function readBodyLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new ResponseTooLargeError(maxBytes)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ResponseTooLargeError(maxBytes)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}
