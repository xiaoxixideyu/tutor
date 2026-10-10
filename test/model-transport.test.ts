import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'

it('实际 HTTP 观测仅记录指定模型请求元数据，不记录地址、认证、请求或回复正文', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-transport-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '61', 'x-request-id': 'fixture-id', 'authorization': 'PRIVATE_RESPONSE_HEADER' })
    res.end(JSON.stringify({ message: 'PRIVATE_RESPONSE_BODY' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const trace = path.join(root, 'transport.jsonl')
  const child = spawn(process.execPath, ['--import', new URL('../src/core/model-transport.ts', import.meta.url).href, '--input-type=module', '--eval',
    "await fetch(process.env.TUTOR_LLM_BASE_URL + '/models'); await fetch(process.env.TUTOR_LLM_BASE_URL + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer PRIVATE_API_KEY' }, body: 'PRIVATE_REQUEST_BODY' })"],
  { env: { ...process.env, TUTOR_LLM_BASE_URL: base, TUTOR_CHANNEL_TRACE_FILE: trace }, stdio: 'pipe' })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, stderr)
  const raw = fs.readFileSync(trace, 'utf8')
  const events = raw.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.event), ['request', 'response'])
  assert.equal(events[1].status, 429)
  assert.deepEqual(events[1].headers, { 'retry-after': '61', 'x-request-id': 'fixture-id' })
  assert.ok(!raw.includes('PRIVATE_') && !raw.includes(base))
  assert.equal(fs.statSync(trace).mode & 0o777, 0o600)
})
