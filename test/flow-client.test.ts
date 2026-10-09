import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

function fixture(responses: unknown[]) {
  const errors: string[] = []
  const requests: { path: string; body?: string }[] = []
  const streams: string[] = []
  const context = vm.createContext({ AbortSignal, encodeURIComponent,
    fetch: async (path: string, options?: { body?: string }) => {
      requests.push({ path, body: options?.body })
      return { ok: true, json: async () => responses.shift() }
    },
    EventSource: class { constructor(url: string) { streams.push(url) } close() {} },
  })
  vm.runInContext(fs.readFileSync(new URL('../static/flow-client.js', import.meta.url), 'utf8') + '\nglobalThis.Client = TutorFlowClient', context)
  const client = new context.Client((message: string) => errors.push(message))
  return { client, errors, requests, streams }
}

it('旧后台缺少协议版本时先报不兼容，不发起新的模型流程', async () => {
  const { client, errors, requests, streams } = fixture([{ active: { kind: 'new', courseId: 'agent5' } }])
  const result = await client.request('/flow/start', { kind: 'new', courseId: 'agent5' })
  assert.equal(result.ok, false)
  assert.match(errors[0], /重启 tutor 服务/)
  assert.equal(requests.length, 1)
  assert.match(requests[0].path, /^\/flow\/state/)
  assert.equal(streams.length, 0)
})

it('旧流程缺少 flowId 时不静默忽略，也不能把输入发送给全局流程', async () => {
  const { client, errors, requests } = fixture([])
  assert.equal(client.attach({ kind: 'new', courseId: 'agent5' }), false)
  assert.match(errors[0], /版本不兼容/)
  assert.equal((await client.request('/flow/input', { line: '用户的回答' })).ok, false)
  assert.equal(requests.length, 0)
})

it('有效协议的流程正常建立 SSE，并将后续输入绑定到同一 flowId', async () => {
  const flow = { flowId: 'flow-1', kind: 'new', courseId: 'agent5', status: 'running' }
  const { client, requests, streams, errors } = fixture([{ protocolVersion: 1, active: null }, { ok: true, ...flow }, { ok: true }])
  assert.equal((await client.request('/flow/start', { kind: 'new', courseId: 'agent5' })).ok, true)
  client.connect()
  assert.equal((await client.request('/flow/input', { line: '学习目标' })).ok, true)
  assert.equal(streams[0], '/flow/stream?flowId=flow-1')
  assert.equal(JSON.parse(requests.at(-1)!.body!).flowId, 'flow-1')
  assert.equal(errors.length, 0)
})
