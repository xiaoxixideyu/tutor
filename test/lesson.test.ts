import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPrepPrompt, buildCheckPrompt, buildTeachingIntro, checkCitations, currentNode, lessonStructureCap, memoryNotes, prerequisiteIds, resourcesForNode, selectInterleaveQuestion, selectWarmupQuestions, stalePrerequisites, validateLessonDraft } from '../src/core/lesson.ts'
import { parseLessonIntro } from '../src/core/fidelity.ts'
import { judgeQuizAnswer, statusForScore, updateMasteryForNode } from '../src/core/assessment.ts'
import { CourseStore } from '../src/core/store.ts'
import type { KnowledgeMap, LessonDraft, LessonState, Mastery, Plan, Profile, QuestionBank } from '../src/core/schema.ts'

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
  flow: 'Java 线程太重，所以需要更轻的并发单元；goroutine 由 go 关键字启动，调度方式又与线程不同。',
  structure: ['什么是 goroutine', 'go 关键字', '与线程的差异'],
  example: 'go fmt.Println("hi")',
  practice: [{ question: '如何启动一个 goroutine？', answer: 'go 函数调用' }],
  quiz: [
    { question: 'go 关键字的作用？', choices: ['启动 goroutine', '终止进程', '锁住变量', '关闭通道'], answer: 'A' },
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

  it('structure 超量报错（默认上限 5，可按时长传入更严上限）', () => {
    const five = { ...draft, structure: Array.from({ length: 5 }, (_, i) => `s${i}`) }
    assert.equal(validateLessonDraft(five).ok, true) // 5 个：默认上限内
    const six = { ...draft, structure: Array.from({ length: 6 }, (_, i) => `s${i}`) }
    assert.equal(validateLessonDraft(six).ok, false) // 6 个：超默认上限
    const four = { ...draft, structure: Array.from({ length: 4 }, (_, i) => `s${i}`) }
    assert.equal(validateLessonDraft(four, undefined, 3).ok, false) // 传入上限 3：4 个超量
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

  it('空标题/开场/例子/空要点/空题干被拒绝', () => {
    assert.equal(validateLessonDraft({ ...draft, title: '  ' }).ok, false)
    assert.equal(validateLessonDraft({ ...draft, hook: '' }).ok, false)
    assert.equal(validateLessonDraft({ ...draft, flow: '  ' }).ok, false)
    assert.equal(validateLessonDraft({ ...draft, example: ' ' }).ok, false)
    assert.equal(validateLessonDraft({ ...draft, structure: ['要点', ''] }).ok, false)
    assert.equal(validateLessonDraft({ ...draft, practice: [{ question: '', answer: 'a' }] }).ok, false)
    assert.equal(validateLessonDraft({ ...draft, quiz: [{ question: ' ', choices: ['A. 1', 'B. 2', 'C. 3', 'D. 4'], answer: 'A' }, draft.quiz[1]] }).ok, false)
  })

  it('旧教案没有 flow 仍可恢复，新教案的 flow 参与校验', () => {
    const { flow, ...legacy } = draft
    void flow
    assert.equal(validateLessonDraft(legacy).ok, true)
    assert.equal(validateLessonDraft(draft).ok, true)
  })
})

describe('lessonStructureCap', () => {
  it('按每日投入时长收紧，夹在 3–5', () => {
    assert.equal(lessonStructureCap(60), 4) // 60/15=4
    assert.equal(lessonStructureCap(90), 5) // 90/15=6 → 封顶 5
    assert.equal(lessonStructureCap(20), 3) // 约 1 → 保底 3
    assert.equal(lessonStructureCap(undefined), 3) // 默认 30/15=2 → 保底 3
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
    const prompt = buildPrepPrompt({ courseId: 'golang', node: 'channels', map, plan: { path: ['goroutines', 'channels'], milestones: [], current: 'channels' }, profile, mastery })
    assert.match(prompt, /channels/)
    assert.match(prompt, /goroutines（Goroutine）/)
    assert.match(prompt, /5 年 Java 经验/)
    assert.match(prompt, /例子驱动/)
    assert.match(prompt, /最多 4 个要点/) // daily_minutes=60 → cap 4，硬约束进 prompt
    assert.match(prompt, /structure 每项写成一句可讲授的结论/)
    assert.match(prompt, /从【已学与前置内容】或上一课留下的问题\/局限出发/)
    assert.match(prompt, /本课因果链/)
    assert.match(prompt, /禁止把本课写成“术语定义 → 特点 → 用法”的清单/)
    assert.match(prompt, /【已学与前置内容】/)
    assert.match(prompt, /上一课 goroutines（Goroutine）：轻量级并发单元/)
  })

  it('教学首消息包含计划与练习，且为确定内容', () => {
    const plan: Plan = { path: ['goroutines'], milestones: [], current: 'goroutines' }
    const intro1 = buildTeachingIntro({ courseId: 'golang', node: 'goroutines', plan, profile, map, mastery, draft })
    const intro2 = buildTeachingIntro({ courseId: 'golang', node: 'goroutines', plan, profile, map, mastery, draft })
    assert.equal(intro1, intro2)
    assert.match(intro1, /【本课计划】/)
    assert.match(intro1, /课中练习1/)
    assert.match(intro1, /goroutine 等于线程/)
    assert.match(intro1, /【讲授格式】/)
    assert.match(intro1, /一句话记住/)
    assert.match(intro1, /把 structure 里的每个要点讲成一句可复述的结论/)
    assert.match(intro1, /先用一句话接住上一课\/【已学与前置内容】/)
    assert.match(intro1, /【开课约定】本课没有已学内容：不要编造上一课/)
    assert.match(intro1, /本课脉络：/)
    assert.match(intro1, /引入新术语前先说明它解决什么具体问题/)
    // 新增的已学内容/脉络块不能干扰忠实度审计对 structure 的解析。
    assert.deepEqual(parseLessonIntro(intro1)?.structure, draft.structure)
  })

  it('教学首消息注入上一课与前置摘要，供开场衔接', () => {
    const intro = buildTeachingIntro({
      courseId: 'golang', node: 'channels', plan: { path: ['goroutines', 'channels'], milestones: [], current: 'channels' },
      profile, map, draft: { ...draft, node: 'channels', title: 'Channel' },
    })
    assert.match(intro, /【已学与前置内容】/)
    assert.match(intro, /上一课 goroutines（Goroutine）：轻量级并发单元/)
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

  it('weak 清除复习到期，learning/mastered 按记忆稳定性排期', () => {
    const first = updateMasteryForNode(undefined, 'goroutines', 0.6, '2026-09-17')
    assert.equal(first.goroutines.status, 'learning')
    // 首学 hard：1.5 × 1.4 = 2.1 天
    assert.equal(first.goroutines.review_due, '2026-09-19')
    assert.equal(first.goroutines.stability, 2.1)
    assert.equal(first.goroutines.last_touched_at, '2026-09-17')
    const mastered = updateMasteryForNode(first, 'goroutines', 1, '2026-09-20')
    assert.equal(mastered.goroutines.status, 'mastered')
    // 隔 3 天 easy 且逾期加成：2.1 × 2.4 × 1.13 ≈ 5.69 → 6 天
    assert.equal(mastered.goroutines.review_due, '2026-09-26')
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
    assert.doesNotMatch(prompt, /【本课资料】/)
    const promptWith = buildPrepPrompt({ courseId: 'golang', node: 'x', map: { verified: true, nodes: [], edges: [], resources: [{ node: 'x', title: 'T', url: 'https://x', material: '正文' }] }, plan: { path: ['x'], milestones: [], current: 'x' }, profile })
    assert.match(promptWith, /尚未完成交叉验证/)
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

describe('记忆状态注入与开课热身（FSRS-lite）', () => {
  const today = '2026-09-18'
  // goroutines 距上次实测 30 天、稳定性 7 天 → 保留率约 64%（低保留，应热身）
  const masteryWithMemory: Mastery = {
    goroutines: { status: 'mastered', score: 1, review_stage: 3, stability: 7, last_touched_at: '2026-08-19' },
  }

  it('备课 prompt 注入最近学习与前置保留率，并提示低保留先重建', () => {
    const prompt = buildPrepPrompt({ courseId: 'golang', node: 'channels', map, plan: { path: ['channels'], milestones: [], current: 'channels' }, profile, mastery: masteryWithMemory, today })
    assert.match(prompt, /最近一次学习\/复习：2026-08-19（距今 30 天）/)
    assert.match(prompt, /goroutines（Goroutine）：mastered 1（距上次实测 30 天，预计保留 ≈/)
    assert.match(prompt, /建议先回忆热身/)
    assert.match(prompt, /保留率低的前置：开场先用类比或最小例子重建/)
  })

  it('无实测锚点的旧数据不注入记忆注记', () => {
    const prompt = buildPrepPrompt({ courseId: 'golang', node: 'channels', map, plan: { path: ['channels'], milestones: [], current: 'channels' }, profile, mastery: { goroutines: { status: 'mastered', score: 1, review_stage: 3 } }, today })
    assert.doesNotMatch(prompt, /距上次实测/)
    assert.doesNotMatch(prompt, /最近一次学习/)
  })

  it('selectWarmupQuestions 只挑低保留/到期的前置，最多 2 个，优先 d2', () => {
    const bank: QuestionBank = {
      goroutines: [
        { id: 'g1', difficulty: 1, type: 'choice', question: 'q1', choices: ['A', 'B'], answer: 'A' },
        { id: 'g2', difficulty: 2, type: 'choice', question: 'q2', choices: ['A', 'B'], answer: 'A' },
      ],
    }
    const picks = selectWarmupQuestions(map, masteryWithMemory, bank, 'channels', today)
    assert.deepEqual(picks.map((p) => p.node), ['goroutines'])
    assert.equal(picks[0].question.id, 'g2')
    const fresh: Mastery = { goroutines: { status: 'mastered', score: 1, stability: 30, last_touched_at: '2026-09-17' } }
    assert.deepEqual(selectWarmupQuestions(map, fresh, bank, 'channels', today), [])
    const due: Mastery = { goroutines: { status: 'mastered', score: 1, review_due: '2026-09-10', review_stage: 2 } }
    assert.equal(selectWarmupQuestions(map, due, bank, 'channels', today).length, 1)
    assert.deepEqual(selectWarmupQuestions(map, masteryWithMemory, {}, 'channels', today), [])
  })

  it('memoryNotes 给出记忆卡；教学首消息注入记忆与热身结果', () => {
    const notes = memoryNotes(map, masteryWithMemory, 'channels', today)
    assert.deepEqual(notes.map((n) => n.node), ['goroutines'])
    assert.equal(notes[0].elapsedDays, 30)
    const intro = buildTeachingIntro({
      courseId: 'golang', node: 'channels', plan: { path: ['channels'], milestones: [], current: 'channels' }, profile,
      mastery: masteryWithMemory, draft: { ...draft, node: 'channels', title: 'Channel' },
      memory: notes, warmup: [{ node: 'goroutines', question: 'q2', correct: false }],
    })
    assert.match(intro, /【学员记忆状态】/)
    assert.match(intro, /预计保留 ≈/)
    assert.match(intro, /【开课热身】/)
    assert.match(intro, /✗ 答错/)
    assert.match(intro, /热身有答错/)
  })
})

describe('交错回访与前置新鲜度软门', () => {
  const today = '2026-09-18'
  const bank: QuestionBank = {
    goroutines: [
      { id: 'g1', difficulty: 1, type: 'choice', question: 'g1?', choices: ['A', 'B'], answer: 'A' },
      { id: 'g2', difficulty: 2, type: 'choice', question: 'g2?', choices: ['A', 'B'], answer: 'A' },
    ],
  }
  // goroutines 距上次实测 30 天、稳定性 7 天 → 保留率低，是回访首选
  const lowRetention: Mastery = { goroutines: { status: 'mastered', score: 1, review_stage: 3, stability: 7, last_touched_at: '2026-08-19' } }

  it('selectInterleaveQuestion：保留率最低优先、优先 d2、可排除热身题、无候选返回 null', () => {
    const pick = selectInterleaveQuestion(map, lowRetention, bank, 'channels', today)
    assert.equal(pick?.node, 'goroutines')
    assert.equal(pick?.question.id, 'g2')
    const fallback = selectInterleaveQuestion(map, lowRetention, bank, 'channels', today, ['g2'])
    assert.equal(fallback?.question.id, 'g1')
    assert.equal(selectInterleaveQuestion(map, lowRetention, bank, 'goroutines', today), null)
    assert.equal(selectInterleaveQuestion(map, { goroutines: { status: 'learning' } }, bank, 'channels', today), null)
    assert.equal(selectInterleaveQuestion(map, lowRetention, {}, 'channels', today), null)
  })

  it('selectInterleaveQuestion：到期无锚点旧数据比新鲜节点优先', () => {
    const mastery: Mastery = {
      goroutines: { status: 'mastered', score: 1, review_due: '2026-09-10', review_stage: 2 },
      channels: { status: 'mastered', score: 1, stability: 30, last_touched_at: '2026-09-17' },
    }
    const bankTwo: QuestionBank = { ...bank, channels: [{ id: 'c1', difficulty: 2, type: 'choice', question: 'c1?', choices: ['A', 'B'], answer: 'A' }] }
    const pick = selectInterleaveQuestion(map, mastery, bankTwo, 'other', today)
    assert.equal(pick?.node, 'goroutines')
  })

  it('stalePrerequisites：低保留与严重逾期报警，非 mastered 与新鲜节点不报', () => {
    const stale = stalePrerequisites(map, lowRetention, 'channels', today)
    assert.deepEqual(stale.map((item) => item.node), ['goroutines'])
    assert.ok((stale[0].retention ?? 1) < 0.75)
    assert.equal(stale[0].elapsedDays, 30)
    const due: Mastery = { goroutines: { status: 'mastered', score: 1, review_due: '2026-09-01', review_stage: 2 } }
    assert.equal(stalePrerequisites(map, due, 'channels', today).length, 1)
    const fresh: Mastery = { goroutines: { status: 'mastered', score: 1, stability: 30, last_touched_at: '2026-09-17' } }
    assert.deepEqual(stalePrerequisites(map, fresh, 'channels', today), [])
    const learning: Mastery = { goroutines: { status: 'learning', score: 0.5, review_due: '2026-08-01' } }
    assert.deepEqual(stalePrerequisites(map, learning, 'channels', today), [])
  })

  it('备课 prompt 注入错因、校准与课堂反馈；缺省不注入', () => {
    const prompt = buildPrepPrompt({
      courseId: 'golang', node: 'channels', map, plan: { path: ['channels'], milestones: [], current: 'channels' }, profile, mastery: lowRetention, today,
      errors: [{ node: 'goroutines', question: '这道题的问题', your: '我答错的内容' }],
      calibration: { at: '2026-09-17', predicted: 90, actual: 0.5 },
      styleNotes: [{ at: '2026-09-15', kind: 'confused', detail: '太快了' }],
    })
    assert.match(prompt, /【学员常见错误】/)
    assert.match(prompt, /我答错的内容/)
    assert.match(prompt, /【自我评估校准】/)
    assert.match(prompt, /高估/)
    assert.match(prompt, /【课堂反馈】/)
    assert.match(prompt, /放慢节奏/)
    const plain = buildPrepPrompt({ courseId: 'golang', node: 'channels', map, plan: { path: ['channels'], milestones: [], current: 'channels' }, profile, mastery: lowRetention, today })
    assert.doesNotMatch(plain, /【学员常见错误】/)
    assert.doesNotMatch(plain, /【自我评估校准】/)
    assert.doesNotMatch(plain, /【课堂反馈】/)
  })
})
