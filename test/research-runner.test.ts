import { it } from 'node:test'
import assert from 'node:assert/strict'
import { validateBatch, pruneResources } from '../src/flows/research.ts'

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

it('summary 写了教研过程说明时拒绝，并提示改写成学习范围', () => {
  const ids = new Set(['shenlun-material'])
  const narrated = { nodes: [{ id: 'shenlun-material', title: '申论材料阅读',
    summary: '本课训练要点提炼；因暂未取得可核对资料，命题依据暂不纳入结论。', verified: false }], resources: [] }
  const rejected = validateBatch(narrated, ids)
  assert.equal(rejected.ok, false)
  if (!rejected.ok) {
    // 这类句子会经备课提示词进入课堂，学员不需要知道资料是否查到。
    assert.match(rejected.error, /教研过程说明/)
    assert.match(rejected.error, /未取得/)
    assert.match(rejected.error, /verified=false/)
  }
  const clean = { nodes: [{ id: 'shenlun-material', title: '申论材料阅读',
    summary: '材料读完没有要点：先审题定位设问，再按段落关键词归纳成要点。', verified: false }], resources: [] }
  assert.equal(validateBatch(clean, ids).ok, true)
  // "未取得许可"是正常的法律表述，不能被过程自述规则误杀。
  const legal = { nodes: [{ id: 'shenlun-material', title: '申论材料阅读',
    summary: '未取得许可擅自经营的处理：先定行为性质，再按许可与处罚条款组织答案。', verified: false }], resources: [] }
  assert.equal(validateBatch(legal, ids).ok, true)
})

it('教研批次里不合格的来源在合并前被剔除并说明原因', async () => {
  const resources = [
    { node: 'shenlun-material', title: '百度百科', url: 'https://baike.baidu.com/item/x' },
    { node: 'shenlun-material', title: '搜索结果页', url: 'https://lite.duckduckgo.com/lite/?q=x' },
  ]
  const messages: string[] = []
  await pruneResources(resources, (text) => messages.push(text))
  assert.equal(resources.length, 0)
  assert.equal(messages.length, 2)
  assert.match(messages.join(''), /来源不合格，已剔除/)
})
