import test from 'node:test'
import assert from 'node:assert/strict'
import { thinkingRequestParams } from '../src/runtime/llm.ts'

test('minimax 系列用 reasoning_effort 表达推理强度：三档单调不降', () => {
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'off'), { reasoning_effort: 'minimal' })
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'default'), { reasoning_effort: 'low' })
  assert.deepEqual(thinkingRequestParams('minimax-m3.1-flash', 'on'), { reasoning_effort: 'medium' })
  // 大小写与后缀变体同样识别
  assert.deepEqual(thinkingRequestParams('MiniMax-M2.1', 'default'), { reasoning_effort: 'low' })
})

test('deepseek 网关路由开启推理时下发最高档 max，官方路由保持 thinking', () => {
  assert.deepEqual(thinkingRequestParams('deepseek-v4.1-flash', 'on'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' })
  assert.deepEqual(thinkingRequestParams('deepseek-v4-pro', 'on'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' })
  assert.deepEqual(thinkingRequestParams('deepseek-chat', 'on'), { thinking: { type: 'enabled' } })
  assert.deepEqual(thinkingRequestParams('deepseek-reasoner', 'off'), { thinking: { type: 'disabled' } })
  assert.deepEqual(thinkingRequestParams('deepseek-chat', 'default'), {})
})

test('其他模型保持原有行为：跟随服务默认，不注入额外参数', () => {
  assert.deepEqual(thinkingRequestParams('gpt-4o', 'default'), {})
  assert.deepEqual(thinkingRequestParams('qwen-plus', 'default'), {})
  // 非 minimax 的显式开关仍按原来的 thinking 参数下发（由渠道自行决定是否识别）
  assert.deepEqual(thinkingRequestParams('gpt-4o', 'on'), { thinking: { type: 'enabled' } })
  assert.deepEqual(thinkingRequestParams('gpt-4o', 'off'), { thinking: { type: 'disabled' } })
})
