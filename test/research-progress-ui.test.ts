import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

function fixture() {
  const parts = Object.fromEntries(['heading', 'counts', 'bar', 'node', 'message', 'time', 'link'].map(name =>
    [name, { dataset: { part: name }, textContent: '', value: 0, max: 1, href: '' }]))
  const root = { hidden: true, innerHTML: '', classList: { add() {} }, querySelectorAll: () => Object.values(parts) }
  const flow = { flowId: 'r1', kind: 'research', courseId: 'agent5', status: 'running' }
  const saved = { completed: 6, total: 39, verified: 2, pending: 33 }
  const requests: string[] = []
  const context = vm.createContext({ AbortSignal, encodeURIComponent, setInterval: () => 1,
    fetch: async (url: string) => {
      requests.push(url)
      return { ok: true, json: async () => url === '/rpc' ? { result: { research: { ...saved } } } : { active: flow } }
    }, EventSource: class { close() {} },
  })
  vm.runInContext(fs.readFileSync(new URL('../static/research-progress.js', import.meta.url), 'utf8') + '\nglobalThis.Client = TutorResearchProgress', context)
  const client = new context.Client(root)
  client.course = 'agent5'
  return { client, parts, root, requests, flow, saved }
}

it('进度只采用已保存课程计数，分片日志可显示等待但不能把它变成教研完成', async () => {
  const { client, parts, root, requests } = fixture()
  await client.refresh()
  const event = '@@tutor-progress ' + JSON.stringify({ phase: 'waiting', node: 'topic', title: '当前课题',
    message: '渠道暂时限流，等待后自动继续', at: Date.now(), retry: 2, maxRetries: 8, retryAt: Date.now() + 120_000, completed: 39, total: 39 }) + '\n'
  client.feed('模型正文和私有推理不属于状态\n' + event.slice(0, 30))
  client.feed(event.slice(30))
  client.render()
  assert.equal(root.hidden, false)
  assert.match(parts.counts.textContent, /6\/39/)
  assert.equal(parts.bar.value, 6)
  assert.match(parts.time.textContent, /第 2\/8 次恢复/)
  assert.match(parts.message.textContent, /等待后自动继续/)
  assert.ok(Object.values(parts).every(part => !part.textContent.includes('私有推理')))
  assert.ok(!requests.some(url => url === '/flow/start' || url === '/flow/input'))
})

it('不会订阅其他课程的流程，连接中断和结束时清楚显示真实状态', async () => {
  const { client, flow, root, parts } = fixture()
  flow.courseId = 'agent6'
  await client.refresh()
  assert.equal(root.hidden, true)
  flow.courseId = 'agent5'
  await client.refresh()
  client.disconnected = true
  client.render()
  assert.match(parts.heading.textContent, /连接中断/)
  client.disconnected = false
  client.flow.status = 'failed'
  client.render()
  assert.match(parts.heading.textContent, /已暂停/)
  assert.equal(parts.bar.value, 6)
})
