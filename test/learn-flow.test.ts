import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runLearn } from '../src/flows/learn.ts'
import { FlowExit, type FlowIO } from '../src/flows/io.ts'
import type { FlowDeps } from '../src/flows/deps.ts'
import { CourseStore } from '../src/core/store.ts'
import type { CreateChatOptions, AgentChat } from '../src/runtime/chat.ts'
import type { KnowledgeMap, LessonDraft, Mastery, Plan, Profile, QuestionBank } from '../src/core/schema.ts'
import { bankContent, lessonContent, mapContent, planContent, teachingContent } from '../src/core/content-quality.ts'
import { LearnerNotesStore } from '../src/core/learner-notes.ts'
import { readMasteryEvents } from '../src/core/events.ts'
import { approveFixture } from './fixtures/quality.ts'
import { validateLessonDraft } from '../src/core/lesson.ts'

// 集成走查：前置软门 → 备课 → 回忆热身 → 讲授 → 小测（自评校准）→ 旧知识回访（失败降级回退指针）。
// 模型会话用桩替代（固定教案 JSON 与固定讲授文本），内容准入用固定回执预签；日期用真实今天（不锁定）。
const draftJson: LessonDraft = {
  node: 'channels',
  title: 'Channel',
  hook: '从 goroutine 通信切入',
  structure: ['通道是什么', '发送与接收', '关闭与 range'],
  example: 'ch := make(chan int)',
  practice: [{ question: '通道有什么作用？', answer: '在 goroutine 之间传递数据' }],
  quiz: [
    { question: '通道题一？', choices: ['A. 1', 'B. 2', 'C. 3', 'D. 4'], answer: 'B' },
    { question: '只填数值：2?', answer: '2' },
  ],
  misconceptions: ['通道等于线程'],
}

it('learn 集成：软门越权 → 热身 → 小测校准 → 旧知识回访降级并与指针一致', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-learn-flow-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new CourseStore(root)
  store.create('alpha', { goal: '学习并发', daily_minutes: 60, background: '有经验', style: '例子驱动' })
  const profile = store.read('alpha', 'profile') as Profile
  const map: KnowledgeMap = {
    verified: false,
    nodes: [{ id: 'goroutines', title: 'Goroutine' }, { id: 'channels', title: 'Channel' }],
    edges: [['channels', 'goroutines']],
    resources: [],
  }
  store.write('alpha', 'knowledge-map', map)
  const plan: Plan = { path: ['channels'], scope: ['goroutines', 'channels'], milestones: [], current: 'channels' }
  store.write('alpha', 'plan', plan)
  // 前置 goroutines：30 天前实测、稳定性 7 天 → 低保留，触发软门与热身
  store.write('alpha', 'mastery', {
    goroutines: { status: 'mastered', score: 1, review_stage: 3, stability: 7, last_touched_at: '2026-08-19' },
  } satisfies Mastery)
  const bank: QuestionBank = {
    goroutines: [
      { id: 'g-q1', difficulty: 2, type: 'choice', question: 'goroutine 题？', choices: ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁'], answer: 'B' },
      { id: 'g-q2', difficulty: 1, type: 'short', question: '只填数值：5?', answer: '5' },
    ],
  }
  store.write('alpha', 'question-bank', bank)
  // 题库经过 schema 校验（补 accept/choices 默认值）后落盘；审批用读回形态。
  const storedBank = store.read('alpha', 'question-bank') as QuestionBank
  approveFixture(root, 'alpha', mapContent(map, profile))
  approveFixture(root, 'alpha', planContent(plan, profile, map))
  approveFixture(root, 'alpha', bankContent(storedBank, 'goroutines', profile, map))
  // 教案会经过 LessonDraftSchema 校验（补 accept/choices 默认值），审批必须用同一形态。
  const validatedDraft = validateLessonDraft(draftJson, 'channels', 4)
  assert.ok(validatedDraft.ok)
  approveFixture(root, 'alpha', lessonContent(validatedDraft.value, profile, map))
  const teaching = { reply: '第一段讲授。', learnerMessage: '开始本课', previousReply: '' }
  approveFixture(root, 'alpha', teachingContent(teaching, 'channels', profile, map))

  const lines = ['c', 'A', '/quiz', '80', 'A', '2', '9']
  const out: string[] = []
  const io: FlowIO = {
    out: (text) => { out.push(text) },
    err: () => {},
    readLine: async () => lines.shift() ?? null,
    closeInput: () => {},
    signal: new AbortController().signal,
  }
  let chatCount = 0
  const createChat = (async (options?: CreateChatOptions) => {
    if (options?.isolatedSystemPrompt) throw new Error('测试不应创建独立审查会话')
    chatCount += 1
    const first = chatCount === 1
    return {
      sessionId: `session-${chatCount}`,
      model: 'test',
      ask: async () => (first ? '```json\n' + JSON.stringify(draftJson) + '\n```' : teaching.reply),
      lastTurnUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
      totalUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
      lastReply: () => teaching.reply,
      lastReplySeq: () => 1,
      flush: async () => {},
    } satisfies AgentChat
  }) as FlowDeps['createChat']
  const deps: FlowDeps = {
    store, io,
    createChat,
    status: () => {},
    env: {},
    workspace: root,
    today: () => new Date().toISOString().slice(0, 10),
  }

  const error = await runLearn(deps, { courseId: 'alpha' }).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof FlowExit, `预期 FlowExit，实得：${error instanceof Error ? error.stack : String(error)}`)
  assert.equal((error as FlowExit).code, 0)

  const log = out.join('')
  assert.match(log, /前置知识可能已生疏：goroutines/)
  assert.match(log, /回忆热身/)
  assert.match(log, /热身完成（0\/1 正确）/)
  assert.match(log, /旧知识回访：goroutines/)
  assert.match(log, /自评把握 80%，实际 50%（高估 30 点，已记入教学参考）/)

  const mastery = store.read('alpha', 'mastery') as Mastery
  assert.equal(mastery.channels.status, 'learning')
  assert.equal(mastery.channels.score, 0.5)
  assert.equal(mastery.goroutines.status, 'weak')
  assert.equal(mastery.goroutines.score, 0)
  assert.equal(mastery.goroutines.lapses, 1)
  const updatedPlan = store.read('alpha', 'plan') as Plan
  assert.equal(updatedPlan.current, 'goroutines') // 回访失败 → 指针退回补救
  assert.equal(store.has('alpha', 'lesson'), false)

  const notes = new LearnerNotesStore(root, 'alpha').read()
  assert.equal(notes.errors.channels?.length, 1)
  assert.equal(notes.errors.channels?.[0].your, 'A')
  assert.equal(notes.errors.goroutines?.length, 1)
  assert.equal(notes.errors.goroutines?.[0].your, '9')
  assert.deepEqual(notes.calibration.at(-1), { at: deps.today(), node: 'channels', predicted: 80, actual: 0.5 })

  const events = readMasteryEvents(root, 'alpha')
  assert.deepEqual(events.map((event) => event.kind).sort(), ['interleave', 'quiz', 'warmup'])
  assert.equal(events.find((event) => event.kind === 'interleave')?.passed, false)
  assert.equal(events.find((event) => event.kind === 'warmup')?.passed, false)
})
