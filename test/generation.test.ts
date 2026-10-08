import { it } from 'node:test'
import assert from 'node:assert/strict'
import { generateTurn } from '../src/plugin/generation.ts'

it('最后一次修正仍会被校验并返回，判分失败有界退出', async () => {
  let calls = 0
  const chat = { ask: async () => String(++calls) }
  const result = await generateTurn(chat, '评分', (text) => text === '4'
    ? { ok: true, value: 1 } : { ok: false, error: '缺少题目' })
  assert.equal(result, 1)
  assert.equal(calls, 4)
  calls = 0
  await assert.rejects(generateTurn(chat, '评分', () => ({ ok: false, error: '缺少题目' })), /多次生成/)
  assert.equal(calls, 4)
})
