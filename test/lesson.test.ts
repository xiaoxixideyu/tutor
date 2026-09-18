import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrepPrompt, buildTeachingIntro, currentNode, prerequisiteIds, validateLessonDraft } from '../src/core/lesson.ts'
import type { KnowledgeMap, LessonDraft, Mastery, Plan, Profile } from '../src/core/schema.ts'

const map: KnowledgeMap = {
  verified: false,
  nodes: [
    { id: 'goroutines', title: 'Goroutine', summary: '轻量级并发单元' },
    { id: 'channels', title: 'Channel', summary: 'CSP 通信' },
  ],
  edges: [['channels', 'goroutines']],
  resources: [],
}

const profile: Profile = {
  goal: '掌握 Go 后端开发',
  daily_minutes: 60,
  background: '5 年 Java 经验',
  style: '例子驱动，先动手后理论',
}

const draft: LessonDraft = {
  node: 'goroutines',
  title: 'Goroutine',
  hook: '从 Java 线程类比切入',
  structure: ['什么是 goroutine', 'go 关键字', '与线程的差异'],
  example: 'go fmt.Println("hi")',
  practice: [{ question: '如何启动一个 goroutine？', answer: 'go 函数调用' }],
  misconceptions: ['goroutine 等于线程'],
}

describe('validateLessonDraft', () => {
  it('合法备课通过', () => {
    const result = validateLessonDraft(draft, 'goroutines')
    assert.ok(result.ok)
  })

  it('node 不匹配报错', () => {
    assert.equal(validateLessonDraft(draft, 'channels').ok, false)
  })

  it('structure 超量报错', () => {
    const bad = { ...draft, structure: Array.from({ length: 9 }, (_, i) => `s${i}`) }
    assert.equal(validateLessonDraft(bad).ok, false)
  })

  it('practice 超量报错', () => {
    const bad = { ...draft, practice: Array.from({ length: 4 }, () => ({ question: 'q', answer: 'a' })) }
    assert.equal(validateLessonDraft(bad).ok, false)
  })

  it('缺字段报错', () => {
    const { example, ...noExample } = draft
    void example
    assert.equal(validateLessonDraft(noExample).ok, false)
  })
})

describe('currentNode', () => {
  const plan: Plan = { path: ['goroutines', 'channels'], milestones: [], current: 'goroutines' }

  it('返回首个未掌握节点', () => {
    assert.equal(currentNode(plan, { goroutines: { status: 'mastered', score: 1 } }), 'channels')
    assert.equal(currentNode(plan, undefined), 'goroutines')
  })

  it('全部已掌握返回 null', () => {
    assert.equal(currentNode(plan, { goroutines: { status: 'mastered' }, channels: { status: 'mastered' } }), null)
  })
})

describe('prerequisiteIds', () => {
  it('返回前置节点', () => {
    assert.deepEqual(prerequisiteIds(map, 'channels'), ['goroutines'])
    assert.deepEqual(prerequisiteIds(map, 'goroutines'), [])
  })
})

describe('buildPrepPrompt / buildTeachingIntro', () => {
  const mastery: Mastery = { goroutines: { status: 'weak', score: 0.3 } }

  it('备课 prompt 包含学员画像与本课信息', () => {
    const prompt = buildPrepPrompt({ courseId: 'golang', node: 'channels', map, plan: { path: ['goroutines'], milestones: [], current: 'goroutines' }, profile, mastery })
    assert.match(prompt, /channels/)
    assert.match(prompt, /goroutines（Goroutine）/)
    assert.match(prompt, /5 年 Java 经验/)
    assert.match(prompt, /例子驱动/)
  })

  it('教学首消息包含计划与练习，且为确定内容', () => {
    const intro1 = buildTeachingIntro({ courseId: 'golang', node: 'goroutines', plan: { path: ['goroutines'], milestones: [], current: 'goroutines' }, profile, mastery, draft })
    const intro2 = buildTeachingIntro({ courseId: 'golang', node: 'goroutines', plan: { path: ['goroutines'], milestones: [], current: 'goroutines' }, profile, mastery, draft })
    assert.equal(intro1, intro2)
    assert.match(intro1, /【本课计划】/)
    assert.match(intro1, /课中练习1/)
    assert.match(intro1, /goroutine 等于线程/)
  })
})
