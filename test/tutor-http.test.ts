import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createTutorServer } from '../src/server/http.ts'
import { TutorSystem } from '../src/application/tutor-system.ts'
import { activity, SKILL, scriptedTransport, systemFixture, toolReply } from './fixtures/tutor.ts'

async function server(t: TestContext) {
  const fixture = systemFixture(
    t,
    scriptedTransport([
      toolReply('update_curriculum', { skills: [SKILL], reason: '定义近期目标' }),
      toolReply('present_activity', activity()),
      toolReply('ask_learner', { question: '需要继续吗？', reason: '等待用户下一步' }),
    ]),
  )
  const app = createTutorServer(fixture.options)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const port = (app.server.address() as { port: number }).port
  const base = 'http://127.0.0.1:' + port
  t.after(async () => {
    app.server.closeIdleConnections()
    await app.close()
  })
  async function request(path: string, input?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method: input ? 'POST' : 'GET',
      headers: input ? { 'content-type': 'application/json', ...headers } : headers,
      ...(input ? { body: JSON.stringify(input) } : {}),
    })
    return { status: response.status, value: await response.json() }
  }
  return { app, base, request, options: fixture.options }
}

it('新 API 从空白目标开始，创建、agent 教学、评分和回放形成闭环', async (t) => {
  const { app, request } = await server(t)
  assert.equal((await request('/api/courses')).value.courses.length, 0)
  assert.equal((await request('/api/courses', { id: 'alpha', goal: '掌握整数加法' })).status, 201)
  assert.equal(
    (await request('/api/courses/alpha/turn', { requestId: 'start', expectedRevision: 0 })).status,
    202,
  )
  await app.system.wait('alpha')
  const first = (await request('/api/courses/alpha')).value
  assert.equal(first.course.active.question.id, 'q1')
  assert.equal('answer' in first.course.active.question, false)
  assert.ok(first.events.some((event: any) => event.type === 'activity_presented' && event.data.body))
  const input = {
    requestId: 'answer',
    activityId: first.course.active.id,
    questionId: 'q1',
    contentHash: first.course.active.contentHash,
    answer: '5',
    expectedRevision: first.course.revision,
  }
  assert.equal((await request('/api/courses/alpha/answer', input)).status, 202)
  await app.system.wait('alpha')
  const complete = (await request('/api/courses/alpha')).value
  assert.equal(complete.course.evidence.filter((item: any) => item.kind === 'answer').length, 1)
  assert.equal(complete.course.goalSupported, false)
  assert.equal((await request('/api/courses/alpha/answer', input)).value.duplicate, true)
  assert.equal((await request('/api/courses/alpha/answer', { ...input, answer: '0' })).status, 409)
})

it('本机同源和 JSON 边界保护读写接口', async (t) => {
  const { request } = await server(t)
  assert.equal(
    (await request('/api/courses', { goal: '测试' }, { origin: 'https://evil.invalid' })).status,
    403,
  )
  assert.equal(
    (await request('/api/courses', { goal: '测试' }, { 'sec-fetch-site': 'cross-site' })).status,
    403,
  )
  assert.equal(
    (await request('/api/courses', { goal: '测试' }, { 'content-type': 'text/plain' })).status,
    415,
  )
  assert.equal((await request('/api/courses')).value.courses.length, 0)
})

it('旧流程与 RPC 不再作为业务入口，静态文件不能访问项目配置', async (t) => {
  const { base } = await server(t)
  assert.equal((await fetch(base + '/flow/state')).status, 404)
  assert.equal((await fetch(base + '/rpc', { method: 'POST' })).status, 405)
  const response = await fetch(base + '/ui/%2e%2e/%2e%2e/.env')
  assert.ok([403, 404].includes(response.status))
  assert.ok(!(await response.text()).includes('TUTOR_LLM_API_KEY'))
})

it('SSE 返回结构化事件和快照，按 cursor 恢复而不重做业务', async (t) => {
  const { app, base, request } = await server(t)
  await request('/api/courses', { id: 'alpha', goal: '掌握整数加法' })
  await request('/api/courses/alpha/turn', { requestId: 'start' })
  await app.system.wait('alpha')
  const latest = app.system.repository.read('alpha').nextEventSeq - 1
  const controller = new AbortController()
  const stream = await fetch(base + '/api/courses/alpha/stream?after=' + latest, {
    signal: controller.signal,
  })
  const reader = stream.body!.getReader()
  const chunk = await reader.read()
  const data = new TextDecoder().decode(chunk.value)
  assert.match(data, /"type":"snapshot"/)
  assert.doesNotMatch(data, /"type":"activity_presented"/)
  controller.abort()
  await reader.cancel().catch(() => {})
  assert.equal(app.system.repository.read('alpha').nextEventSeq - 1, latest)
})

it('SSE 自动观察其他入口的提交，不需要刷新或再次调用模型', async (t) => {
  const { app, base, request, options } = await server(t)
  await request('/api/courses', { id: 'alpha', goal: '掌握整数加法' })
  const peer = new TutorSystem(options)
  t.after(() => peer.close())
  const controller = new AbortController()
  const response = await fetch(base + '/api/courses/alpha/stream?after=0', {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]),
  })
  const reader = response.body!.getReader()
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"snapshot"/)
    peer.start('alpha', { requestId: 'peer-turn' })
    await peer.wait('alpha')
    const before = peer.usageLedger.read().length
    const events: any[] = []
    let buffer = ''
    while (!events.some((event) => event.type === 'snapshot' && event.course.active?.question?.id === 'q1')) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false)
      buffer += new TextDecoder().decode(chunk.value)
      const frames = buffer.split('\n\n')
      buffer = frames.pop()!
      for (const frame of frames) if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)))
    }
    assert.ok(events.some((event) => event.type === 'activity_presented'))
    assert.equal(events.filter((event) => event.type === 'question_presented').length, 1)
    assert.equal(app.system.activeJobs().length, 0)
    assert.equal(peer.usageLedger.read().length, before)
  } finally {
    controller.abort()
    await reader.cancel().catch(() => {})
  }
})

it('不同题目版本和过期状态拒绝提交，草稿通过独立接口保留', async (t) => {
  const { app, request } = await server(t)
  await request('/api/courses', { id: 'alpha', goal: '掌握整数加法' })
  await request('/api/courses/alpha/turn', { requestId: 'start' })
  await app.system.wait('alpha')
  const view = app.system.service.view('alpha')
  assert.equal(
    (
      await request('/api/courses/alpha/draft', {
        requestId: 'draft',
        activityId: view.active!.id,
        questionId: 'q1',
        answer: '未提交的思考',
        draftVersion: 0,
      })
    ).status,
    200,
  )
  assert.equal((await request('/api/courses/alpha')).value.course.active.draft.text, '未提交的思考')
  assert.equal(
    (
      await request('/api/courses/alpha/answer', {
        requestId: 'wrong',
        activityId: view.active!.id,
        questionId: 'q1',
        contentHash: 'wrong',
        answer: '5',
      })
    ).status,
    409,
  )
  assert.equal(
    app.system.repository.read('alpha').evidence.filter((item) => item.kind === 'answer').length,
    0,
  )
})

it('设置接口保留密钥而不回传，新的推理配置能保存', async (t) => {
  const { request } = await server(t)
  const current = (await request('/api/model-config')).value.config
  assert.equal(current.apiKeySet, true)
  assert.equal(JSON.stringify(current).includes('fixture-key'), false)
  const saved = await request('/api/model-config', {
    ...current,
    apiKey: '',
    agentThinking: 'medium',
    reviewThinking: 'high',
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.value.config.agentThinking, 'medium')
  assert.equal(saved.value.config.reviewThinking, 'high')
  assert.equal(saved.value.config.apiKeySet, true)
  assert.equal(JSON.stringify(saved.value).includes('fixture-key'), false)
})
