import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { createAgentChat } from '../src/plugin/agent-chat.ts'
import { normalizeUsage, type ReportedUsage } from '../src/core/cost.ts'

interface Event {
  type: string
  data?: { usage?: ReportedUsage; message?: { content: { type: string; text: string }[] }; reason?: { kind: string } }
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
