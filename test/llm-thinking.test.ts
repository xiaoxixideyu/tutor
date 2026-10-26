import test from 'node:test'
import assert from 'node:assert/strict'
import { thinkingRequestParams } from '../src/runtime/llm.ts'

test('minimax 系列把统一档位映射到 minimal/low/medium', () => {
  // 该渠道 default 仍对齐到 low，避免服务默认把输出预算烧在推理上。
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'default'), { reasoning_effort: 'low' })
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'off'), { reasoning_effort: 'minimal' })
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'minimal'), { reasoning_effort: 'minimal' })
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'low'), { reasoning_effort: 'low' })
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'medium'), { reasoning_effort: 'medium' })
  // 该系列只有三档，更高档回落到 medium。
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'high'), { reasoning_effort: 'medium' })
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'max'), { reasoning_effort: 'medium' })
  assert.deepEqual(thinkingRequestParams('MiniMax-M2.1', 'low'), { reasoning_effort: 'low' })
})

test('deepseek 系列映射到官方 low/high/max，并保留 thinking 兼容', () => {
  assert.deepEqual(thinkingRequestParams('deepseek-v4.1-flash', 'default'), {})
  assert.deepEqual(thinkingRequestParams('deepseek-v4.1-flash', 'off'), { thinking: { type: 'disabled' } })
  assert.deepEqual(thinkingRequestParams('deepseek-v4.1-flash', 'minimal'), { thinking: { type: 'enabled' }, reasoning_effort: 'low' })
  assert.deepEqual(thinkingRequestParams('deepseek-v4.1-flash', 'low'), { thinking: { type: 'enabled' }, reasoning_effort: 'low' })
  assert.deepEqual(thinkingRequestParams('deepseek-v4.1-flash', 'medium'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' })
  assert.deepEqual(thinkingRequestParams('deepseek-v4.1-flash', 'high'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' })
  assert.deepEqual(thinkingRequestParams('deepseek-v4.1-flash', 'max'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' })
  assert.deepEqual(thinkingRequestParams('deepseek-chat', 'max'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' })
})

test('其他模型按通用 reasoning_effort 传档位，默认不注入参数', () => {
  assert.deepEqual(thinkingRequestParams('gpt-4o', 'default'), {})
  assert.deepEqual(thinkingRequestParams('qwen-plus', 'default'), {})
  assert.deepEqual(thinkingRequestParams('gpt-4o', 'off'), { thinking: { type: 'disabled' } })
  assert.deepEqual(thinkingRequestParams('gpt-4o', 'low'), { reasoning_effort: 'low' })
  assert.deepEqual(thinkingRequestParams('gpt-4o', 'medium'), { reasoning_effort: 'medium' })
  assert.deepEqual(thinkingRequestParams('gpt-4o', 'high'), { reasoning_effort: 'high' })
  assert.deepEqual(thinkingRequestParams('gpt-4o', 'max'), { reasoning_effort: 'max' })
})
