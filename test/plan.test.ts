import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assemblePlan, buildPlanPath, masteredFromMastery, masteredFromProfile, validateMilestoneDraft } from '../src/core/plan.ts'
import { PlanSchema } from '../src/core/schema.ts'
import type { KnowledgeMap, LearnerProfile, Mastery } from '../src/core/schema.ts'

const map: KnowledgeMap = {
  verified: false,
  nodes: [
    { id: 'basics', title: '基础' },
    { id: 'goroutines', title: 'Goroutine' },
    { id: 'channels', title: 'Channel' },
    { id: 'context', title: 'Context' },
  ],
  edges: [
    ['goroutines', 'basics'],
    ['channels', 'goroutines'],
    ['context', 'channels'],
  ],
  resources: [],
}

describe('buildPlanPath', () => {
  it('全量路径按依赖排序', () => {
    assert.deepEqual(buildPlanPath(map, new Set()), ['basics', 'goroutines', 'channels', 'context'])
  })

  it('跳过已掌握知识点', () => {
    const path = buildPlanPath(map, new Set(['basics', 'goroutines']))
    assert.deepEqual(path, ['channels', 'context'])
  })

  it('masteredFromMastery / masteredFromProfile', () => {
    const mastery: Mastery = {
      basics: { status: 'mastered', score: 1 },
      goroutines: { status: 'weak', score: 0.2 },
    }
    assert.deepEqual([...masteredFromMastery(mastery)], ['basics'])
    const profile: LearnerProfile = {
      assessed_at: '2026-09-17',
      nodes: {
        basics: { score: 0.9 },
        goroutines: { score: 0.79 },
      },
    }
    assert.deepEqual([...masteredFromProfile(profile)], ['basics'])
  })
})

const planPath = ['basics', 'goroutines', 'channels', 'context']

describe('validateMilestoneDraft', () => {
  const path = planPath

  it('合法里程碑通过', () => {
    const draft = {
      milestones: [
        { title: '能写出基础程序', nodes: ['basics', 'goroutines'] },
        { title: '能用 channel 通信', nodes: ['channels'] },
      ],
    }
    const result = validateMilestoneDraft(draft, path)
    assert.ok(result.ok)
    assert.equal(result.ok && result.value.length, 2)
  })

  it('节点不在路径中报错', () => {
    const draft = { milestones: [{ title: 'x', nodes: ['ghost'] }] }
    const result = validateMilestoneDraft(draft, path)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /路径中/)
  })

  it('节点跨里程碑重复报错', () => {
    const draft = {
      milestones: [
        { title: 'x', nodes: ['basics'] },
        { title: 'y', nodes: ['basics'] },
      ],
    }
    assert.equal(validateMilestoneDraft(draft, path).ok, false)
  })

  it('打乱路径顺序报错', () => {
    const draft = {
      milestones: [
        { title: 'x', nodes: ['channels'] },
        { title: 'y', nodes: ['basics'] },
      ],
    }
    assert.equal(validateMilestoneDraft(draft, path).ok, false)
  })

  it('空 milestones / 空 nodes / 缺 title 均报错', () => {
    assert.equal(validateMilestoneDraft({ milestones: [] }, path).ok, false)
    assert.equal(validateMilestoneDraft({ milestones: [{ title: 'x', nodes: [] }] }, path).ok, false)
    assert.equal(validateMilestoneDraft({ milestones: [{ nodes: ['basics'] }] }, path).ok, false)
  })
})

describe('assemblePlan', () => {
  it('分配里程碑 id，current 指向路径首节点，且通过 PlanSchema', () => {
    const plan = assemblePlan(planPath, [
      { title: '第一阶段', nodes: ['basics', 'goroutines'] },
      { title: '第二阶段', nodes: ['channels', 'context'] },
    ])
    assert.equal(plan.milestones[0].id, 'm1')
    assert.equal(plan.milestones[1].id, 'm2')
    assert.equal(plan.current, 'basics')
    assert.equal(PlanSchema(plan).path.length, 4)
  })

  it('空路径时省略 current', () => {
    const plan = assemblePlan([], [])
    assert.equal('current' in plan, false)
  })
})
