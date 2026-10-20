import { it } from 'node:test'
import assert from 'node:assert/strict'
import { validateBatch } from '../src/flows/research.ts'

it('教研稿超过正文与摘要长度时先拒绝校验，保留限定条件供模型完整改写', () => {
  const ids = new Set(['model-choice'])
  const draft = { nodes: [{ id: 'model-choice', title: '模型选型', summary: '按实际任务比较模型。', verified: false }],
    resources: [{ node: 'model-choice', title: '一手资料', url: 'https://example.org/models', note: '已读取相关片段。', material: '根据任务质量、延迟与成本选择模型。' }] }
  assert.equal(validateBatch(draft, ids).ok, true)
  for (const [group, field, limit] of [['nodes', 'summary', 120], ['nodes', 'title', 120],
    ['resources', 'material', 180], ['resources', 'note', 120], ['resources', 'title', 120]] as const) {
    const atLimit = structuredClone(draft)
    ;(atLimit[group][0] as Record<string, unknown>)[field] = '字'.repeat(limit)
    assert.equal(validateBatch(atLimit, ids).ok, true)
    const tooLong = structuredClone(atLimit)
    ;(tooLong[group][0] as Record<string, unknown>)[field] += '字'
    const result = validateBatch(tooLong, ids)
    assert.equal(result.ok, false)
    if (!result.ok) {
      // 报出当前字数与需删字数，模型才能一次压缩到位（只写"超过 120 字"会反复微缩）。
      assert.match(result.error, new RegExp(`${field} 超限（当前 ${limit + 1} 字 / 上限 ${limit} 字，需再删约 1 字）`))
      assert.match(result.error, /保留必要限定条件，不机械截断/)
    }
    assert.equal((tooLong[group][0] as Record<string, string>)[field].length, limit + 1, '校验不擅自裁剪候选内容')
  }
})

it('多个字段同时超限时一次性全部报出，避免逐字段来回拉锯', () => {
  const ids = new Set(['model-choice'])
  const draft = { nodes: [{ id: 'model-choice', title: '模型选型', summary: '把范围写得很长'.repeat(20), verified: false }],
    resources: [{ node: 'model-choice', title: '一手资料', url: 'https://example.org/models', note: '一句话'.repeat(41), material: '事实'.repeat(100) }] }
  const result = validateBatch(draft, ids)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /summary 超限/)
    assert.match(result.error, /note 超限/)
    assert.match(result.error, /material 超限/)
    assert.match(result.error, /压缩策略/)
  }
})
