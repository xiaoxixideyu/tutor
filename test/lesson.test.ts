import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPrepPrompt, buildCheckPrompt, buildTeachingIntro, checkCitations, currentNode, prerequisiteIds, resourcesForNode, validateLessonDraft } from '../src/core/lesson.ts'
import { judgeQuizAnswer, statusForScore, updateMasteryForNode } from '../src/core/assessment.ts'
import { CourseStore } from '../src/core/store.ts'
import type { KnowledgeMap, LessonDraft, LessonState, Mastery, Plan, Profile } from '../src/core/schema.ts'

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
  quiz: [
    { question: 'go 关键字的作用？', answer: '启动 goroutine' },
    { question: '1+1=?', choices: ['A. 1', 'B. 2', 'C. 3', 'D. 4'], answer: 'B' },
  ],
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

  it('quiz 数量不合规报错', () => {
    assert.equal(validateLessonDraft({ ...draft, quiz: [draft.quiz[0]] }).ok, false)
    assert.equal(
      validateLessonDraft({ ...draft, quiz: Array.from({ length: 4 }, () => ({ question: 'q', answer: 'a' })) }).ok,
      false
    )
  })

  it('quiz 选择题选项/答案不合规报错', () => {
    const badChoice = { ...draft, quiz: [{ question: 'q', choices: ['A. 1', 'B. 2'], answer: 'B' }, draft.quiz[1]] }
    assert.equal(validateLessonDraft(badChoice).ok, false)
    const badLetter = { ...draft, quiz: [{ question: 'q', choices: ['A. 1', 'B. 2', 'C. 3', 'D. 4'], answer: 'E' }, draft.quiz[1]] }
    assert.equal(validateLessonDraft(badLetter).ok, false)
  })

  it('缺 quiz 报错', () => {
    const { quiz, ...noQuiz } = draft
    void quiz
    assert.equal(validateLessonDraft(noQuiz).ok, false)
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

describe('judgeQuizAnswer', () => {
  it('选择题按字母/全文判分', () => {
    const item = draft.quiz[1]
    assert.equal(judgeQuizAnswer(item, 'b'), true)
    assert.equal(judgeQuizAnswer(item, 'B. 2'), true)
    assert.equal(judgeQuizAnswer(item, 'a'), false)
  })

  it('简答题按 answer/accept 判分', () => {
    const item = { question: '如何启动 goroutine？', answer: 'go 函数调用', accept: ['go 关键字'] }
    assert.equal(judgeQuizAnswer(item, 'GO 函数调用'), true)
    assert.equal(judgeQuizAnswer(item, 'go 关键字'), true)
    assert.equal(judgeQuizAnswer(item, 'async'), false)
  })
})

describe('statusForScore / updateMasteryForNode', () => {
  it('分数映射与摸底一致', () => {
    assert.equal(statusForScore(0.9), 'mastered')
    assert.equal(statusForScore(0.5), 'learning')
    assert.equal(statusForScore(0.2), 'weak')
  })

  it('weak 清除复习到期，learning/mastered 设置并递增间隔', () => {
    const first = updateMasteryForNode(undefined, 'goroutines', 0.6, '2026-09-17')
    assert.equal(first.goroutines.status, 'learning')
    assert.equal(first.goroutines.review_due, '2026-09-18')
    const mastered = updateMasteryForNode(first, 'goroutines', 1, '2026-09-20')
    assert.equal(mastered.goroutines.status, 'mastered')
    assert.equal(mastered.goroutines.review_due, '2026-09-23')
    const backToWeak = updateMasteryForNode(mastered, 'goroutines', 0.2, '2026-09-25')
    assert.equal(backToWeak.goroutines.status, 'weak')
    assert.equal('review_due' in (backToWeak.goroutines ?? {}), false)
  })
})

describe('updateMasteryForNode 保留其他节点', () => {
  it('更新保留其他节点', () => {
    const base: Mastery = { channels: { status: 'learning', score: 0.6, review_due: '2026-09-18' } }
    const updated = updateMasteryForNode(base, 'goroutines', 0.9, '2026-09-17')
    assert.deepEqual(updated.channels, { status: 'learning', score: 0.6, review_due: '2026-09-18' })
  })
})

describe('LessonState（断点续学状态）', () => {
  it('lesson.yaml 写读删 round-trip，草稿嵌套校验生效', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-lesson-'))
    try {
      const store = new CourseStore(dir)
      store.create('golang', { goal: 'x' })
      const state: LessonState = {
        session_id: 'session-abc',
        node: 'goroutines',
        started_at: '2026-09-17',
        draft,
      }
      store.write('golang', 'lesson', state)
      const restored = store.read('golang', 'lesson') as LessonState
      assert.equal(restored.session_id, 'session-abc')
      assert.equal(restored.node, 'goroutines')
      assert.equal(restored.draft.node, 'goroutines')
      assert.equal(restored.draft.quiz.length, 2)
      assert.equal(restored.draft.quiz[1].choices?.length, 4)
      const broken = { ...state, draft: { ...draft, example: 123 } }
      assert.throws(() => store.write('golang', 'lesson', broken), /校验失败/)
      store.remove('golang', 'lesson')
      assert.equal(store.has('golang', 'lesson'), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('资料注入与引用核对（二期）', () => {
  const resources = [
    { index: 1, title: '官方入门', url: 'https://go.dev/doc/tutorial', material: '官方第一课…'.repeat(80) },
    { index: 2, title: '模块指南', note: '与官方交叉验证一致' },
  ]

  it('resourcesForNode 过滤并编号', () => {
    const map = { verified: true, nodes: [], edges: [], resources: [
      { node: 'a', title: 'A 资源' },
      { node: 'b', title: 'B 资源' },
    ] }
    assert.equal(resourcesForNode(map.resources, 'a').length, 1)
    assert.equal(resourcesForNode(map.resources, 'a')[0].index, 1)
    assert.equal(resourcesForNode(undefined, 'a').length, 0)
  })

  it('备课 prompt 与教学首消息包含资料清单', () => {
    const prompt = buildPrepPrompt({ courseId: 'golang', node: 'goroutines', map: { verified: true, nodes: [], edges: [], resources: [] }, plan: { path: ['goroutines'], milestones: [], current: 'goroutines' }, profile })
    assert.doesNotMatch(prompt, /已验证资料/)
    const promptWith = buildPrepPrompt({ courseId: 'golang', node: 'x', map: { verified: true, nodes: [], edges: [], resources: [{ node: 'x', title: 'T', url: 'https://x', material: '正文' }] }, plan: { path: ['x'], milestones: [], current: 'x' }, profile })
    assert.match(promptWith, /已验证资料/)
    assert.match(promptWith, /https:\/\/x/)
    const intro = buildTeachingIntro({ courseId: 'golang', node: 'x', plan: { path: ['x'], milestones: [], current: 'x' }, profile, draft, resources })
    assert.match(intro, /本课资料/)
    assert.match(intro, /1\. 官方入门 https:\/\/go\.dev\/doc\/tutorial/)
  })

  it('checkCitations：有效/无效标记与未引用警告', () => {
    const ok = checkCitations('Go 是静态编译语言 [资料:1]。', 2)
    assert.deepEqual(ok.cited, [1])
    assert.deepEqual(ok.invalid, [])
    const bad = checkCitations('见 [资料:9]。', 2)
    assert.deepEqual(bad.invalid, [9])
    const uncited = checkCitations('事实上，goroutine 的初始栈很小。', 2)
    assert.equal(uncited.uncitedWarning, true)
    assert.equal(checkCitations('你可以先跑一下这个例子。', 2).uncitedWarning, false)
  })

  it('buildCheckPrompt 包含资料与讲授记录', () => {
    const prompt = buildCheckPrompt(['第一段发言', '第二段发言'], resources)
    assert.match(prompt, /【资料】/)
    assert.match(prompt, /--- 第2段 ---/)
    assert.match(prompt, /第二段发言/)
  })
})
