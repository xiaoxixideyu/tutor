import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createAgentChat, permanentModelError } from '../src/plugin/agent-chat.ts'
import { ContentReviewError } from '../src/plugin/content-gate.ts'
import { ModelRateLimiter, ModelRateLimitError } from '../src/core/model-rate-limit.ts'
import { researchNodes } from '../src/core/research.ts'
import { ResearchBudgetError } from '../src/plugin/research-budget.ts'
import { ModelWaitTimeoutError } from '../src/plugin/turn-timeout.ts'
import { MODEL_RECOVERY_LIMITS, recoveryDelay, transientModelFailure } from '../src/core/model-recovery.ts'

const initialized = new WeakSet<TestContext>()

// 使用真正的 Cordis waterfall 和 createAgentChat.setup。传输层只模拟 Harness 的
// 请求→失败→内部重试→turn/end 行为，避免绕过 setup 的测试漏掉监听器顺序。
function fixture(t: TestContext, outcomes: ('rate-limit' | 'tool' | 'success')[]) {
  const env = { TUTOR_LLM_BASE_URL: 'https://fixture.invalid/v1', TUTOR_LLM_API_KEY: 'fixture-key', TUTOR_LLM_REQUESTS_PER_MINUTE: '8' }
  if (!initialized.has(t)) {
    initialized.add(t)
    for (const [key, value] of Object.entries(env)) {
      const previous = process.env[key]
      process.env[key] = value
      t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
    }
  }
  const calls: string[] = []
  t.mock.method(ModelRateLimiter.prototype, 'acquire', async () => { calls.push('acquire') })
  t.mock.method(ModelRateLimiter.prototype, 'cooldown', async (_signal: AbortSignal, retryAfterMs: number) => {
    calls.push(`cooldown:${retryAfterMs}`); return 61_000
  })
  const events: any[] = []
  let cursor = 0, turn = 0, followups = 0, requestCount = 0, downstreamRetries = 0
  let pending = Promise.resolve()
  const controller = new AbortController()
  const bus = new Context()
  bus.provide('tools', { guard: () => {} })
  // 模拟先注册、且不调用 next 的 Harness 重试插件；Tutor 必须 prepend 才能拦住它。
  bus.on('agent/request-error', async () => { downstreamRetries++; return { kind: 'retry' } })
  const agent = {
    session: { id: 'scheduling-fixture', get seq() { return events.length }, eventAt: (seq: number) => events[seq] },
    whenIdle: () => pending,
    cancel: () => controller.abort(),
    followup: () => {
      followups++; turn++
      pending = (async () => {
        try {
          let step = 1
          for (;;) {
            const payload = { agent, turn, step, signal: controller.signal } as never
            await bus.waterfall('agent/request', payload, async () => ({ provider: 'tutor', model: 'fixture' }))
            requestCount++
            const outcome = outcomes[cursor++]
            assert.ok(outcome, '不应发起额外请求')
            if (outcome === 'tool') { step++; continue }
            const usage = { inputTokens: 10, outputTokens: 1 }
            events.push({ type: outcome === 'success' ? 'assistant/message' : 'assistant/attempt',
              data: { usage, message: { content: [{ type: 'text', text: outcome === 'success' ? '完成' : '' }] } } })
            if (outcome === 'success') { events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } }); return }
            const decision = await bus.waterfall('agent/request-error', { ...payload as object,
              provider: 'tutor', failure: { code: 'RATE_LIMIT', message: '429 fixture', providerRetryAfterMs: 90_000 } } as never, async () => undefined)
            if (decision?.kind !== 'retry') throw new Error('429 fixture')
          }
        } catch (error) {
          // Harness 会将 hook 异常变成日志；ask 应恢复原类型，不能仅靠字符串猜测。
          events.push({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'HOOK_ERROR', message: String(error) } } } })
        }
      })()
    },
  }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'tutor', model: 'fixture' }) },
    agents: { create: async ({ setup }: { setup: (ctx: Context) => void }) => { setup(bus); return { agent } } },
    sessions: { flush: async () => {} },
  }
  return { ctx: { get: (name: string) => services[name] } as unknown as Context, calls,
    counts: () => ({ followups, requestCount, downstreamRetries }) }
}

it('生成和独立审查的每次传输与内部重试都进入同一队列，429 先共享冷却再重试', async t => {
  for (const isolated of [false, true]) {
    const f = fixture(t, ['rate-limit', 'success'])
    const chat = (await createAgentChat(f.ctx, { ...(isolated ? { isolatedSystemPrompt: '独立审查' } : { tools: 'research' as const }), onProgress: () => {} }))!
    assert.equal(await chat.ask('请求'), '完成')
    assert.deepEqual(f.calls, ['acquire', 'cooldown:90000', 'acquire'])
    assert.deepEqual(f.counts(), { followups: 1, requestCount: 2, downstreamRetries: 1 })
    assert.deepEqual(chat.totalUsage(), { inputTokens: 20, outputTokens: 2 })
  }
})

it('明确的渠道等待不耗掉生成时限，等待结束仍可完成同一回合', async t => {
  const f = fixture(t, ['success'])
  t.mock.method(ModelRateLimiter.prototype, 'acquire', () => new Promise<void>(resolve => setTimeout(resolve, 60)))
  const chat = (await createAgentChat(f.ctx, { tools: 'research', deadlineMs: 20, onProgress: () => {} }))!
  assert.equal(await chat.ask('请求'), '完成')
  assert.equal(f.counts().followups, 1)
})

it('等待仍有单独上限，到期取消原回合且不叠加新请求', async t => {
  const f = fixture(t, ['success'])
  let cancelled = false
  t.mock.method(ModelRateLimiter.prototype, 'acquire', (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true })
  }))
  const chat = (await createAgentChat(f.ctx, { tools: 'research', deadlineMs: 20, maxWaitMs: 30, onProgress: () => {} }))!
  await assert.rejects(chat.ask('请求'), ModelWaitTimeoutError)
  assert.equal(cancelled, true)
  assert.equal(f.counts().followups, 1)
  assert.equal(f.counts().requestCount, 0)
})

it('连续多个 429 可退避后继续，传输重试不占用五次教研生成预算', async t => {
  const f = fixture(t, ['tool', 'tool', 'tool', 'tool', 'rate-limit', 'rate-limit', 'rate-limit', 'success'])
  const messages: string[] = []
  const chat = (await createAgentChat(f.ctx, { tools: 'research', onProgress: message => messages.push(message) }))!
  assert.equal(await chat.ask('请求'), '完成')
  assert.deepEqual(f.counts(), { followups: 1, requestCount: 8, downstreamRetries: 3 })
  assert.ok(messages.some(message => /第 3\/8 次恢复/.test(message)))
  assert.deepEqual(chat.totalUsage(), { inputTokens: 40, outputTokens: 4 })
})

it('持续无法恢复达到独立上限时才暂停整批，失败类型和费用仍保留', async t => {
  const attempts = MODEL_RECOVERY_LIMITS.retries + 1
  const f = fixture(t, Array.from({ length: attempts }, () => 'rate-limit'))
  const chat = (await createAgentChat(f.ctx, { tools: 'research', onProgress: () => {} }))!
  let requested = 0
  const map = { verified: false, nodes: [{ id: 'a', title: 'a', verified: false }, { id: 'b', title: 'b', verified: false }], edges: [] }
  await assert.rejects(researchNodes(map, ['a', 'b'], {
    research: async current => {
      requested++
      try { await chat.ask('请求') } catch (error) { throw new ContentReviewError('审查未完成', error) }
      return current
    },
    save: () => assert.fail('失败不能保存为完成'), permanentError: permanentModelError,
  }), (error: unknown) => error instanceof ContentReviewError && error.cause instanceof ModelRateLimitError)
  assert.equal(requested, 1)
  assert.deepEqual(f.counts(), { followups: 1, requestCount: attempts, downstreamRetries: attempts - 1 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: attempts * 10, outputTokens: attempts })
})

it('真正生成耗尽五次预算仍停止；最后一次生成遇到 429 可恢复而不增加生成轮数', async t => {
  const exhausted = fixture(t, ['tool', 'tool', 'tool', 'tool', 'tool'])
  const chat = (await createAgentChat(exhausted.ctx, { tools: 'research', onProgress: () => {} }))!
  await assert.rejects(chat.ask('请求'), ResearchBudgetError)
  assert.equal(exhausted.calls.filter(call => call === 'acquire').length, 5)
  const rate = fixture(t, ['tool', 'tool', 'tool', 'tool', 'rate-limit', 'success'])
  const rateChat = (await createAgentChat(rate.ctx, { tools: 'research', onProgress: () => {} }))!
  assert.equal(await rateChat.ask('请求'), '完成')
  assert.equal(rate.calls.filter(call => call === 'acquire').length, 6)
  assert.equal(rate.counts().downstreamRetries, 1)
})

it('同一步退避遵守渠道建议与递增间隔，认证/余额不足仍不作为瞬时故障重试', () => {
  const rate = { code: 'RATE_LIMIT', message: '429' }
  assert.equal(recoveryDelay(rate, 1, () => 0), 61_000)
  assert.equal(recoveryDelay(rate, 2, () => 0), 122_000)
  assert.equal(recoveryDelay(rate, 8, () => 0), 300_000)
  assert.equal(recoveryDelay({ ...rate, providerRetryAfterMs: 600_000 }, 8, () => 0), 600_000)
  assert.equal(transientModelFailure({ code: 'SERVER', message: 'busy', status: 503 }), true)
  assert.equal(transientModelFailure({ code: 'AUTH', message: 'unauthorized', status: 401 }), false)
  assert.equal(transientModelFailure({ ...rate, message: 'insufficient_quota' }), false)
})
