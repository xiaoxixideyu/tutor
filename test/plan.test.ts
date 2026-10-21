import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assemblePlan, buildPlanPath, masteredFromMastery, masteredFromProfile, planMapMismatch, planMapMismatchText, validateMilestoneDraft } from '../src/core/plan.ts'
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

describe('planMapMismatch', () => {
  const plan = assemblePlan(planPath, [], map.nodes.map((node) => node.id))

  it('计划覆盖当前地图时返回 null', () => {
    assert.equal(planMapMismatch(plan, map), null)
  })

  it('地图新增节点时报告未纳入计划的节点', () => {
    const extended = { ...map, nodes: [...map.nodes, { id: 'testing', title: '测试' }] }
    const mismatch = planMapMismatch(plan, extended)
    assert.deepEqual(mismatch?.missingFromMap, [])
    assert.deepEqual(mismatch?.notInPlan, ['testing'])
    assert.match(planMapMismatchText(mismatch!), /testing/)
  })

  it('地图删除节点时报告计划中的失效节点', () => {
    const reduced = { ...map, nodes: map.nodes.filter((node) => node.id !== 'channels') }
    const mismatch = planMapMismatch(plan, reduced)
    assert.deepEqual(mismatch?.missingFromMap, ['channels'])
    assert.deepEqual(mismatch?.notInPlan, [])
    assert.match(planMapMismatchText(mismatch!), /channels/)
  })

  it('旧计划没有 scope 时按完整拓扑图视为覆盖全部节点', () => {
    const legacy = { path: ['basics'], milestones: [], current: 'basics' }
    assert.equal(planMapMismatch(legacy, map), null)
  })

  it('旧计划经 PlanSchema 读回（scope 被补成空数组）仍按完整地图处理', () => {
    // PlanSchema 会把缺失的 scope 补成 []；空数组不能被当成"显式空范围"。
    const legacy = PlanSchema({ path: ['basics'], milestones: [], current: 'basics' })
    assert.deepEqual(legacy.scope, [])
    assert.equal(planMapMismatch(legacy, map), null)
  })

  it('current 为 null（历史数据）不当作节点引用', () => {
    const legacy = PlanSchema({ path: [], milestones: [], current: null })
    assert.equal(planMapMismatch(legacy, map), null)
  })

  it('单个里程碑节点数不能超过大考试卷容量', () => {
    const many = Array.from({ length: 11 }, (_, index) => `n${index}`)
    const result = validateMilestoneDraft({ milestones: [{ title: 'x', nodes: many }] }, many)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /超过单次大考上限/)
  })
})
