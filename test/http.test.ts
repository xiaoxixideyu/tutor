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
import { createTutorServer } from '../src/server/http.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function fixture(t: TestContext, broken = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-http-'))
  const store = new CourseStore(dir)
  const launches: NodeJS.ProcessEnv[] = []
  for (const id of ['alpha', 'beta']) store.create(id, { goal: '测试课程' })
  const modelConfigFile = path.join(dir, 'model-config.json')
  const app = createTutorServer({ root, coursesRoot: dir, modelConfigFile, stopTimeoutMs: 100, today: () => '2026-10-08',
    modelEnvironment: { TUTOR_LLM_BASE_URL: 'https://first.invalid/v1', TUTOR_LLM_MODEL: 'deepseek-fixture', TUTOR_LLM_API_KEY: 'fixture-private-key' },
    launch: (input, env) => { launches.push(env); return spawn(broken ? path.join(dir, 'missing-bin') : process.execPath,
      [path.join(root, 'test/fixtures/flow-runner.mjs'), input.kind, input.courseId, input.nodeId],
      { stdio: ['pipe', 'pipe', 'pipe'], detached: true }) },
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
  for (const page of ['/', '/wizard.html', '/lesson.html', '/exam.html', '/practice.html', '/review.html', '/flow-client.js', '/settings.html', '/settings.js']) {
    assert.equal((await fetch(base + page)).status, 200)
  }
  const list = await post('/rpc', { method: 'listCourses', id: 1 })
  assert.deepEqual(list.body.result.map((c: any) => c.id), ['alpha', 'beta'])
  assert.equal((await post('/rpc', null)).body.error.code, -32600)
  assert.equal((await post('/flow/start', null)).status, 400)
  assert.equal((await post('/flow/start', { kind: 'learn', courseId: 'alpha' })).body.ok, true)
})

it('网页配置立即影响下一条模型流程，当前流程保留配置快照且接口不回传密钥', async (t) => {
  const { base, post, launches, modelConfigFile } = await fixture(t)
  const read = await fetch(base + '/api/model-config')
  const initial = await read.json() as any
  assert.equal(read.headers.get('cache-control'), 'no-store')
  assert.equal(initial.config.apiKeySet, true)
  assert.ok(!JSON.stringify(initial).includes('fixture-private-key'))
  const first = (await post('/flow/start', { kind: 'learn', courseId: 'alpha' })).body
  const events = await stream(t, base, first.flowId)
  await events.wait((e) => e.text?.includes('启动'))
  const saved = await post('/api/model-config', { baseUrl: 'https://second.invalid/v1', model: 'other-model', apiKey: 'replacement-private-key', contextWindow: 32768, researchDeadlineMs: 600000 })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.active.flowId, first.flowId)
  assert.ok(!JSON.stringify(saved.body).includes('replacement-private-key'))
  assert.equal(launches[0].TUTOR_LLM_MODEL, 'deepseek-fixture')
  assert.equal(launches[0].TUTOR_LLM_API_KEY, 'fixture-private-key')
  assert.equal(launches[0].TUTOR_RESEARCH_DEADLINE_MS, '480000')
  assert.equal(fs.statSync(modelConfigFile).mode & 0o777, 0o600)
  await post('/flow/stop', { flowId: first.flowId })
  await events.wait((e) => e.type === 'exit')
  await post('/flow/start', { kind: 'learn', courseId: 'beta' })
  assert.equal(launches[1].TUTOR_LLM_MODEL, 'other-model')
  assert.equal(launches[1].TUTOR_LLM_API_KEY, 'replacement-private-key')
  assert.equal(launches[1].TUTOR_LLM_CONTEXT_WINDOW, '32768')
  assert.equal(launches[1].TUTOR_RESEARCH_DEADLINE_MS, '600000')
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
      TUTOR_MODEL_CONFIG_FILE: path.join(directory, 'model-config.json'), DSH_HOME: path.join(directory, 'dsh-home'),
      TUTOR_WORKSPACE: path.join(directory, 'workspace'), TUTOR_COURSES_ROOT: path.join(directory, 'courses') },
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
  assert.equal(fs.existsSync(path.join(directory, 'dsh-home/settings.yaml')), false)
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
  assert.equal(state.active.flowId, second.flowId)
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

it('超时停止会终止整个进程组，释放活动流程', async (t) => {
  const { base, post } = await fixture(t)
  const flow = (await post('/flow/start', { kind: 'plan', courseId: 'alpha' })).body
  const events = await stream(t, base, flow.flowId)
  await events.wait((e) => e.text?.includes('启动'))
  await post('/flow/stop', { flowId: flow.flowId })
  await events.wait((e) => e.type === 'exit')
  const state: any = await (await fetch(base + '/flow/state')).json()
  assert.equal(state.active, null)
})

it('子进程启动失败会清理活动流程并留下失败事件', async (t) => {
  const { base, post } = await fixture(t, true)
  const flow = (await post('/flow/start', { kind: 'learn', courseId: 'alpha' })).body
  const events = await stream(t, base, flow.flowId)
  await events.wait((e) => e.type === 'exit' && e.code === -1)
  const state: any = await (await fetch(base + '/flow/state')).json()
  assert.equal(state.active, null)
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
