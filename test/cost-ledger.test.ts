import { it } from 'node:test'
import assert from 'node:assert/strict'
import { CostLedger, recordChatDelta, recordChatTotal, withChatUsage } from '../src/flows/cost-ledger.ts'
import type { CostConfig, UsageSample } from '../src/core/cost.ts'
import type { AgentChat } from '../src/runtime/chat.ts'

const config: CostConfig = {
  currency: '¥',
  defaultRates: { input: 2, output: 8 },
  modelRates: { premium: { input: 10, output: 20 } },
}

function fakeChat(model: string, usage: UsageSample): AgentChat {
  return {
    sessionId: 's', model, ask: async () => '', flush: async () => {}, lastReply: () => '', lastReplySeq: () => null,
    lastTurnUsage: () => usage, totalUsage: () => usage,
  }
}

it('成本台账按模型分别计价并汇总', () => {
  const ledger = new CostLedger()
  ledger.record('standard', { inputTokens: 1_000_000, outputTokens: 500_000 }, 'prep')
  ledger.record('premium', { inputTokens: 1_000_000, outputTokens: 0 }, 'review')
  ledger.record('standard', { inputTokens: 0, outputTokens: 0 }, 'noise')
  const summary = ledger.summary(config)
  assert.equal(ledger.size, 2)
  assert.equal(summary.inputTokens, 2_000_000)
  assert.equal(summary.outputTokens, 500_000)
  assert.equal(summary.cost, 16)
  assert.deepEqual(summary.byModel.map((item) => [item.model, item.cost]), [['standard', 6], ['premium', 10]])
})

it('recordChatDelta 只记增量，recordChatTotal 记当前累计，withChatUsage 异常也记录', async () => {
  const ledger = new CostLedger()
  let usage: UsageSample = { inputTokens: 10, outputTokens: 5 }
  const chat = { model: 'standard', totalUsage: () => ({ ...usage }) }
  recordChatTotal(ledger, chat, 'total')
  usage = { inputTokens: 30, outputTokens: 15 }
  recordChatDelta(ledger, chat, { inputTokens: 10, outputTokens: 5 }, 'delta')
  assert.deepEqual(ledger.entries.map((entry) => entry.usage), [{ inputTokens: 10, outputTokens: 5 }, { inputTokens: 20, outputTokens: 10 }])

  const failingUsage: UsageSample = { inputTokens: 0, outputTokens: 0 }
  const failing = { ...fakeChat('standard', failingUsage), totalUsage: () => ({ ...failingUsage }) }
  await assert.rejects(withChatUsage(ledger, failing, 'failed', async () => {
    failingUsage.inputTokens = 7
    failingUsage.outputTokens = 3
    throw new Error('boom')
  }), /boom/)
  assert.equal(ledger.entries.at(-1)?.source, 'failed')
  assert.deepEqual(ledger.entries.at(-1)?.usage, { inputTokens: 7, outputTokens: 3 })
})
