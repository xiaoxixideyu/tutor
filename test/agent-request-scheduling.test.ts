import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatRuntime, permanentModelError, type ModelSettings } from '../src/runtime/chat.ts'
import { ContentReviewError } from '../src/flows/content-gate.ts'
import { ModelRateLimiter, ModelRateLimitError } from '../src/core/model-rate-limit.ts'
import { researchNodes } from '../src/core/research.ts'
import { ResearchBudgetError } from '../src/runtime/budget.ts'
import { ModelWaitTimeoutError } from '../src/runtime/timeouts.ts'
import { MODEL_RECOVERY_LIMITS, recoveryDelay, transientModelFailure } from '../src/core/model-recovery.ts'
import type { LlmResult, LlmTransport } from '../src/runtime/llm.ts'

const MODEL: ModelSettings = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture',
  thinking: 'default', contextWindow: 262144, requestsPerMinute: 8, researchDeadlineMs: 480_000 }

const usage = { inputTokens: 10, outputTokens: 1 }
const toolCall: LlmResult = { finish: 'tool_calls', text: '',
  toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'mcp__searchix__x_search', arguments: '{}' } }], usage }
const rateLimit: LlmResult = { finish: 'error', error: { code: 'RATE_LIMIT', message: '429 fixture', providerRetryAfterMs: 90_000 }, usage }
const success: LlmResult = { finish: 'stop', text: '完成', usage }

// 队列传输：按剧本返回结果；耗尽后断言失败，避免测试漏掉多余请求。
function scenario(results: LlmResult[]): { transport: LlmTransport; calls: () => number } {
  let calls = 0
  return { calls: () => calls, transport: async () => {
    const result = results[calls++]
    assert.ok(result, '不应发起额外请求')
    return result
  } }
}

function fixture(t: TestContext, outcomes: ('rate-limit' | 'tool' | 'success')[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-scheduling-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const calls: string[] = []
  t.mock.method(ModelRateLimiter.prototype, 'acquire', async () => { calls.push('acquire') })
  t.mock.method(ModelRateLimiter.prototype, 'cooldown', async (_signal: AbortSignal, retryAfterMs: number) => {
    calls.push(`cooldown:${retryAfterMs}`); return 61_000
  })
  const mapped = outcomes.map(outcome => outcome === 'tool' ? toolCall : outcome === 'rate-limit' ? rateLimit : success)
  const queue = scenario(mapped)
  const runtime = new ChatRuntime({
    model: MODEL, sessionsRoot: dir, workspace: dir, env: { ...process.env, TUTOR_MODEL_RATE_LIMIT_FILE: path.join(dir, 'limits.sqlite') },
    transport: queue.transport,
  })
  return { runtime, calls, transportCalls: queue.calls }
}

it('生成和独立审查的每次传输与内部重试都进入同一队列，429 先共享冷却再重试', async (t) => {
  for (const isolated of [false, true]) {
    const f = fixture(t, ['rate-limit', 'success'])
    const chat = (await f.runtime.createChat({ ...(isolated ? { isolatedSystemPrompt: '独立审查' } : { tools: 'research' as const }), onProgress: () => {} }))!
    assert.equal(await chat.ask('请求'), '完成')
    assert.deepEqual(f.calls, ['acquire', 'cooldown:90000', 'acquire'])
    assert.equal(f.transportCalls(), 2)
    assert.deepEqual(chat.totalUsage(), { inputTokens: 20, outputTokens: 2 })
  }
})

it('明确的渠道等待不耗掉生成时限，等待结束仍可完成同一回合', async (t) => {
  const f = fixture(t, ['success'])
  t.mock.method(ModelRateLimiter.prototype, 'acquire', () => new Promise<void>(resolve => setTimeout(resolve, 60)))
  const chat = (await f.runtime.createChat({ tools: 'research', deadlineMs: 20, onProgress: () => {} }))!
  assert.equal(await chat.ask('请求'), '完成')
  assert.equal(f.transportCalls(), 1)
})

it('等待仍有单独上限，到期取消原回合且不叠加新请求', async (t) => {
  const f = fixture(t, ['success'])
  let cancelled = false
  t.mock.method(ModelRateLimiter.prototype, 'acquire', (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true })
  }))
  const chat = (await f.runtime.createChat({ tools: 'research', deadlineMs: 20, maxWaitMs: 30, onProgress: () => {} }))!
  await assert.rejects(chat.ask('请求'), ModelWaitTimeoutError)
  assert.equal(cancelled, true)
  assert.equal(f.transportCalls(), 0)
})

it('连续多个 429 可退避后继续，传输重试不占用五次教研生成预算', async (t) => {
  const f = fixture(t, ['tool', 'tool', 'tool', 'tool', 'rate-limit', 'rate-limit', 'rate-limit', 'success'])
  const messages: string[] = []
  const chat = (await f.runtime.createChat({ tools: 'research', onProgress: message => messages.push(message) }))!
  assert.equal(await chat.ask('请求'), '完成')
  assert.equal(f.transportCalls(), 8)
  assert.equal(f.calls.filter(call => call === 'acquire').length, 8)
  assert.ok(messages.some(message => /第 3\/8 次恢复/.test(message)))
  assert.deepEqual(chat.totalUsage(), { inputTokens: 80, outputTokens: 8 })
})

it('持续无法恢复达到独立上限时才暂停整批，失败类型和费用仍保留', async (t) => {
  const attempts = MODEL_RECOVERY_LIMITS.retries + 1
  const f = fixture(t, Array.from({ length: attempts }, () => 'rate-limit'))
  const chat = (await f.runtime.createChat({ tools: 'research', onProgress: () => {} }))!
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
  assert.equal(f.transportCalls(), attempts)
  assert.deepEqual(chat.totalUsage(), { inputTokens: attempts * 10, outputTokens: attempts })
})

it('真正生成耗尽五次预算仍停止；最后一次生成遇到 429 可恢复而不增加生成轮数', async (t) => {
  const exhausted = fixture(t, ['tool', 'tool', 'tool', 'tool', 'tool'])
  const chat = (await exhausted.runtime.createChat({ tools: 'research', onProgress: () => {} }))!
  await assert.rejects(chat.ask('请求'), ResearchBudgetError)
  assert.equal(exhausted.calls.filter(call => call === 'acquire').length, 5)
  const rate = fixture(t, ['tool', 'tool', 'tool', 'tool', 'rate-limit', 'success'])
  const rateChat = (await rate.runtime.createChat({ tools: 'research', onProgress: () => {} }))!
  assert.equal(await rateChat.ask('请求'), '完成')
  assert.equal(rate.calls.filter(call => call === 'acquire').length, 6)
  assert.equal(rate.transportCalls(), 6)
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
  // 模型不存在是配置错误：即使网关把它包进 5xx 也不重试（实测 new-api 以 503 返回 model_not_found）。
  assert.equal(transientModelFailure({ code: 'SERVER', status: 503,
    message: '503: {"code":"model_not_found","message":"No available channel for model deepseek-v4-flash under group default (distributor)"}' }), false)
  assert.equal(transientModelFailure({ code: 'SERVER', status: 404, message: 'No available channel for model x' }), false)
})
