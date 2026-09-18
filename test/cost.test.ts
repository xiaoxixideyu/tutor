import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addUsage,
  costColor,
  estimateCost,
  formatTotalCost,
  formatTurnCost,
  loadCostConfig,
  ratesForModel,
  DEFAULT_COST_CONFIG,
  type CostConfig,
} from '../src/core/cost.ts'

const config: CostConfig = {
  currency: '¥',
  defaultRates: { input: 2, output: 8 },
  modelRates: { 'glm-5.3-flash': { input: 1, output: 4 } },
  warn: 0.05,
  alarm: 0.2,
}

describe('ratesForModel', () => {
  it('模型覆盖优先，否则默认', () => {
    assert.deepEqual(ratesForModel(config, 'glm-5.3-flash'), { input: 1, output: 4 })
    assert.deepEqual(ratesForModel(config, 'other'), { input: 2, output: 8 })
  })
})

describe('estimateCost', () => {
  it('input/output 分别计价（每 1M）', () => {
    assert.equal(estimateCost({ inputTokens: 1_000_000, outputTokens: 0 }, { input: 2, output: 8 }), 2)
    assert.equal(estimateCost({ inputTokens: 500_000, outputTokens: 250_000 }, { input: 2, output: 8 }), 3)
    assert.equal(estimateCost({ inputTokens: 0, outputTokens: 0 }, config.defaultRates), 0)
  })
})

describe('costColor', () => {
  it('绿/黄/红阈值', () => {
    assert.equal(costColor(0.001, config), 'green')
    assert.equal(costColor(0.05, config), 'yellow')
    assert.equal(costColor(0.06, config), 'yellow')
    assert.equal(costColor(0.2, config), 'red')
  })
})

describe('formatting', () => {
  it('回合行含币种/tokens/颜色码', () => {
    const line = formatTurnCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'glm-5.3-flash', config, true)
    assert.match(line, /¥5\.0000（输入 1000k · 输出 1000k）/)
    assert.match(line, /\x1b\[31m/)
    const mid = formatTurnCost({ inputTokens: 12_300, outputTokens: 0 }, 'glm-5.3-flash', config, false)
    assert.match(mid, /输入 12\.3k/)
    const plain = formatTurnCost({ inputTokens: 8339, outputTokens: 381 }, 'glm-5.3-flash', config, false)
    assert.match(plain, /¥0\.0099（输入 8339 · 输出 381）/)
    assert.doesNotMatch(plain, /\x1b\[/)
  })

  it('总成本行带回合数', () => {
    const line = formatTotalCost({ inputTokens: 10_000, outputTokens: 500 }, 'm', config, false, 6)
    assert.match(line, /会话累计（6 回合）/)
  })
})

describe('loadCostConfig', () => {
  it('解析模型覆盖与阈值，坏输入回退默认', () => {
    const parsed = loadCostConfig('currency: "$"\nrates:\n  default: {input: 3, output: 9}\n  foo: {input: 1, output: 2}\nturn_cost: {warn: 0.01, alarm: 0.5}')
    assert.equal(parsed.currency, '$')
    assert.deepEqual(ratesForModel(parsed, 'foo'), { input: 1, output: 2 })
    assert.equal(parsed.warn, 0.01)
    assert.equal(parsed.alarm, 0.5)
    assert.deepEqual(loadCostConfig(':::broken yaml [').defaultRates, DEFAULT_COST_CONFIG.defaultRates)
    assert.deepEqual(loadCostConfig(undefined), DEFAULT_COST_CONFIG)
  })
})

describe('addUsage', () => {
  it('累加', () => {
    assert.deepEqual(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 10, outputTokens: 20 }), {
      inputTokens: 11,
      outputTokens: 22,
    })
  })
})
