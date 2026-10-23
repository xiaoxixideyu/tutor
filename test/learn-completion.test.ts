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
import type { KnowledgeMap, LessonDraft, Mastery, Plan, Profile } from '../src/core/schema.ts'
import { lessonContent, mapContent, planContent, teachingContent } from '../src/core/content-quality.ts'
import { approveFixture } from './fixtures/quality.ts'
import { validateLessonDraft } from '../src/core/lesson.ts'

const draftFor = (node: string): LessonDraft => ({
  node,
  title: '唯一知识点',
  hook: '直接进入',
  structure: ['要点一', '要点二'],
  example: 'demo',
  practice: [{ question: '练习题？', answer: '答案' }],
  quiz: [
    { question: '小测一？', choices: ['A. 1', 'B. 2', 'C. 3', 'D. 4'], answer: 'A' },
    { question: '只填数值：2?', answer: '2' },
  ],
})

interface Fixture {
  root: string
  store: CourseStore
  lines: string[]
  out: string[]
  deps: FlowDeps
}

function buildFixture(t: { after: (fn: () => void) => void }, options: { twoNodes?: boolean; staleLesson?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-learn-completion-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new CourseStore(root)
  store.create('alpha', { goal: '完成即止', daily_minutes: 60, background: '有经验', style: '例子驱动' })
  const profile = store.read('alpha', 'profile') as Profile
  const map: KnowledgeMap = options.twoNodes
    ? { verified: false, nodes: [{ id: 'base', title: '前置' }, { id: 'only', title: '唯一知识点' }], edges: [['only', 'base']], resources: [] }
    : { verified: false, nodes: [{ id: 'only', title: '唯一知识点' }], edges: [], resources: [] }
  store.write('alpha', 'knowledge-map', map)
  const plan: Plan = options.twoNodes
    ? { path: ['only'], scope: ['base', 'only'], milestones: [], current: 'only' }
    : { path: ['only'], scope: ['only'], milestones: [], current: 'only' }
  store.write('alpha', 'plan', plan)
  const mastery: Mastery = options.twoNodes
    ? { base: { status: 'mastered', score: 1, review_stage: 3, stability: 7, last_touched_at: '2026-08-19' } }
    : { only: { status: 'learning', score: 0.5 } }
  store.write('alpha', 'mastery', mastery)
  approveFixture(root, 'alpha', mapContent(map, profile))
  approveFixture(root, 'alpha', planContent(plan, profile, map))
  const draftJson = draftFor('only')
  const validatedDraft = validateLessonDraft(draftJson, 'only', 4)
  assert.ok(validatedDraft.ok)
  approveFixture(root, 'alpha', lessonContent(validatedDraft.value, profile, map))
  const teaching = { reply: '讲授内容。', learnerMessage: '开始本课', previousReply: '' }
  approveFixture(root, 'alpha', teachingContent(teaching, 'only', profile, map))
  if (options.staleLesson) {
    // 属于另一个节点的旧课堂断点：不能因此跳过前置新鲜度软门。
    const staleDraft = validateLessonDraft(draftFor('base'), 'base', 4)
    assert.ok(staleDraft.ok)
    store.write('alpha', 'lesson', {
      node: 'base', session_id: 'old', started_at: '2026-10-08', draft: staleDraft.value,
    })
  }
  const lines: string[] = []
  const out: string[] = []
  const io: FlowIO = {
    out: (text) => { out.push(text) },
    err: () => {},
    readLine: async () => lines.shift() ?? null,
    closeInput: () => {},
    signal: new AbortController().signal,
  }
  let chatCount = 0
  const createChat = (async (chatOptions?: CreateChatOptions) => {
    if (chatOptions?.isolatedSystemPrompt) throw new Error('测试不应创建独立审查会话')
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
  return {
    root, store, lines, out,
    deps: { store, io, createChat, status: () => {}, env: {}, workspace: root, today: () => new Date().toISOString().slice(0, 10) },
  }
}

it('学完最后一个知识点：计划指针不留 null，再次 learn 明确提示课程完成', async (t) => {
  const { store, lines, out, deps } = buildFixture(t)
  // /quiz → 把握度（留空跳过）→ 小测两题全对
  lines.push('/quiz', '', 'A', '2')
  const error = await runLearn(deps, { courseId: 'alpha' }).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof FlowExit, `预期 FlowExit，实得：${error instanceof Error ? error.stack : String(error)}`)
  assert.equal((error as FlowExit).code, 0)
  assert.match(out.join(''), /课程完成/)

  const planFile = fs.readFileSync(path.join(store.root, 'alpha', 'plan.yaml'), 'utf8')
  assert.doesNotMatch(planFile, /current:/, '完成的课程不应留下 current: null')
  const plan = store.read('alpha', 'plan') as Plan
  assert.equal('current' in plan, false)
  const mastery = store.read('alpha', 'mastery') as Mastery
  assert.equal(mastery.only.status, 'mastered')

  // 再次 learn：应提示没有可上的课，而不是"计划与知识地图不一致"。
  const out2: string[] = []
  const rerun = await runLearn({
    ...deps,
    io: { ...deps.io, out: (text) => { out2.push(text) }, err: () => {} },
  }, { courseId: 'alpha' }).then(() => null, (thrown: unknown) => thrown)
  assert.ok(rerun instanceof FlowExit)
  assert.equal((rerun as FlowExit).code, 0)
  assert.match(out2.join(''), /均已掌握/)
})

it('存在属于其他节点的旧课堂断点时，前置新鲜度软门依然生效', async (t) => {
  const { lines, out, deps } = buildFixture(t, { twoNodes: true, staleLesson: true })
  // 软门（c 越权）→ /quiz → 把握度留空 → 小测两题全对
  lines.push('c', '/quiz', '', 'A', '2')
  const error = await runLearn(deps, { courseId: 'alpha' }).then(() => null, (thrown: unknown) => thrown)
  assert.ok(error instanceof FlowExit, `预期 FlowExit，实得：${error instanceof Error ? error.stack : String(error)}`)
  assert.equal((error as FlowExit).code, 0)
  const log = out.join('')
  assert.match(log, /前置知识可能已生疏：base/)
  // 断点节点与计划节点不一致时不恢复旧课堂。
  assert.doesNotMatch(log, /从上次断点继续本课/)
})
