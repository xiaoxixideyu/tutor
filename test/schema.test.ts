import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ProfileSchema,
  KnowledgeMapSchema,
  LearnerProfileSchema,
  PlanSchema,
  MasterySchema,
} from '../src/core/schema.ts'

const profileFromDesign = {
  goal: '掌握 Go 后端开发，能独立完成 Web 服务',
  deadline: '2026-12-31',
  daily_minutes: 60,
  background: '有 5 年 Java 后端经验',
  style: '例子驱动，先动手后理论',
}

const planFromDesign = {
  path: ['interfaces', 'goroutines', 'channels', 'context', 'testing'],
  milestones: [{ id: 'm1', title: '能写出并发安全的 worker pool', nodes: ['goroutines', 'channels'] }],
  current: 'goroutines',
}

const masteryFromDesign = {
  goroutines: { status: 'learning', score: 0.6, review_due: '2026-09-09' },
}

describe('ProfileSchema', () => {
  it('接受设计文档示例', () => {
    const out = ProfileSchema(profileFromDesign)
    assert.equal(out.goal, profileFromDesign.goal)
    assert.equal(out.daily_minutes, 60)
  })

  it('缺失 goal 报错', () => {
    assert.throws(() => ProfileSchema({ daily_minutes: 60 }), /goal/)
  })

  it('deadline 必须是 YYYY-MM-DD', () => {
    assert.throws(() => ProfileSchema({ ...profileFromDesign, deadline: 'next year' }), /校验失败|expect/)
  })
})

describe('KnowledgeMapSchema', () => {
  it('edges/resources 缺省补空', () => {
    const out = KnowledgeMapSchema({ nodes: [{ id: 'goroutines', title: 'Goroutines' }] })
    assert.deepEqual(out.edges, [])
    assert.deepEqual(out.resources, [])
    assert.equal(out.verified, false)
  })

  it('节点 id 必须是 slug', () => {
    assert.throws(
      () => KnowledgeMapSchema({ nodes: [{ id: 'Bad Node!', title: 'x' }] }),
      /校验失败|expect/
    )
  })

  it('一期未联网验证默认 verified=false', () => {
    const out = KnowledgeMapSchema({ nodes: [{ id: 'a', title: 'A' }] })
    assert.equal(out.verified, false)
  })
})

describe('LearnerProfileSchema', () => {
  it('接受逐知识点画像', () => {
    const out = LearnerProfileSchema({
      assessed_at: '2026-09-17',
      nodes: { goroutines: { score: 0.8, evidence: '摸底 3/4 对' } },
    })
    assert.equal(out.nodes.goroutines.score, 0.8)
  })

  it('score 超出 [0,1] 报错', () => {
    assert.throws(
      () => LearnerProfileSchema({ assessed_at: '2026-09-17', nodes: { a: { score: 1.5 } } }),
      /校验失败|expect/
    )
  })
})

describe('PlanSchema', () => {
  it('接受设计文档示例', () => {
    const out = PlanSchema(planFromDesign)
    assert.deepEqual(out.path, planFromDesign.path)
    assert.equal(out.milestones[0].id, 'm1')
  })
})

describe('MasterySchema', () => {
  it('接受设计文档示例', () => {
    const out = MasterySchema(masteryFromDesign)
    assert.equal(out.goroutines.status, 'learning')
  })

  it('status 只允许四个枚举值', () => {
    assert.throws(() => MasterySchema({ goroutines: { status: 'ok' } }), /校验失败|expect/)
  })
})
