import fs from 'node:fs'
import { channel } from 'node:diagnostics_channel'

// 仅在显式指定诊断文件时启用。请求正文、响应正文、URL 和认证头均不进入记录。
const output = process.env.TUTOR_CHANNEL_TRACE_FILE
const configured = process.env.TUTOR_LLM_BASE_URL
if (output && configured) {
  const url = new URL(configured)
  const expectedPath = url.pathname.replace(/\/+$/, '') + '/chat/completions'
  const requests = new WeakMap<object, string>()
  let count = 0
  let unavailable = false
  const write = (value: Record<string, unknown>) => {
    if (unavailable) return
    try { fs.appendFileSync(output, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + '\n', { mode: 0o600 }) }
    catch { unavailable = true; process.stderr.write('tutor: HTTP 状态记录无法保存；课程保存不受影响，请检查诊断目录。\n') }
  }
  type Request = { origin: unknown; path: string; method: string }
  channel('undici:request:create').subscribe(value => {
    const { request } = value as { request: Request }
    if (String(request.origin) !== url.origin || request.path.split('?')[0] !== expectedPath || request.method !== 'POST') return
    const id = `${process.pid}:${++count}`
    requests.set(request, id)
    write({ event: 'request', id })
  })
  channel('undici:request:headers').subscribe(value => {
    const { request, response } = value as { request: Request; response: { statusCode: number; headers: unknown[] } }
    const id = requests.get(request)
    if (!id) return
    const headers: Record<string, string> = {}
    for (let i = 0; i < response.headers.length; i += 2) {
      const key = String(response.headers[i]).toLowerCase()
      if (['retry-after', 'retry-after-ms', 'x-request-id', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests'].includes(key)) {
        headers[key] = String(response.headers[i + 1])
      }
    }
    write({ event: 'response', id, status: response.statusCode, headers })
  })
  channel('undici:request:error').subscribe(value => {
    const { request, error } = value as { request: Request; error?: { code?: string; name?: string } }
    const id = requests.get(request)
    const code = error?.code ?? error?.name ?? 'unknown'
    if (id) write({ event: 'error', id, code: /^[\w-]{1,80}$/.test(code) ? code : 'unknown' })
  })
}
