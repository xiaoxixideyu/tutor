import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addUsage,
  estimateCost,
  loadCostConfig,
  ratesForModel,
  DEFAULT_COST_CONFIG,
  type CostConfig,
} from '../src/core/cost.ts'

const config: CostConfig = {
  currency: '¥',
  defaultRates: { input: 2, output: 8 },
  modelRates: { 'glm-5.3-flash': { input: 1, output: 4 } },
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

describe('loadCostConfig', () => {
  it('解析模型覆盖与默认值，坏输入回退默认', () => {
    const parsed = loadCostConfig('currency: "$"\nrates:\n  default: {input: 3, output: 9}\n  foo: {input: 1, output: 2}')
    assert.equal(parsed.currency, '$')
    assert.deepEqual(ratesForModel(parsed, 'foo'), { input: 1, output: 2 })
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
