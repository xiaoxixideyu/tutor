import test from 'node:test'
import assert from 'node:assert/strict'
import { capKnowledgeMap, mapNodeBudget, MAX_MAP_NODES } from '../src/flows/map-budget.ts'
import { mapPrompt } from '../src/flows/assess.ts'
import type { KnowledgeMap, Profile } from '../src/core/schema.ts'

const profile = (daily_minutes?: number): Profile => ({ goal: '三个月内从零学习 Go 后端开发', daily_minutes, background: '编程零基础', style: '中文讲解' })

const node = (id: string) => ({ id, title: id, summary: `${id} 概要` })

const map = (count: number): KnowledgeMap => ({
  verified: false,
  nodes: Array.from({ length: count }, (_, index) => node(`n${index + 1}`)),
  edges: Array.from({ length: Math.max(0, count - 1) }, (_, index) => [`n${index + 2}`, `n${index + 1}`] as [string, string]),
  resources: [],
})

test('地图体量上限：每日投入决定知识点数量区间，且永远不超过硬上限', () => {
  assert.equal(mapNodeBudget(profile(60)).max, MAX_MAP_NODES)
  assert.equal(mapNodeBudget(profile(30)).max, 6)
  assert.equal(mapNodeBudget(profile(90)).max, MAX_MAP_NODES)
  // 每日投入缺失时按 60 分钟兜底
  assert.equal(mapNodeBudget(profile(undefined)).max, MAX_MAP_NODES)
  for (const minutes of [10, 30, 45, 60, 120, 600]) {
    const budget = mapNodeBudget(profile(minutes))
    assert.ok(budget.min <= budget.max, `${minutes} 分钟：${budget.min}–${budget.max}`)
    assert.ok(budget.max <= MAX_MAP_NODES)
  }
})

test('超体量地图按学习进阶截断，并丢弃指向已截掉节点的依赖边', () => {
  const budget = mapNodeBudget(profile(60))
  const source = map(20)
  const { map: capped, truncated } = capKnowledgeMap(source, budget)
  assert.equal(truncated, 20 - budget.max)
  assert.equal(capped.nodes.length, budget.max)
  assert.deepEqual(capped.nodes.map(item => item.id), source.nodes.slice(0, budget.max).map(item => item.id))
  // 保留的边不得指向已截掉的节点
  const ids = new Set(capped.nodes.map(item => item.id))
  for (const [node, dependency] of capped.edges) {
    assert.ok(ids.has(node) && ids.has(dependency))
  }
  assert.equal(capped.edges.length, budget.max - 1)
})

test('未超体量的地图原样保留（不复制、不截断）', () => {
  const budget = mapNodeBudget(profile(60))
  const source = map(5)
  const result = capKnowledgeMap(source, budget)
  assert.equal(result.truncated, 0)
  assert.equal(result.map, source)
})

test('地图提示词显式给出节点数量上限与"只输出 JSON"约束', () => {
  const budget = mapNodeBudget(profile(60))
  const prompt = mapPrompt(profile(60), budget)
  assert.match(prompt, new RegExp(`节点总数控制在 ${budget.min}–${budget.max} 个之间`))
  assert.match(prompt, /每个 summary 不超过 40 字/)
  assert.match(prompt, /除该 JSON 外不要输出任何内容/)
  // 不能退回"数量不定"的写法：无上限会让推理模型把输出预算烧在推理里、正文为空
  assert.doesNotMatch(prompt, /没有最低数量/)
})
