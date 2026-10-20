import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiMessage } from '../src/runtime/llm.ts'
import { ContextWindowError, estimateTokens, fitHistory, normalizeContextWindow, outputTokenLimit } from '../src/runtime/context.ts'

const user = (content: string): ApiMessage => ({ role: 'user', content })
const assistant = (content: string): ApiMessage => ({ role: 'assistant', content })

it('token 估算对中文和英文都偏保守', () => {
  assert.equal(estimateTokens('你好'), 2)
  assert.equal(estimateTokens('hello'), 2)
  assert.ok(estimateTokens('你好hello') >= 3)
  assert.equal(estimateTokens(''), 0)
})

it('输出上限随上下文窗口收紧', () => {
  assert.equal(outputTokenLimit(262144, 8192), 8192)
  assert.equal(outputTokenLimit(8192, 8192), 2457)
  assert.equal(outputTokenLimit(4096, 8192), 1228)
  assert.equal(outputTokenLimit(2048, 8192), 614)
  assert.equal(outputTokenLimit(1024, 8192), 256)
  assert.equal(outputTokenLimit(Number.NaN, 8192), 8192)
  assert.equal(normalizeContextWindow(512), 262144)
  assert.equal(normalizeContextWindow(4096), 4096)
})

it('裁剪历史时优先保留当前回合、上一回合与首回合', () => {
  const messages: ApiMessage[] = []
  for (let i = 0; i < 4; i++) {
    messages.push(user(`第${i}轮：${'甲'.repeat(96)}`))
    messages.push(assistant(`回答${i}：${'乙'.repeat(96)}`))
  }
  messages.push(user(`第4轮：${'丙'.repeat(96)}`))
  const fitted = fitHistory(10, messages, 550)
  assert.deepEqual(fitted.messages.map((message) => message.content?.slice(0, 3)), ['第0轮', '回答0', '第3轮', '回答3', '第4轮'])
  assert.equal(fitted.omitted, 4)
})

it('当前回合本身就超预算时给出确定错误，而不是发出超限请求', () => {
  const messages = [user('旧'), assistant('旧回答'), user('甲'.repeat(5000))]
  assert.throws(() => fitHistory(10, messages, 1000), ContextWindowError)
  assert.throws(() => fitHistory(2000, [user('新')], 1000), ContextWindowError)
})

it('只有一轮对话时原样保留', () => {
  const messages = [user('问题'), assistant('回答')]
  assert.deepEqual(fitHistory(10, messages, 1000).messages, messages)
})
