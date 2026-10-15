import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatRuntime, OutputLimitError, type ModelSettings } from '../src/runtime/chat.ts'
import { SessionLog } from '../src/runtime/session.ts'
import { normalizeUsage, type ReportedUsage } from '../src/core/cost.ts'
import type { LlmRequest, LlmResult, LlmTransport } from '../src/runtime/llm.ts'

const MODEL: ModelSettings = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model',
  thinking: 'default', contextWindow: 262144, requestsPerMinute: 8, researchDeadlineMs: 480_000 }

function runtimeWith(transport: LlmTransport, sessionsRoot: string): ChatRuntime {
  return new ChatRuntime({ model: MODEL, sessionsRoot, workspace: sessionsRoot, env: { ...process.env, TUTOR_MODEL_RATE_LIMIT_FILE: path.join(sessionsRoot, 'limits.sqlite') },
    transport, rateLimiter: new DisabledLimiter() as never })
}

// 测试不触碰真实 SQLite 队列；acquire/cooldown 由调度测试单独覆盖。
class DisabledLimiter {
  async acquire(): Promise<void> {}
  async cooldown(_signal: AbortSignal, retryAfterMs = 0): Promise<number> { return Math.max(61_000, retryAfterMs) }
}

function tmp(t: { after(cb: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-chat-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function queueTransport(results: LlmResult[], onCall?: (request: LlmRequest) => void): LlmTransport {
  let index = 0
  return async (request, _signal, onChunk) => {
    onCall?.(request)
    const result = results[index++]
    if (!result) throw new Error('不应发起额外请求')
    if (result.finish !== 'error') onChunk(true)
    return result
  }
}

const stop = (usage: ReportedUsage | undefined, text: string): LlmResult => ({ finish: 'stop', text, ...(usage ? { usage } : {}) })
const length = (usage: ReportedUsage): LlmResult => ({ finish: 'length', text: '', usage })
const failure = (code: string, message: string, extras: { providerRetryAfterMs?: number; usage?: ReportedUsage } = {}): LlmResult => {
  const { usage, ...error } = extras
  return { finish: 'error', error: { code, message, ...error }, ...(usage ? { usage } : {}) }
}

it('传输用量与缓存输入互不重叠，统一累计且拒绝无效计数', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 5 }),
    { inputTokens: 60, outputTokens: 5 })
  assert.equal(normalizeUsage({ inputTokens: NaN, outputTokens: 0 }), null)
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 0, cacheReadTokens: -1 }), null)
  assert.equal(normalizeUsage(undefined), null)
})

it('真实截断/重试用量计入同一回合，重复读取和下一回合不重复累计', async (t) => {
  const root = tmp(t)
  const runtime = runtimeWith(queueTransport([
    length({ inputTokens: 1390, outputTokens: 2048 }),
    stop({ inputTokens: 1266, cacheReadTokens: 1344, outputTokens: 1424 }, '评分完成'),
    stop({ inputTokens: 10, outputTokens: 2 }, '下一次'),
  ]), root)
  const chat = (await runtime.createChat())!
  assert.equal(await chat.ask('评分'), '评分完成')
  assert.deepEqual(chat.lastTurnUsage(), { inputTokens: 4000, outputTokens: 3472 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 4000, outputTokens: 3472 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 4000, outputTokens: 3472 })
  await chat.ask('下一次')
  assert.deepEqual(chat.lastTurnUsage(), { inputTokens: 10, outputTokens: 2 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 4010, outputTokens: 3474 })
})

it('恢复会话计入已报告的失败尝试用量，最终失败也不清掉成本', async (t) => {
  const root = tmp(t)
  const log = new SessionLog(root, root)
  log.messages.push({ role: 'user', content: '历史请求' })
  log.messages.push({ role: 'assistant', content: '历史回复' })
  log.persistMessages()
  log.appendEvent('assistant/attempt', { usage: { inputTokens: 10, cacheWriteTokens: 20, outputTokens: 3 } })
  const runtime = runtimeWith(queueTransport([
    failure('PI_AI_ERROR', '网关错误', { usage: { inputTokens: 100, outputTokens: 20 } }),
    length({ inputTokens: 200, outputTokens: 30 }),
  ]), root)
  const chat = (await runtime.createChat({ resumeSessionId: log.id }))!
  assert.deepEqual(chat.totalUsage(), { inputTokens: 30, outputTokens: 3 })
  assert.deepEqual(chat.lastTurnUsage(), { inputTokens: 0, outputTokens: 0 })
  await assert.rejects(chat.ask('失败'), /模型回合失败/)
  await chat.flush()
  assert.deepEqual(chat.lastTurnUsage(), { inputTokens: 300, outputTokens: 50 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 330, outputTokens: 53 })
})

it('主动中止不会自动重启模型回合，已产生的用量仍被保留', async (t) => {
  const root = tmp(t)
  const transport: LlmTransport = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError', usage: { inputTokens: 30, outputTokens: 8 } })
  }
  const chat = (await runtimeWith(transport, root).createChat())!
  await assert.rejects(chat.ask('中途取消'), { name: 'AbortError' })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 30, outputTokens: 8 })
})

it('空正文属于失败回合，仅重试一次并保留两次用量', async (t) => {
  const root = tmp(t)
  const chat = (await runtimeWith(queueTransport([
    stop({ inputTokens: 10, outputTokens: 20 }, ''),
    stop({ inputTokens: 15, outputTokens: 25 }, '有效正文'),
  ]), root).createChat())!
  assert.equal(await chat.ask('请求'), '有效正文')
  assert.deepEqual(chat.totalUsage(), { inputTokens: 25, outputTokens: 45 })
})

it('审查截断不重复原请求，404 等永久错误不重试，失败用量仍可读', async (t) => {
  const root = tmp(t)
  const lengthChat = (await runtimeWith(queueTransport([length({ inputTokens: 10, outputTokens: 4096 })]), root).createChat({ retryOnLength: false }))!
  await assert.rejects(lengthChat.ask('审查'), OutputLimitError)
  assert.equal(lengthChat.totalUsage().outputTokens, 4096)
  const unavailable = (await runtimeWith(queueTransport([failure('PI_AI_ERROR', '404 model is not found')]), root).createChat())!
  await assert.rejects(unavailable.ask('请求'), /404 model is not found/)
  for (const code of [401, 403, 404]) {
    const denied = (await runtimeWith(queueTransport([failure('PI_AI_ERROR', `${code}: unavailable`)]), root).createChat())!
    await assert.rejects(denied.ask('请求'), new RegExp(String(code)))
  }
})

it('已观察到的网关路由 404 走恢复退避，仍记录失败尝试费用；持续失败有明确上限', async (t) => {
  const root = tmp(t)
  const route: LlmResult = failure('PI_AI_ERROR', '404: {"message":"404 Route Not Found","type":"bad_response_status_code"}')
  const chat = (await runtimeWith(queueTransport([route, stop({ inputTokens: 3, outputTokens: 4 }, '恢复')]), root).createChat())!
  assert.equal(await chat.ask('请求'), '恢复')
  assert.deepEqual(chat.totalUsage(), { inputTokens: 3, outputTokens: 4 })
  const attempts = Array.from({ length: 9 }, () => route)
  const failed = (await runtimeWith(queueTransport(attempts), root).createChat())!
  await assert.rejects(failed.ask('持续失败'), /未恢复/)
})

it('请求总时限触发后中止在途请求并收敛，下一请求不会叠加旧回合', async (t) => {
  const root = tmp(t)
  let running = false
  let cancelled = 0
  const transport: LlmTransport = async (_request, signal) => {
    assert.equal(running, false)
    running = true
    return new Promise<LlmResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => { cancelled++; running = false; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
    })
  }
  const chat = (await runtimeWith(transport, root).createChat({ deadlineMs: 20 }))!
  await assert.rejects(chat.ask('第一次'), /总时限/)
  await assert.rejects(chat.ask('第二次'), /总时限/)
  assert.equal(cancelled, 2)
  assert.equal(running, false)
})
