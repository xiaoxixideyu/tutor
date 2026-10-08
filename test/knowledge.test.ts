import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { enforceSourceVerification, mergeResearchBatch, sourceDomains } from '../src/core/knowledge.ts'
import { CourseStore } from '../src/core/store.ts'
import type { KnowledgeMap } from '../src/core/schema.ts'

const resource = (url: string, node = 'channels') => ({ node, title: '资料', url })
const map: KnowledgeMap = { verified: true, nodes: [{ id: 'channels', title: 'Channel', verified: true }], edges: [],
  resources: [resource('https://go.dev/doc'), resource('https://pkg.go.dev/builtin')] }

it('同站页面、子域、公共后缀与非法地址不能冒充独立来源', () => {
  assert.deepEqual(sourceDomains([
    ...map.resources!, resource('https://www.go.dev/doc#section'),
    resource('https://one.example.co.uk/a'), resource('https://two.example.co.uk/b'),
    resource('https://independent.org'), resource('https://elsewhere.com', 'other'),
    resource('file:///tmp/source'), resource('http://127.0.0.1'), resource('broken'),
    resource('https://user:password@private.com'),
  ], 'channels'), ['example.co.uk', 'go.dev', 'independent.org'])
  assert.equal(enforceSourceVerification(map).verified, false)
})

it('至少两个来源域名且教研确认才标验证，资料数量不替代内容核对', () => {
  const two = { ...map, resources: [...map.resources!, resource('https://eli.thegreenplace.net/go')] }
  assert.equal(enforceSourceVerification(two).verified, true)
  assert.equal(enforceSourceVerification({ ...two, nodes: [{ ...two.nodes[0], verified: false }] }).verified, false)
  assert.equal(enforceSourceVerification({ ...map, nodes: [] }).verified, false)
})

it('教研重做只采用本批检查后留下的资料，死链剔除后不能沿用旧验证', () => {
  const original = { ...map, nodes: [...map.nodes, { id: 'other', title: '其他' }],
    resources: [...map.resources!, resource('https://old-source.com'), resource('https://other.org', 'other')] }
  const merged = mergeResearchBatch(original, { nodes: [{ id: 'channels', verified: true }],
    resources: [resource('https://go.dev/new')] })
  assert.equal(merged.nodes[0].verified, false)
  assert.equal(merged.nodes[0].title, 'Channel')
  assert.equal(merged.resources!.length, 2)
  assert.ok(merged.resources!.some((r) => r.node === 'other'))
  assert.equal(original.nodes[0].verified, true)
  assert.equal(original.resources.length, 4)
})

it('旧课程读入时降级证据不足的标记，读取不改写原文件；后续写入执行同一规则', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-evidence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new CourseStore(root)
  store.create('alpha', { goal: '测试' })
  const file = path.join(root, 'alpha', 'knowledge-map.yaml')
  const original = JSON.stringify(map)
  fs.writeFileSync(file, original)
  assert.equal((store.read('alpha', 'knowledge-map') as KnowledgeMap).verified, false)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
  store.write('alpha', 'knowledge-map', map)
  assert.equal((store.read('alpha', 'knowledge-map') as KnowledgeMap).nodes[0].verified, false)
})
