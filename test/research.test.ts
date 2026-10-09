import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CourseStore } from '../src/core/store.ts'
import { mergeResearchBatch } from '../src/core/knowledge.ts'
import { pendingResearchNodes, ResearchProgressStore, researchNodes } from '../src/core/research.ts'
import { mapContent } from '../src/core/content-quality.ts'
import { QualityStore } from '../src/core/quality-store.ts'
import type { KnowledgeMap } from '../src/core/schema.ts'

const initial: KnowledgeMap = { verified: false, nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, title: id, verified: false })), edges: [] }
const complete = (map: KnowledgeMap, id: string) => mergeResearchBatch(map, {
  nodes: [{ id, verified: true }], resources: [
    { node: id, title: '官方资料', url: 'https://python.org/' + id },
    { node: id, title: '独立资料', url: 'https://example.org/' + id },
  ],
})

it('单点教研保留骨架标题和其他节点，只合入经过核查的摘要与来源', () => {
  const result = mergeResearchBatch(initial, { nodes: [{ id: 'a', title: '模型同义改写', summary: '补充摘要' }] }, { preserveTitles: true })
  assert.equal(result.nodes[0].title, 'a')
  assert.equal(result.nodes[0].summary, '补充摘要')
  assert.deepEqual(result.nodes.slice(1), initial.nodes.slice(1))
  assert.deepEqual(result.edges, initial.edges)
})

it('逐个落盘；中间节点失败后继续其他节点，重启只需补未完成项', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-research-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new CourseStore(root)
  store.create('course', { goal: '逐点教研' })
  store.write('course', 'knowledge-map', initial)
  const saved: string[][] = []
  const result = await researchNodes(initial, ['a', 'b', 'c', 'd'], {
    research: async (map, id) => { if (id === 'b') throw new Error('搜索暂不可用'); return complete(map, id) },
    save: map => { store.write('course', 'knowledge-map', map); saved.push(map.nodes.filter(node => node.verified).map(node => node.id)) },
  })
  assert.deepEqual(saved, [['a'], ['a', 'c'], ['a', 'c', 'd']])
  assert.deepEqual(result.failed, ['b'])
  const disk = new CourseStore(root).read('course', 'knowledge-map') as KnowledgeMap
  const requested: string[] = []
  const resumed = await researchNodes(disk, disk.nodes.filter(node => !node.verified).map(node => node.id), {
    research: async (map, id) => { requested.push(id); return complete(map, id) },
    save: map => store.write('course', 'knowledge-map', map),
  })
  assert.deepEqual(requested, ['b'])
  assert.equal(resumed.map.verified, true)
})

it('连续两个失败后停止，避免对整张大地图逐个重复空耗', async () => {
  const requested: string[] = []
  const result = await researchNodes(initial, ['a', 'b', 'c', 'd'], {
    research: async (_map, id) => { requested.push(id); throw new Error('模型超时') }, save: () => assert.fail('没有已完成内容可保存'),
  })
  assert.deepEqual(requested, ['a', 'b'])
  assert.equal(result.stopped, true)
  assert.deepEqual(result.map, initial)
})

it('来源不足的已保存节点也能断点续研，完成标记不授予来源验证或内容准入', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-research-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new CourseStore(root), progress = new ResearchProgressStore(root, 'course')
  const profile = { goal: '逐点教研' }
  store.create('course', profile)
  const result = await researchNodes(initial, ['a'], {
    research: async map => mergeResearchBatch(map, { nodes: [{ id: 'a', summary: '只有官方来源', verified: true }],
      resources: [{ node: 'a', title: '官方资料', url: 'https://python.org/a' }] }),
    save: (map, node) => { store.write('course', 'knowledge-map', map); progress.save(map, profile, node) },
  })
  const disk = store.read('course', 'knowledge-map') as KnowledgeMap
  assert.equal(result.map.nodes[0].verified, false)
  assert.equal(disk.nodes[0].verified, false)
  assert.deepEqual(pendingResearchNodes(disk, profile, new ResearchProgressStore(root, 'course')), ['b', 'c', 'd'])
  assert.equal(new QualityStore(root, 'course').approved(mapContent(disk, profile)), false)
})

it('教研断点绑定本节点内容和课程范围；其他节点增加资料不使已有断点失效', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-research-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const progress = new ResearchProgressStore(root, 'course'), profile = { goal: '逐点教研' }
  const map = mergeResearchBatch(initial, { nodes: [{ id: 'b', summary: '已核查摘要' }], resources: [{ node: 'b', title: '来源', url: 'https://python.org/b' }] })
  progress.save(map, profile, 'b')
  const extended = mergeResearchBatch(map, { nodes: [{ id: 'a', summary: '另一个摘要' }], resources: [{ node: 'a', title: '资料', url: 'https://example.org/a' }] })
  assert.equal(progress.completed(extended, profile, 'b'), true)
  assert.equal(progress.completed({ ...extended, resources: [...extended.resources!].reverse() }, profile, 'b'), true)
  assert.equal(progress.completed(mergeResearchBatch(map, { nodes: [{ id: 'b', summary: '改过摘要' }] }), profile, 'b'), false)
  assert.equal(progress.completed({ ...map, resources: [] }, profile, 'b'), false)
  assert.equal(progress.completed({ ...map, edges: [['b', 'a']] }, profile, 'b'), false)
  assert.equal(progress.completed(map, { goal: '课程目标发生变化' }, 'b'), false)
  const verified = complete(initial, 'b')
  progress.save(verified, profile, 'b')
  assert.equal(progress.status(verified, profile, 'b'), 'verified')
  const stale = { ...verified, nodes: verified.nodes.map(node => node.id === 'b' ? { ...node, summary: '新增待验证内容' } : node) }
  assert.equal(progress.status(stale, profile, 'b'), 'pending', '旧 verified 标记不能掩盖已知内容变更')
  assert.ok(pendingResearchNodes(stale, profile, progress).includes('b'))
  fs.writeFileSync(path.join(root, 'course/research-progress/b.json'), '{broken')
  assert.equal(progress.completed(map, profile, 'b'), false)
  assert.equal(progress.status(verified, profile, 'b'), 'pending')
  assert.throws(() => new ResearchProgressStore(root, '../other'))
  assert.throws(() => progress.save(map, profile, '../b'))
})

it('落盘失败、主动取消和认证失败都立即停止，不继续生成后续节点', async () => {
  for (const mode of ['save', 'cancel', 'auth']) {
    let calls = 0
    await assert.rejects(researchNodes(initial, ['a', 'b'], {
      research: async (map, id) => {
        calls++
        if (mode === 'cancel') throw Object.assign(new Error('取消'), { name: 'AbortError' })
        if (mode === 'auth') throw new Error('401 unauthorized')
        return complete(map, id)
      },
      save: () => { throw new Error('无法保存') },
      permanentError: error => error instanceof Error && error.message.includes('401'),
    }))
    assert.equal(calls, 1)
  }
})
