import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { createAgentChat, OutputLimitError } from '../src/plugin/agent-chat.ts'
import { normalizeUsage, type ReportedUsage } from '../src/core/cost.ts'

interface Event {
  type: string
  data?: { usage?: ReportedUsage; message?: { content: { type: string; text: string }[] }; reason?: { kind: string; error?: { code: string; message: string } } }
}
const output = (usage: ReportedUsage, text = '', type = 'assistant/message'): Event => ({ type,
  data: { usage, message: { content: [{ type: 'text', text }] } } })
const end = (kind: string): Event => ({ type: 'turn/end', data: { reason: { kind } } })

function fixture(initial: Event[], turns: Event[][]) {
  const events = [...initial]
  let turn = 0
  const agent = {
    session: { id: 'test-session', get seq() { return events.length }, eventAt: (seq: number) => events[seq] },
    whenIdle: async () => {},
    followup: () => { events.push(...turns[turn++]) },
  }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: { create: async () => ({ agent }), resume: async () => ({ agent }) },
    sessions: { flush: async () => {} },
  }
  return { get: (name: string) => services[name] } as unknown as Context
}

it('Harness 缓存输入与未缓存输入互不重叠，统一累计且拒绝无效计数', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 5 }),
    { inputTokens: 60, outputTokens: 5 })
  assert.equal(normalizeUsage({ inputTokens: NaN, outputTokens: 0 }), null)
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 0, cacheReadTokens: -1 }), null)
  assert.equal(normalizeUsage(undefined), null)
})

it('真实截断/重试用量计入同一回合，重复读取和下一回合不重复累计', async () => {
  const ctx = fixture([], [
    [output({ inputTokens: 1390, outputTokens: 2048 }), end('max-tokens')],
    [output({ inputTokens: 1266, cacheReadTokens: 1344, outputTokens: 1424 }, '评分完成'), end('completed')],
    [output({ inputTokens: 10, outputTokens: 2 }, '下一次'), end('completed')],
  ])
  const chat = (await createAgentChat(ctx))!
  assert.equal(await chat.ask('评分'), '评分完成')
  assert.deepEqual(chat.lastTurnUsage(), { inputTokens: 4000, outputTokens: 3472 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 4000, outputTokens: 3472 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 4000, outputTokens: 3472 })
  await chat.ask('下一次')
  assert.deepEqual(chat.lastTurnUsage(), { inputTokens: 10, outputTokens: 2 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 4010, outputTokens: 3474 })
})

it('恢复会话计入已报告的失败尝试用量，最终失败也不清掉成本', async () => {
  const ctx = fixture([output({ inputTokens: 10, cacheWriteTokens: 20, outputTokens: 3 }, '', 'assistant/attempt')], [
    [output({ inputTokens: 100, outputTokens: 20 }, '', 'assistant/attempt'), end('error')],
    [output({ inputTokens: 200, outputTokens: 30 }), end('max-tokens')],
  ])
  const chat = (await createAgentChat(ctx, { resumeSessionId: 'test-session' }))!
  assert.deepEqual(chat.totalUsage(), { inputTokens: 30, outputTokens: 3 })
  assert.deepEqual(chat.lastTurnUsage(), { inputTokens: 0, outputTokens: 0 })
  await assert.rejects(chat.ask('失败'), /模型回合失败/)
  await chat.flush()
  assert.deepEqual(chat.lastTurnUsage(), { inputTokens: 300, outputTokens: 50 })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 330, outputTokens: 53 })
})

it('主动中止不会自动重启模型回合，已产生的用量仍被保留', async () => {
  const ctx = fixture([], [[output({ inputTokens: 30, outputTokens: 8 }, '', 'assistant/attempt'), end('aborted')]])
  const chat = (await createAgentChat(ctx))!
  await assert.rejects(chat.ask('中途取消'), { name: 'AbortError' })
  assert.deepEqual(chat.totalUsage(), { inputTokens: 30, outputTokens: 8 })
})

it('空正文属于失败回合，仅重试一次并保留两次用量', async () => {
  const chat = (await createAgentChat(fixture([], [
    [output({ inputTokens: 10, outputTokens: 20 }), end('completed')],
    [output({ inputTokens: 15, outputTokens: 25 }, '有效正文'), end('completed')],
  ])))!
  assert.equal(await chat.ask('请求'), '有效正文')
  assert.deepEqual(chat.totalUsage(), { inputTokens: 25, outputTokens: 45 })
})

it('审查截断不重复原请求，404 等永久错误不重试，失败用量仍可读', async () => {
  const length = (await createAgentChat(fixture([], [[output({ inputTokens: 10, outputTokens: 4096 }), end('max-tokens')]]), { retryOnLength: false }))!
  await assert.rejects(length.ask('审查'), OutputLimitError)
  assert.equal(length.totalUsage().outputTokens, 4096)
  const unavailable = (await createAgentChat(fixture([], [[{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: '404 model is not found' } } } }]])))!
  await assert.rejects(unavailable.ask('请求'), /404 model is not found/)
  for (const code of [401, 403, 404]) {
    const denied = (await createAgentChat(fixture([], [[{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: `${code}: unavailable` } } } }]])))!
    await assert.rejects(denied.ask('请求'), new RegExp(String(code)))
  }
})

it('已观察到的网关路由 404 只重试一次，仍记录失败尝试费用', async () => {
  const route: Event = { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'PI_AI_ERROR',
    message: '404: {"message":"404 Route Not Found","type":"bad_response_status_code"}' } } } }
  const chat = (await createAgentChat(fixture([], [
    [output({ inputTokens: 2, outputTokens: 0 }, '', 'assistant/attempt'), route],
    [output({ inputTokens: 3, outputTokens: 4 }, '恢复'), end('completed')],
  ])))!
  assert.equal(await chat.ask('请求'), '恢复')
  assert.deepEqual(chat.totalUsage(), { inputTokens: 5, outputTokens: 4 })
  const failed = (await createAgentChat(fixture([], [[route], [route]])))!
  await assert.rejects(failed.ask('持续失败'), /模型回合失败/)
})

it('请求总时限触发后取消 agent 并收敛，下一请求不会叠加旧回合', async () => {
  let running = false
  let cancelled = 0
  let resolveIdle: (() => void) | undefined
  const agent = {
    session: { id: 'bounded', seq: 0, eventAt: () => undefined },
    followup: () => { assert.equal(running, false); running = true },
    whenIdle: () => running ? new Promise<void>(resolve => { resolveIdle = resolve }) : Promise.resolve(),
    cancel: () => { cancelled++; running = false; resolveIdle?.() },
  }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: { create: async () => ({ agent }) }, sessions: { flush: async () => {} },
  }
  const chat = (await createAgentChat({ get: (name: string) => services[name] } as unknown as Context, { deadlineMs: 20 }))!
  await assert.rejects(chat.ask('第一次'), /总时限/)
  await assert.rejects(chat.ask('第二次'), /总时限/)
  assert.equal(cancelled, 2)
  assert.equal(running, false)
})
