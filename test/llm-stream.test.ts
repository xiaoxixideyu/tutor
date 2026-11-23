import { it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { openaiTransport } from '../src/runtime/llm.ts'

async function sseServer(t: { after(cb: () => void): void }, body: string, onRequest?: (body: string) => void): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      onRequest?.(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(body)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}/v1`
}

const request = { messages: [{ role: 'user' as const, content: 'hi' }] }

it('SSE 在 finish_reason 之前断流时按传输失败处理，不把半截正文当成完成', async (t) => {
  const baseUrl = await sseServer(t, 'data: {"choices":[{"delta":{"content":"半截正文"}}]}\n\n')
  const transport = openaiTransport({ baseUrl, apiKey: 'fixture-key', model: 'fixture-model', thinking: 'default' })
  const result = await transport(request, new AbortController().signal, () => {})
  assert.equal(result.finish, 'error')
  if (result.finish === 'error') {
    assert.equal(result.error.code, 'TRANSPORT')
    assert.match(result.error.message, /finish_reason/)
  }
})

it('只有 [DONE] 没有 finish_reason 时仍按完整回复处理（兼容中转）', async (t) => {
  const baseUrl = await sseServer(t, [
    'data: {"choices":[{"delta":{"content":"完整正文"}}]}',
    'data: [DONE]',
    '',
  ].join('\n\n'))
  const transport = openaiTransport({ baseUrl, apiKey: 'fixture-key', model: 'fixture-model', thinking: 'default' })
  const result = await transport(request, new AbortController().signal, () => {})
  assert.deepEqual(result, { finish: 'stop', text: '完整正文' })
})

it('SSE 有 finish_reason 和 [DONE] 时正常返回', async (t) => {
  const baseUrl = await sseServer(t, [
    'data: {"choices":[{"delta":{"content":"完整正文"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n'))
  const transport = openaiTransport({ baseUrl, apiKey: 'fixture-key', model: 'fixture-model', thinking: 'default' })
  const result = await transport(request, new AbortController().signal, () => {})
  assert.deepEqual(result, { finish: 'stop', text: '完整正文' })
})

it('SSE reasoning_content 会被保留，供下一次请求回传', async (t) => {
  const baseUrl = await sseServer(t, [
    'data: {"choices":[{"delta":{"reasoning_content":"先核对定义，再给结论。"}}]}',
    'data: {"choices":[{"delta":{"content":"完整正文"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n'))
  const transport = openaiTransport({ baseUrl, apiKey: 'fixture-key', model: 'deepseek-v4.1-flash', thinking: 'max' })
  const result = await transport(request, new AbortController().signal, () => {})
  assert.deepEqual(result, { finish: 'stop', text: '完整正文', reasoningContent: '先核对定义，再给结论。' })
})

it('DeepSeek 思考模式下，旧历史 assistant 缺少 reasoning_content 时补空串', async (t) => {
  let sent = ''
  const baseUrl = await sseServer(t, [
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n'), body => { sent = body })
  const transport = openaiTransport({ baseUrl, apiKey: 'fixture-key', model: 'deepseek-v4.1-flash', thinking: 'max' })
  await transport({ messages: [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '第一轮回答' },
    { role: 'user', content: '第二轮' },
  ] }, new AbortController().signal, () => {})
  const body = JSON.parse(sent) as { messages: { role: string; content: string; reasoning_content?: string }[] }
  assert.deepEqual(body.messages[1], { role: 'assistant', content: '第一轮回答', reasoning_content: '' })
  assert.equal(body.messages[0].reasoning_content, undefined)
  assert.equal(body.messages[2].reasoning_content, undefined)
})
