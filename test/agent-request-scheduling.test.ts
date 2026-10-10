import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createAgentChat, permanentModelError } from '../src/plugin/agent-chat.ts'
import { ContentReviewError } from '../src/plugin/content-gate.ts'
import { ModelRateLimiter, ModelRateLimitError } from '../src/core/model-rate-limit.ts'
import { researchNodes } from '../src/core/research.ts'
import { ResearchBudgetError } from '../src/plugin/research-budget.ts'
import { TurnTimeoutError } from '../src/plugin/turn-timeout.ts'

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

it('队列等待计入回合总时限，超时取消等待且不叠加新回合', async t => {
  const f = fixture(t, ['success'])
  let cancelled = false
  t.mock.method(ModelRateLimiter.prototype, 'acquire', (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true })
  }))
  const chat = (await createAgentChat(f.ctx, { tools: 'research', deadlineMs: 20, onProgress: () => {} }))!
  await assert.rejects(chat.ask('请求'), TurnTimeoutError)
  assert.equal(cancelled, true)
  assert.equal(f.counts().followups, 1)
  assert.equal(f.counts().requestCount, 0)
})

it('重试后仍 429 时保留类型和费用，经过内容审查包装也立即停止整批', async t => {
  const f = fixture(t, ['rate-limit', 'rate-limit'])
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
  assert.deepEqual(f.counts(), { followups: 1, requestCount: 2, downstreamRetries: 1 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 20, outputTokens: 2 })
})

it('已耗尽研究预算时不进入请求队列；最后一次遇到 429 时保留渠道原因', async t => {
  const exhausted = fixture(t, ['tool', 'tool', 'tool', 'tool', 'tool'])
  const chat = (await createAgentChat(exhausted.ctx, { tools: 'research', onProgress: () => {} }))!
  await assert.rejects(chat.ask('请求'), ResearchBudgetError)
  assert.equal(exhausted.calls.filter(call => call === 'acquire').length, 5)
  const rate = fixture(t, ['tool', 'tool', 'tool', 'tool', 'rate-limit'])
  const rateChat = (await createAgentChat(rate.ctx, { tools: 'research', onProgress: () => {} }))!
  await assert.rejects(rateChat.ask('请求'), (error: unknown) => error instanceof ModelRateLimitError && /429.*无剩余重试预算/.test(error.message))
  assert.equal(rate.calls.filter(call => call === 'acquire').length, 5)
  assert.equal(rate.counts().downstreamRetries, 0)
})
