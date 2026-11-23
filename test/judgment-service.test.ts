import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import {
  ChatRuntime,
  ModelBudgetError,
  type ChatRuntimeOptions,
  type AttemptObservation,
} from '../src/runtime/chat.ts'
import { ModelRateLimiter } from '../src/core/model-rate-limit.ts'
import { JudgmentService, type JudgmentCheck } from '../src/capabilities/judgment-service.ts'
import { ContentValidation, ModelService } from '../src/capabilities/model-service.ts'
import { DomainError } from '../src/domain/model.ts'
import { ROOT, setup, jsonReply, scriptedTransport, activity } from './fixtures/tutor.ts'
import {
  FAST_JUDGMENT_ENV,
  judgmentFetch,
  judgmentReply,
  noulReply,
  type JudgmentRequest,
} from './fixtures/judgment.ts'

const checks: JudgmentCheck[] = [
  { id: 'scope', instructions: '内容属于用户声明的目标范围。', failure: '内容越界' },
]

function fixture(t: TestContext, options: Partial<ChatRuntimeOptions> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-judgment-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const events: AttemptObservation[] = []
  let fastCalls = 0,
    llmCalls = 0
  const fast = options.typedFetch ?? judgmentFetch()
  const llm = options.transport ?? scriptedTransport([])
  const runtime = new ChatRuntime({
    model: {
      baseUrl: 'https://llm.invalid/v1',
      apiKey: 'llm-fixture-key',
      model: 'fixture',
      thinking: 'low',
      contextWindow: 262144,
      maxOutputTokens: 16384,
      requestsPerMinute: 600,
      researchDeadlineMs: 240000,
    },
    sessionsRoot: path.join(directory, 'sessions'),
    workspace: ROOT,
    maxModelRequests: 30,
    rateLimiter: new ModelRateLimiter({
      file: path.join(directory, 'queue.sqlite'),
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'fixture',
      requestsPerMinute: 600,
      windowMs: 1,
    }),
    ...options,
    env: { ...FAST_JUDGMENT_ENV, ...options.env },
    typedFetch: async (...args) => {
      fastCalls++
      return fast(...args)
    },
    transport: async (...args) => {
      llmCalls++
      return llm(...args)
    },
    observe: (event) => {
      events.push(event)
      options.observe?.(event)
    },
  })
  return {
    runtime,
    judge: new JudgmentService(runtime),
    events,
    get fastCalls() {
      return fastCalls
    },
    get llmCalls() {
      return llmCalls
    },
  }
}

it('关闭快速判断后不发外部请求，完整使用大模型核验', async (t) => {
  const { repository } = setup(t)
  const f = fixture(t, { env: { TUTOR_JUDGMENT_PROVIDER: 'llm', TUTOR_REVIEW_MODEL: 'other-review-model' } })
  const record = await new ContentValidation(repository, new ModelService(f.runtime)).review(
    repository.read('alpha'),
    'activity',
    activity(),
  )
  assert.equal(record.status, 'approved')
  assert.equal(record.judgment!.route, 'llm')
  assert.equal(f.fastCalls, 0)
  assert.equal(f.llmCalls, 1)
  assert.equal(f.events.find((event) => event.type === 'attempt')!.model, 'other-review-model')
})

it('TypeSafe 使用独立密钥与真实类型化接口，结果保留模型身份及报告用量', async (t) => {
  const f = fixture(t, {
    typedFetch: judgmentFetch((request, url, init) => {
      assert.equal(url, 'https://judge.invalid/v1/systemone')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fast-fixture-key')
      assert.equal(init?.redirect, 'error')
      assert.equal(request.model, 'jev-fixture')
      assert.deepEqual(request.state, { goal: '只学习加法' })
      assert.equal(request.questions.scope.type, 'choice')
      assert.deepEqual(Object.keys(request.questions.scope.criteria).sort(), ['fail', 'pass', 'uncertain'])
      assert.equal('messages' in request, false)
    }),
  })
  const result = await f.judge.evaluate({ goal: '只学习加法' }, checks)
  assert.equal(result.route, 'typesafe')
  assert.equal(result.result!.model, 'jev-fixture-1')
  assert.equal(result.result!.answers.scope.choice, 'pass')
  const attempt = f.events.find((event) => event.type === 'attempt')!
  assert.equal(attempt.model, 'jev-fixture-1')
  assert.equal(attempt.provider, 'typesafe')
  assert.deepEqual(attempt.usage, { inputTokens: 120, outputTokens: 12 })
  assert.equal(f.llmCalls, 0)
})

it('完整中转地址按原路由 POST，支持命名空间模型与 Noul 请求', async (t) => {
  let captured: { url?: string; authorization?: string; body: JudgmentRequest } | undefined
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/decisions/?api-version=preview') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as JudgmentRequest
    captured = { url: req.url, authorization: req.headers.authorization, body }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(noulReply(body)))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const f = fixture(t, {
    typedFetch: fetch,
    env: {
      TUTOR_JUDGMENT_BASE_URL:
        'http://127.0.0.1:' +
        (server.address() as { port: number }).port +
        '/v1/decisions/?api-version=preview',
      TUTOR_JUDGMENT_URL_MODE: 'endpoint',
      TUTOR_JUDGMENT_QUESTION_TYPE: 'noul',
      TUTOR_JUDGMENT_MODEL: 'commandcode/jev-1.14.0',
    },
  })
  const state = { task: '检查商品描述', description: '商品完好，包装略有划痕' }
  const result = await f.judge.evaluate(state, checks)
  assert.equal(result.route, 'typesafe')
  assert.equal(captured!.url, '/v1/decisions/?api-version=preview')
  assert.equal(captured!.authorization, 'Bearer fast-fixture-key')
  assert.equal(captured!.body.model, 'commandcode/jev-1.14.0')
  assert.deepEqual(captured!.body.state, state)
  assert.equal(captured!.body.questions.scope.type, 'noul')
  assert.deepEqual(Object.keys(captured!.body.questions.scope.criteria).sort(), ['false', 'true'])
  assert.equal(result.result!.answers.scope.noul, 0.99)
  assert.equal(result.result!.answers.scope.confidence, undefined)
  assert.equal(f.llmCalls, 0)
})

it('Noul 使用真实概率采用或回退，不伪造模型置信度', async (t) => {
  for (const [probability, route, choice] of [
    [0.99, 'typesafe', 'pass'],
    [0.01, 'typesafe', 'fail'],
    [0.8, 'llm', 'pass'],
    [0.5, 'llm', 'uncertain'],
  ] as const) {
    const f = fixture(t, {
      env: { TUTOR_JUDGMENT_QUESTION_TYPE: 'noul' },
      typedFetch: judgmentFetch(undefined, (request) => noulReply(request, probability)),
    })
    const result = await f.judge.evaluate({}, checks)
    assert.equal(result.route, route)
    assert.equal(result.result!.answers.scope.choice, choice)
    assert.equal(result.result!.answers.scope.confidence, undefined)
    assert.equal(result.result!.answers.scope.noul, probability)
  }
  const invalid = fixture(t, {
    env: { TUTOR_JUDGMENT_QUESTION_TYPE: 'noul' },
    typedFetch: judgmentFetch(undefined, (request) => noulReply(request, 2)),
  })
  assert.equal((await invalid.judge.evaluate({}, checks)).fallback, 'unavailable')
})

it('低置信度、显式不确定与无效响应回退，不把格式正确当成判断可靠', async (t) => {
  const variants: ((request: JudgmentRequest) => unknown)[] = [
    (request) => judgmentReply(request, 'pass', 0.8),
    (request) => judgmentReply(request, 'uncertain'),
    (request) => {
      const raw = judgmentReply(request)
      raw.answers.scope.probabilities = { pass: 0.52, fail: 0.25, uncertain: 0.23 }
      return raw
    },
    (request) => ({ ...judgmentReply(request), answers: {} }),
    (request) => ({ ...judgmentReply(request), model: FAST_JUDGMENT_ENV.TUTOR_JUDGMENT_API_KEY }),
    (request) => {
      const raw = judgmentReply(request)
      raw.answers.scope.confidence = 2
      return raw
    },
    (request) => {
      const raw = judgmentReply(request)
      raw.answers.scope.probabilities = { pass: 0.1, fail: 0.89, uncertain: 0.01 }
      return raw
    },
  ]
  for (const reply of variants) {
    const f = fixture(t, { typedFetch: judgmentFetch(undefined, reply) })
    const result = await f.judge.evaluate({ goal: '加法' }, checks)
    assert.equal(result.route, 'llm')
    assert.ok(result.fallback)
    assert.equal(f.fastCalls, 1)
    assert.equal(f.events.filter((event) => event.type === 'attempt').length, 1)
    assert.equal(JSON.stringify(f.events).includes(FAST_JUDGMENT_ENV.TUTOR_JUDGMENT_API_KEY), false)
  }
})

it('上下文超出快速判断范围时不发请求，服务失败和超时允许大模型接管', async (t) => {
  const large = fixture(t)
  assert.equal((await large.judge.evaluate('长'.repeat(32000), checks)).fallback, 'input_too_large')
  assert.equal(large.fastCalls, 0)
  const failed = fixture(t, { typedFetch: async () => new Response('private failure', { status: 503 }) })
  assert.equal((await failed.judge.evaluate({}, checks)).fallback, 'unavailable')
  const timed = fixture(t, {
    env: { TUTOR_JUDGMENT_TIMEOUT_MS: '500' },
    typedFetch: async (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('{}')), 2000)
        init!.signal!.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(init!.signal!.reason)
          },
          { once: true },
        )
      }),
  })
  assert.equal((await timed.judge.evaluate({}, checks)).fallback, 'unavailable')
  assert.equal(timed.events.find((event) => event.type === 'attempt')!.outcome, 'aborted')
})

it('快速判断与大模型共享请求预算，预算拒绝不会被当成服务失败回退', async (t) => {
  const denied = fixture(t, { maxModelRequests: 0 })
  await assert.rejects(() => denied.judge.evaluate({}, checks), ModelBudgetError)
  assert.equal(denied.fastCalls, 0)
  const daily = fixture(t, {
    observe: (event) => {
      if (event.type === 'attempt-start') throw new DomainError('BUDGET_EXCEEDED', '今日预算用完', 429)
    },
  })
  await assert.rejects(() => daily.judge.evaluate({}, checks), { code: 'BUDGET_EXCEEDED' })
  assert.equal(daily.fastCalls, 0)
  const one = fixture(t, { maxModelRequests: 1 })
  await one.judge.evaluate({}, checks)
  const chat = await one.runtime.createChat({ isolatedSystemPrompt: '独立核查', tools: 'none' })
  await assert.rejects(() => chat!.ask('继续核查'), ModelBudgetError)
  await chat!.flush()
  assert.equal(one.fastCalls, 1)
  assert.equal(one.llmCalls, 0)
})

it('用户暂停不触发回退，迟到的类型化结果也保留已报告用量', async (t) => {
  const controller = new AbortController(),
    stop = new Error('学员暂停')
  const f = fixture(t, { signal: controller.signal })
  await assert.rejects(
    () =>
      f.runtime.callTyped('late', f.runtime.modelNow(), 'typesafe', 5000, async () => {
        controller.abort(stop)
        return { value: '迟到的结果', model: 'jev-late', usage: { inputTokens: 100, outputTokens: 12 } }
      }),
    (error) => error === stop,
  )
  const attempt = f.events.find((event) => event.type === 'attempt')!
  assert.equal(attempt.outcome, 'aborted')
  assert.equal(attempt.model, 'jev-late')
  assert.deepEqual(attempt.usage, { inputTokens: 100, outputTokens: 12 })
  await assert.rejects(
    () => f.judge.evaluate({}, checks),
    (error) => error === stop,
  )
  assert.equal(f.fastCalls, 0)
})

it('画像依据可直接采用可靠判断，关闭选项或换核验模型后不复用旧批准缓存', async (t) => {
  const { repository } = setup(t)
  const state = repository.read('alpha')
  const profile = {
    purpose: 'profile_update',
    background: '有 Java 经验',
    preferences: ['先看例子'],
    original: [{ text: '我有 Java 经验，喜欢先看例子。' }],
  }
  const fast = fixture(t)
  const validator = new ContentValidation(repository, new ModelService(fast.runtime))
  const accepted = await validator.review(state, 'message', profile)
  assert.equal(accepted.status, 'approved')
  assert.equal(fast.fastCalls, 1)
  assert.equal(fast.llmCalls, 0)
  assert.equal((await validator.review(state, 'message', profile)).id, accepted.id)
  assert.equal(fast.fastCalls, 1)
  const normal = fixture(t, { env: { TUTOR_JUDGMENT_PROVIDER: 'llm' } })
  const rechecked = await new ContentValidation(repository, new ModelService(normal.runtime)).review(
    state,
    'message',
    profile,
  )
  assert.notEqual(rechecked.key, accepted.key)
  assert.equal(normal.llmCalls, 1)
  assert.equal(normal.fastCalls, 0)
  const channel = fixture(t, {
    env: { TUTOR_JUDGMENT_PROVIDER: 'llm' },
    model: { ...normal.runtime.modelNow(), baseUrl: 'https://other-llm.invalid/v1' },
  })
  const another = await new ContentValidation(repository, new ModelService(channel.runtime)).review(
    state,
    'message',
    profile,
  )
  assert.notEqual(another.key, rechecked.key)
  assert.equal(channel.llmCalls, 1)
  const strict = fixture(t, { env: { TUTOR_JUDGMENT_MIN_CONFIDENCE: '0.999' } })
  const stricter = await new ContentValidation(repository, new ModelService(strict.runtime)).review(
    state,
    'message',
    profile,
  )
  assert.notEqual(stricter.key, accepted.key)
  assert.equal(stricter.judgment!.fallback, 'uncertain')
  assert.equal(strict.llmCalls, 1)
})

it('可靠的范围否决阻止候选，不重复抽取同一失败稿', async (t) => {
  const { repository } = setup(t)
  const f = fixture(t, { typedFetch: judgmentFetch(undefined, (request) => judgmentReply(request, 'fail')) })
  const validator = new ContentValidation(repository, new ModelService(f.runtime))
  const content = activity()
  content.body = '开始学习微积分。'
  await assert.rejects(() => validator.review(repository.read('alpha'), 'activity', content), {
    code: 'CONTENT_REJECTED',
  })
  const before = f.fastCalls
  await assert.rejects(() => validator.review(repository.read('alpha'), 'activity', content), {
    code: 'CONTENT_REJECTED',
  })
  assert.equal(f.fastCalls, before)
  assert.equal(f.llmCalls, 0)
})

it('快速范围通过不能跳过事实审核或确定性的数值复算', async (t) => {
  for (const verdict of [
    { scope: 'pass', correctness: 'fail', issues: ['加法不是乘法'], arithmetic: [] },
    { scope: 'pass', correctness: 'pass', issues: [], arithmetic: [{ expression: '2+3', result: '6' }] },
  ]) {
    const { repository } = setup(t)
    const f = fixture(t, { transport: async () => jsonReply(verdict) })
    await assert.rejects(
      () =>
        new ContentValidation(repository, new ModelService(f.runtime)).review(
          repository.read('alpha'),
          'activity',
          activity(),
        ),
      { code: 'CONTENT_REJECTED' },
    )
    assert.equal(f.fastCalls, 1)
    assert.equal(f.llmCalls, 1)
  }
})
