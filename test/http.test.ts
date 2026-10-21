import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { CourseStore } from '../src/core/store.ts'
import { createTutorServer, type FlowStart } from '../src/server/http.ts'
import type { FlowIO } from '../src/flows/io.ts'
import { approveFixture } from './fixtures/quality.ts'
import { practiceContent } from '../src/core/content-quality.ts'
import type { Profile } from '../src/core/schema.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 确定性流程壳：模拟交互协议（启动行、回显、最终结果、静默或挂起的停止行为）。
function fakeFlow(input: FlowStart, io: FlowIO, broken: boolean): Promise<number> {
  return (async () => {
    if (broken) throw new Error('spawn missing-bin ENOENT')
    io.out(`启动 ${input.kind} ${input.courseId}${input.nodeId ? ' ' + input.nodeId : ''}\n`)
    if (input.kind === 'practice-gen') { io.out('实践任务生成完成\n'); return 0 }
    if (input.kind === 'plan') {
      // 停止后仍不响应：验证宿主在超时后中止并释放活动流程。
      await new Promise<void>(resolve => io.signal.addEventListener('abort', () => resolve(), { once: true }))
      return 1
    }
    io.out(input.kind === 'practice' ? '回车运行测试（r 重跑，q 中止保存进度）> ' : '> ')
    for (;;) {
      const line = await io.readLine()
      if (line === null) return 0
      if (line === '/exit' || line === 'q' || line === 'finish' || line === '') {
        io.out('最终结果：进度已保存\n')
        return 0
      }
      io.out(`收到：${line}\n> `)
    }
  })()
}

async function fixture(t: TestContext, broken = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-http-'))
  const store = new CourseStore(dir)
  const launches: NodeJS.ProcessEnv[] = []
  for (const id of ['alpha', 'beta']) store.create(id, { goal: '测试课程' })
  const modelConfigFile = path.join(dir, 'model-config.json')
  const app = createTutorServer({ root, coursesRoot: dir, modelConfigFile, stopTimeoutMs: 100, today: () => '2026-10-08',
    // 显式清空搜索 MCP：避免仓库 .env 泄漏进测试，保证"未配置搜索"的断言稳定。
    modelEnvironment: { TUTOR_LLM_BASE_URL: 'https://first.invalid/v1', TUTOR_LLM_MODEL: 'deepseek-fixture', TUTOR_LLM_API_KEY: 'fixture-private-key',
      TUTOR_MCP_SEARCH_URL: '', TUTOR_MCP_SEARCH_TOKEN: '' },
    runFlow: (input, io, env) => { launches.push(env); return fakeFlow(input, io, broken) },
  })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const post = async (route: string, value: unknown) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    return { status: res.status, body: await res.json() as any }
  }
  return { base, store, post, launches, modelConfigFile }
}

async function stream(t: TestContext, base: string, flowId: string) {
  const controller = new AbortController()
  const response = await fetch(`${base}/flow/stream?flowId=${flowId}`, { signal: controller.signal })
  assert.equal(response.status, 200)
  const events: any[] = []
  const emitter = new EventEmitter()
  const reader = response.body!.getReader()
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          events.push(JSON.parse(buffer.slice(0, end).replace(/^data: /, '')))
          buffer = buffer.slice(end + 2)
          emitter.emit('event')
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error }
  })()
  t.after(async () => { controller.abort(); await reading })
  const wait = (predicate: (event: any) => boolean): Promise<any> => {
    const found = events.find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { emitter.off('event', check); reject(new Error('等待流程事件超时')) }, 5000)
      const check = () => {
        const event = events.find(predicate)
        if (event) { clearTimeout(timer); emitter.off('event', check); resolve(event) }
      }
      emitter.on('event', check)
    })
  }
  return { events, wait }
}

it('自定义课程目录、网页资源与坏请求均走真实 HTTP', async (t) => {
  const { base, post } = await fixture(t)
  for (const page of ['/', '/wizard.html', '/lesson.html', '/exam.html', '/practice.html', '/review.html', '/flow-client.js', '/settings.html', '/settings.js', '/ui/dom.js', '/ui/rpc.js', '/ui/chat.js', '/ui/chat.css']) {
    assert.equal((await fetch(base + page)).status, 200)
  }
  const list = await post('/rpc', { method: 'listCourses', id: 1 })
  assert.deepEqual(list.body.result.map((c: any) => c.id), ['alpha', 'beta'])
  assert.equal((await post('/rpc', null)).body.error.code, -32600)
  assert.equal((await post('/flow/start', null)).status, 400)
  assert.equal((await post('/flow/start', { kind: 'learn', courseId: 'alpha' })).body.ok, true)
})

it('网页配置立即影响下一条模型流程，流程启动快照保留且接口不回传密钥', async (t) => {
  const { base, post, launches, modelConfigFile } = await fixture(t)
  const read = await fetch(base + '/api/model-config')
  const initial = await read.json() as any
  assert.equal(read.headers.get('cache-control'), 'no-store')
  assert.equal(initial.config.apiKeySet, true)
  assert.ok(!JSON.stringify(initial).includes('fixture-private-key'))
  const first = (await post('/flow/start', { kind: 'learn', courseId: 'alpha' })).body
  const events = await stream(t, base, first.flowId)
  await events.wait((e) => e.text?.includes('启动'))
  const saved = await post('/api/model-config', { baseUrl: 'https://second.invalid/v1', model: 'other-model', apiKey: 'replacement-private-key', contextWindow: 32768, researchDeadlineMs: 600000, requestsPerMinute: 5 })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.flows[0].flowId, first.flowId)
  assert.ok(!JSON.stringify(saved.body).includes('replacement-private-key'))
  assert.equal(launches[0].TUTOR_LLM_MODEL, 'deepseek-fixture')
  assert.equal(launches[0].TUTOR_LLM_API_KEY, 'fixture-private-key')
  assert.equal(launches[0].TUTOR_RESEARCH_DEADLINE_MS, '480000')
  assert.equal(launches[0].TUTOR_LLM_REQUESTS_PER_MINUTE, '8')
  assert.equal(fs.statSync(modelConfigFile).mode & 0o777, 0o600)
  await post('/flow/stop', { flowId: first.flowId })
  await events.wait((e) => e.type === 'exit')
  await post('/flow/start', { kind: 'learn', courseId: 'beta' })
  assert.equal(launches[1].TUTOR_LLM_MODEL, 'other-model')
  assert.equal(launches[1].TUTOR_LLM_API_KEY, 'replacement-private-key')
  assert.equal(launches[1].TUTOR_LLM_CONTEXT_WINDOW, '32768')
  assert.equal(launches[1].TUTOR_RESEARCH_DEADLINE_MS, '600000')
  assert.equal(launches[1].TUTOR_LLM_REQUESTS_PER_MINUTE, '5')
  assert.equal(launches[1].TUTOR_MODEL_RATE_LIMIT_FILE, launches[0].TUTOR_MODEL_RATE_LIMIT_FILE)
  assert.equal(launches[1].TUTOR_MODEL_CONFIG_RESOLVED, '1')
  const state: any = await (await fetch(base + '/flow/state')).json()
  assert.equal(state.protocolVersion, 1)
})

it('模型配置拒绝跨站请求、地址换绑与损坏 JSON，保留原配置并不泄漏密钥', async (t) => {
  const { base, post } = await fixture(t)
  const payload = { baseUrl: 'https://first.invalid/v1', model: 'deepseek-fixture', apiKey: '' }
  assert.equal((await post('/api/model-config', payload)).status, 200)
  const changed = await post('/api/model-config', { ...payload, baseUrl: 'https://other.invalid/v1' })
  assert.equal(changed.status, 400)
  assert.match(changed.body.error, /新渠道/)
  const blockedHeaders: Record<string, string>[] = [{ origin: 'https://outside.invalid' }, { host: 'outside.invalid' }, { 'sec-fetch-site': 'cross-site' }]
  for (const headers of blockedHeaders) {
    // fetch 会自行管理 Host；用原生 HTTP 确认服务器确实收到指定的主机与来源。
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(base + '/api/model-config', { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode!))
      })
      request.once('error', reject)
      request.end(JSON.stringify(payload))
    })
    assert.equal(status, 403, JSON.stringify(headers))
  }
  const broken = await fetch(base + '/api/model-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"apiKey":"must-not-be-echoed",broken' })
  assert.equal(broken.status, 400)
  assert.ok(!(await broken.text()).includes('must-not-be-echoed'))
  const initial: any = await (await fetch(base + '/api/model-config')).json()
  assert.equal(initial.config.baseUrl, payload.baseUrl)
  assert.ok(!JSON.stringify(initial).includes('fixture-private-key'))
})

it('未配置模型和搜索密钥也能通过正式启动器打开网页设置', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-setup-'))
  const child = spawn(process.execPath, [path.join(root, 'scripts/agent.mjs'), 'serve'], {
    cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TUTOR_LLM_BASE_URL: '', TUTOR_LLM_MODEL: '', TUTOR_LLM_API_KEY: '',
      TUTOR_MCP_SEARCH_URL: '', TUTOR_MCP_SEARCH_TOKEN: '', TUTOR_SERVER_PORT: '0',
      TUTOR_MODEL_CONFIG_FILE: path.join(directory, 'model-config.json'),
      TUTOR_SESSIONS_ROOT: path.join(directory, 'sessions'), TUTOR_WORKSPACE: path.join(directory, 'workspace'),
      TUTOR_COURSES_ROOT: path.join(directory, 'courses') },
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      try { process.kill(-child.pid!, 'SIGTERM') } catch { child.kill('SIGTERM') }
      await closed
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const base = await new Promise<string>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('网页服务启动超时')), 10000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`网页服务提前退出：${code}`)) })
  })
  assert.equal((await fetch(base + '/settings.html')).status, 200)
  const response: any = await (await fetch(base + '/api/model-config')).json()
  assert.equal(response.config.configured, false)
  const refused = await fetch(base + '/flow/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'new', courseId: 'empty-config' }) })
  assert.equal(refused.status, 400)
  assert.match((await refused.json() as any).error, /模型设置/)
})

it('流程 ID 隔离输入、停止与回放；停止后最终输出仍可重连', async (t) => {
  const { base, post } = await fixture(t)
  const first = (await post('/flow/start', { kind: 'learn', courseId: 'alpha' })).body
  const old = await stream(t, base, first.flowId)
  await old.wait((e) => e.text?.includes('启动'))
  assert.equal((await post('/flow/start', { kind: 'learn', courseId: 'alpha' })).body.flowId, first.flowId)
  assert.equal((await post('/flow/input', { line: 'missing id' })).status, 409)
  assert.equal((await post('/flow/input', { flowId: first.flowId, line: 'A\nB' })).status, 400)
  assert.equal((await post('/flow/input', { flowId: first.flowId, line: '中文回答' })).status, 200)
  await old.wait((e) => e.text?.includes('收到：中文回答'))
  await post('/flow/stop', { flowId: first.flowId })
  await old.wait((e) => e.type === 'exit')
  assert.ok(old.events.findIndex((e) => e.text?.includes('最终结果')) < old.events.findIndex((e) => e.type === 'exit'))
  const second = (await post('/flow/start', { kind: 'learn', courseId: 'beta' })).body
  const next = await stream(t, base, second.flowId)
  await next.wait((e) => e.text?.includes('beta'))
  assert.equal((await post('/flow/input', { flowId: first.flowId, line: '旧页面回答' })).status, 409)
  assert.equal((await post('/flow/stop', { flowId: first.flowId })).status, 409)
  assert.ok(old.events.every((e) => e.flowId === first.flowId))
  const replay = await stream(t, base, first.flowId)
  assert.equal((await replay.wait((e) => e.type === 'hello')).status, 'completed')
  await replay.wait((e) => e.text?.includes('最终结果'))
  await replay.wait((e) => e.type === 'exit')
  const state: any = await (await fetch(base + '/flow/state')).json()
  assert.deepEqual(state.flows.map((flow: any) => flow.flowId), [second.flowId])
})

it('不同里程碑不是同一场考试；进行中的课程禁止并发复习回写', async (t) => {
  const { base, post, store } = await fixture(t)
  store.write('alpha', 'mastery', { basics: { status: 'mastered', review_due: '2026-01-01', review_stage: 1 } })
  const first = (await post('/flow/start', { kind: 'exam', courseId: 'alpha', milestoneId: 'm1' })).body
  const events = await stream(t, base, first.flowId)
  await events.wait((e) => e.text?.includes('启动'))
  assert.equal((await post('/flow/start', { kind: 'exam', courseId: 'alpha', milestoneId: 'm2' })).status, 409)
  const review = await post('/rpc', { id: 1, method: 'applyReview', params: { id: 'alpha', node: 'basics', score: 1 } })
  assert.match(review.body.error.message, /进行中的流程/)
})

it('停止超时后中止在途流程并释放课程槽位', async (t) => {
  const { base, post } = await fixture(t)
  const flow = (await post('/flow/start', { kind: 'plan', courseId: 'alpha' })).body
  const events = await stream(t, base, flow.flowId)
  await events.wait((e) => e.text?.includes('启动'))
  await post('/flow/stop', { flowId: flow.flowId })
  await events.wait((e) => e.type === 'exit')
  const state: any = await (await fetch(base + '/flow/state')).json()
  assert.deepEqual(state.flows, [])
})

it('流程启动失败会清理活动流程并留下失败事件', async (t) => {
  const { base, post } = await fixture(t, true)
  const flow = (await post('/flow/start', { kind: 'learn', courseId: 'alpha' })).body
  const events = await stream(t, base, flow.flowId)
  await events.wait((e) => e.type === 'exit' && e.code === -1)
  const state: any = await (await fetch(base + '/flow/state')).json()
  assert.deepEqual(state.flows, [])
})

it('不同课程的流程可并行：同课程互斥、输入各归各、RPC 守卫按课程隔离', async (t) => {
  const { base, post, store } = await fixture(t)
  store.create('gamma', { goal: '测试课程' })
  const alpha = (await post('/flow/start', { kind: 'learn', courseId: 'alpha' })).body
  const alphaEvents = await stream(t, base, alpha.flowId)
  await alphaEvents.wait((e) => e.text?.includes('启动'))
  // 另一门课不再需要先结束当前流程
  const beta = (await post('/flow/start', { kind: 'learn', courseId: 'beta' })).body
  assert.equal(beta.ok, true)
  assert.notEqual(beta.flowId, alpha.flowId)
  const betaEvents = await stream(t, base, beta.flowId)
  await betaEvents.wait((e) => e.text?.includes('beta'))
  // 同一课程第二个流程仍互斥（同类型同参数是断点复用，不在此列）
  assert.equal((await post('/flow/start', { kind: 'plan', courseId: 'alpha' })).status, 409)
  // 输入按 flowId 各归各的流程，不串台
  assert.equal((await post('/flow/input', { flowId: alpha.flowId, line: '给 alpha' })).status, 200)
  await alphaEvents.wait((e) => e.text?.includes('收到：给 alpha'))
  assert.ok(!betaEvents.events.some((e) => e.text?.includes('给 alpha')))
  // 复习回写守卫只挡有进行中流程的课程（alpha/beta 在跑，gamma 没有）
  const alphaReview = await post('/rpc', { id: 1, method: 'applyReview', params: { id: 'alpha', node: 'x', score: 1 } })
  assert.match(alphaReview.body.error.message, /进行中的流程/)
  const gammaReview = await post('/rpc', { id: 2, method: 'applyReview', params: { id: 'gamma', node: 'x', score: 1 } })
  assert.ok(!/进行中的流程/.test(gammaReview.body.error?.message ?? ''))
  const state: any = await (await fetch(base + '/flow/state')).json()
  assert.deepEqual(state.flows.map((flow: any) => flow.courseId).sort(), ['alpha', 'beta'])
  // 停掉 alpha 不影响 beta 继续交互
  await post('/flow/stop', { flowId: alpha.flowId })
  await alphaEvents.wait((e) => e.type === 'exit')
  assert.equal((await post('/flow/input', { flowId: beta.flowId, line: 'beta 还在' })).status, 200)
  await betaEvents.wait((e) => e.text?.includes('收到：beta 还在'))
  await post('/flow/stop', { flowId: beta.flowId })
  await betaEvents.wait((e) => e.type === 'exit')
})

it('实践和教研的知识点传给 runner 并参与流程身份；不同节点不复用，非法节点不启动', async (t) => {
  const { base, post, store } = await fixture(t)
  store.write('alpha', 'knowledge-map', { verified: false, nodes: [{ id: 'basics', title: '基础' }, { id: 'advanced', title: '进阶' }], edges: [] })
  assert.equal((await post('/flow/start', { kind: 'practice', courseId: 'alpha', nodeId: 'unknown' })).body.ok, false)
  assert.equal((await post('/flow/start', { kind: 'learn', courseId: 'alpha', nodeId: 'basics' })).body.ok, false)
  assert.equal((await post('/flow/start', { kind: 'practice', courseId: 'alpha', nodeId: '../beta' })).body.ok, false)
  for (const kind of ['practice', 'research']) {
    const flow = (await post('/flow/start', { kind, courseId: 'alpha', nodeId: 'basics' })).body
    assert.equal(flow.nodeId, 'basics')
    const events = await stream(t, base, flow.flowId)
    await events.wait((e) => e.text?.includes(`启动 ${kind} alpha basics`))
    assert.equal((await post('/flow/start', { kind, courseId: 'alpha', nodeId: 'basics' })).body.flowId, flow.flowId)
    assert.equal((await post('/flow/start', { kind, courseId: 'alpha', nodeId: 'advanced' })).status, 409)
    await post('/flow/stop', { flowId: flow.flowId })
    await events.wait((e) => e.type === 'exit')
  }
})

it('内容重审以 audit-content 流程运行，作为课程身份的一部分；非法 nodeId 不被接受', async (t) => {
  const { base, post, store } = await fixture(t)
  store.write('alpha', 'knowledge-map', { verified: false, nodes: [{ id: 'basics', title: '基础' }], edges: [] })
  assert.equal((await post('/flow/start', { kind: 'audit-content', courseId: 'alpha', nodeId: 'basics' })).body.ok, false)
  const flow = (await post('/flow/start', { kind: 'audit-content', courseId: 'alpha' })).body
  assert.equal(flow.ok, true)
  assert.equal(flow.kind, 'audit-content')
  const events = await stream(t, base, flow.flowId)
  await events.wait((e) => e.text?.includes('启动 audit-content alpha'))
  await post('/flow/stop', { flowId: flow.flowId })
  await events.wait((e) => e.type === 'exit')
})

it('搜索服务可在网页配置并掩码：保存后不回显 Token，换址必须提供新 Token', async (t) => {
  const { base, post } = await fixture(t)
  const initial: any = await (await fetch(base + '/api/model-config')).json()
  assert.equal(initial.config.searchConfigured, false)
  const saved = await post('/api/model-config', { baseUrl: 'https://first.invalid/v1', model: 'deepseek-fixture', apiKey: '',
    searchMcpUrl: 'https://tavily.ivanli.cc/mcp', searchToken: 'th-secret-token' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.config.searchMcpUrl, 'https://tavily.ivanli.cc/mcp')
  assert.equal(saved.body.config.searchTokenSet, true)
  assert.ok(!JSON.stringify(saved.body).includes('th-secret-token'))
  const after: any = await (await fetch(base + '/api/model-config')).json()
  assert.equal(after.config.searchConfigured, true)
  const refused = await post('/api/model-config', { baseUrl: 'https://first.invalid/v1', model: 'deepseek-fixture', apiKey: '',
    searchMcpUrl: 'https://other.invalid/mcp', searchToken: '' })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /Token/)
})

it('RPC 与流程端点拒绝跨站请求，并强制 JSON Content-Type', async (t) => {
  const { base } = await fixture(t)
  const cross = (route: string, contentType = 'text/plain') => fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': contentType, origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  assert.equal((await cross('/rpc')).status, 403)
  assert.equal((await cross('/flow/start', 'application/json')).status, 403)
  const crossState = await fetch(base + '/flow/state', { headers: { origin: 'https://evil.example' } })
  assert.equal(crossState.status, 403)

  const sameOriginText = await fetch(base + '/rpc', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: base },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  assert.equal(sameOriginText.status, 415)
  const sameOrigin = await fetch(base + '/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  assert.equal(sameOrigin.status, 200)
  assert.deepEqual((await sameOrigin.json() as any).result, { ok: true })
})

it('真实流程读写与宿主同一份课程目录，并使用宿主注入的日期', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-http-real-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new CourseStore(dir)
  store.create('alpha', { goal: '测试课程', daily_minutes: 60 })
  const map = { verified: false, nodes: [{ id: 'basics', title: '基础' }], edges: [], resources: [] }
  store.write('alpha', 'knowledge-map', map)
  store.write('alpha', 'plan', { path: ['basics'], scope: ['basics'], milestones: [], current: 'basics' })
  store.write('alpha', 'practice', {
    generated_at: '2026-10-08',
    tasks: [{ id: 'basics-task', node: 'basics', title: '写个文件', prompt: '创建 answer.txt',
      tests: [{ name: 'file', command: 'test -f answer.txt' }] }],
  })
  const profile = store.read('alpha', 'profile') as Profile
  approveFixture(dir, 'alpha', practiceContent((store.read('alpha', 'practice') as { tasks: never[] }).tasks, 'basics', profile, map as never))
  const app = createTutorServer({
    root, coursesRoot: dir, modelConfigFile: path.join(dir, 'model-config.json'),
    modelEnvironment: { TUTOR_LLM_BASE_URL: '', TUTOR_LLM_MODEL: '', TUTOR_LLM_API_KEY: '' },
    today: () => '2026-10-08',
  })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => { await app.close() })
  const started = await (await fetch(`${base}/flow/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'practice', courseId: 'alpha', nodeId: 'basics' }),
  })).json() as { ok: boolean; flowId: string; error?: string }
  assert.equal(started.ok, true, started.error)
  await (await fetch(`${base}/flow/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flowId: started.flowId, line: '' }),
  })).json()
  // 流程状态写进宿主同一份课程目录，而不是 root/courses。
  const statePath = path.join(dir, 'alpha', 'practice-state.yaml')
  for (let attempt = 0; attempt < 50 && !fs.existsSync(statePath); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(fs.existsSync(statePath), true, '实践流程应写入宿主指定的课程目录')
  assert.equal(fs.existsSync(path.join(root, 'courses', 'alpha')), false, '不应写入默认课程目录')
  // 流程使用宿主注入的日期。
  assert.match(fs.readFileSync(statePath, 'utf8'), /updated_at: 2026-10-08/)
})
