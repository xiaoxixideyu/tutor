import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { CourseStore } from '../src/core/store.ts'
import { contentKey, examContent, lessonContent, mapContent, planContent, teachingContent } from '../src/core/content-quality.ts'
import { ExamAttemptStore, newExamAttempt } from '../src/core/exam-attempt.ts'
import type { ExamPaper } from '../src/core/exam.ts'
import type { AssessmentState, KnowledgeMap, LessonState, Plan, Profile, QuestionBank } from '../src/core/schema.ts'
import { approveFixture } from './fixtures/quality.ts'

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-admission-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new CourseStore(root)
  store.create('alpha', { goal: '学习基础加法' })
  store.write('alpha', 'knowledge-map', { nodes: [{ id: 'topic', title: '基础加法' }] })
  store.write('alpha', 'plan', { path: ['topic'], scope: ['topic'], milestones: [{ id: 'm1', title: '完成基础加法', nodes: ['topic'] }] })
  store.write('alpha', 'mastery', { topic: { status: 'learning', score: 0.3 } })
  const profile = store.read('alpha', 'profile') as Profile
  const map = store.read('alpha', 'knowledge-map') as KnowledgeMap
  approveFixture(root, 'alpha', mapContent(map, profile))
  approveFixture(root, 'alpha', planContent(store.read('alpha', 'plan') as Plan, profile, map))
  const run = (mode: string, behavior: 'repair' | 'fail' | 'grading-fail' | 'grading-success' | 'assessment-ready' | 'assessment-second-fail', input = '') => spawnSync(process.execPath,
    [fileURLToPath(new URL('./fixtures/admission-runner.ts', import.meta.url)), mode, root, behavior],
    { input, encoding: 'utf8', timeout: 10000 })
  return { root, store, profile, map, run }
}

it('39 节课程只准备当前摸底节点就显示首题；未作答时不生成后续题库、不更新掌握度', t => {
  const { root, store, profile, run } = fixture(t)
  const later = Array.from({ length: 38 }, (_, i) => ({ id: `later-${i}`, title: `后续加法 ${i}` }))
  const map: KnowledgeMap = { verified: false, nodes: [...later, { id: 'topic', title: '基础加法' }],
    edges: later.map(node => [node.id, 'topic']) }
  store.write('alpha', 'knowledge-map', map)
  approveFixture(root, 'alpha', mapContent(map, profile))
  const mastery = store.read('alpha', 'mastery')
  for (let i = 0; i < 2; i++) {
    const paused = run('assess', 'assessment-ready')
    assert.equal(paused.status, 1, paused.stdout + paused.stderr)
    assert.match(paused.stdout, /【知识点：topic[\s\S]*APPROVED_CONTENT topic d2/)
    assert.match(paused.stderr, /未收到作答——进度已保存/)
    assert.doesNotMatch(paused.stdout, /REJECT_CANDIDATE|正在生成摸底题库：later/)
    assert.deepEqual(Object.keys(store.read('alpha', 'question-bank') as QuestionBank), ['topic'])
    const state = store.read('alpha', 'assessment') as AssessmentState
    assert.equal(state.current_node, 'topic')
    assert.equal(state.node_order[0], 'topic')
    assert.equal(state.node_order.length, 39)
    assert.deepEqual(state.asked, [])
    assert.deepEqual(state.scores, {})
    assert.deepEqual(store.read('alpha', 'mastery'), mastery)
    assert.equal(store.has('alpha', 'learner-profile'), false)
  }
  assert.equal(fs.readFileSync(path.join(root, 'bank-count.txt'), 'utf8'), 'topic\n')
})

it('后续摸底出题失败保留此前作答，恢复跳过已答节点且全数完成后才更新画像', t => {
  const { root, store, profile, run } = fixture(t)
  const map: KnowledgeMap = { verified: false, nodes: [
    { id: 'last', title: '综合加法' }, { id: 'later', title: '加法应用' }, { id: 'topic', title: '基础加法' },
  ], edges: [['last', 'later'], ['later', 'topic']] }
  store.write('alpha', 'knowledge-map', map)
  approveFixture(root, 'alpha', mapContent(map, profile))
  const mastery = store.read('alpha', 'mastery')
  const failed = run('assess', 'assessment-second-fail', 'A\nA\n')
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  assert.match(failed.stdout, /【知识点：topic/)
  assert.doesNotMatch(failed.stdout, /REJECT_CANDIDATE|【知识点：later|【知识点：last|摸底完成/)
  const saved = store.read('alpha', 'assessment') as AssessmentState
  assert.deepEqual(saved.scores, { topic: 1 })
  assert.equal(saved.asked.length, 2)
  assert.deepEqual(Object.keys(store.read('alpha', 'question-bank') as QuestionBank), ['topic'])
  assert.deepEqual(store.read('alpha', 'mastery'), mastery)
  assert.equal(store.has('alpha', 'learner-profile'), false)

  const resumed = run('assess', 'assessment-ready')
  assert.equal(resumed.status, 1, resumed.stdout + resumed.stderr)
  assert.match(resumed.stdout, /检测到未完成的摸底[\s\S]*【知识点：later/)
  assert.doesNotMatch(resumed.stdout, /【知识点：topic|【知识点：last|正在生成摸底题库：last|REJECT_CANDIDATE/)
  assert.deepEqual((store.read('alpha', 'assessment') as AssessmentState).asked, saved.asked)
  assert.deepEqual(store.read('alpha', 'mastery'), mastery)
  assert.deepEqual(Object.keys(store.read('alpha', 'question-bank') as QuestionBank), ['topic', 'later'])

  const completed = run('assess', 'assessment-ready', 'A\nA\nA\nA\n')
  assert.equal(completed.status, 0, completed.stdout + completed.stderr)
  assert.match(completed.stdout, /摸底完成。共评估 3 个知识点/)
  assert.doesNotMatch(completed.stdout, /【知识点：topic|正在生成摸底题库：later/)
  assert.equal(store.has('alpha', 'assessment'), false)
  assert.equal(store.has('alpha', 'learner-profile'), true)
  const generated = fs.readFileSync(path.join(root, 'bank-count.txt'), 'utf8').trim().split('\n')
  assert.equal(generated.filter(node => node === 'topic').length, 1)
  assert.equal(generated.filter(node => node === 'last').length, 1)
  assert.deepEqual(Object.keys(store.read('alpha', 'mastery') as object).sort(), ['last', 'later', 'topic'])
})

it('正式 exam runner 在第四次修复通过后才展示试卷；耗尽修复不展示、不记分', t => {
  for (const behavior of ['repair', 'fail'] as const) {
    const { store, run } = fixture(t)
    const mastery = store.read('alpha', 'mastery')
    const result = run('exam', behavior)
    assert.equal(result.status, behavior === 'repair' ? 0 : 1, result.stderr) // repair 后 stdin EOF，保存试卷后暂停考试
    assert.doesNotMatch(result.stdout, /REJECT_CANDIDATE/)
    if (behavior === 'repair') assert.match(result.stdout, /试卷就绪[\s\S]*APPROVED_CONTENT/)
    else assert.doesNotMatch(result.stdout, /试卷就绪|第 1\/4 题/)
    assert.deepEqual(store.read('alpha', 'mastery'), mastery)
  }
})

it('正式考试暂停和阅卷失败后恢复同一试卷，跳过已答题并只在阅卷成功后记分', t => {
  const { root, store, profile, map, run } = fixture(t)
  const plan = store.read('alpha', 'plan') as Plan
  const paper: ExamPaper = { milestone: 'm1', questions: [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `q${i + 1}`, node: 'topic', type: 'objective' as const,
      question: `已批准第 ${i + 1} 题`, choices: ['2', '3', '4', '5'], answer: 'A', points: 1 })),
    { id: 'q4', node: 'topic', type: 'subjective', question: '解释 1+1=2', answer: '两个一合起来是二', points: 2 },
  ] }
  const input = examContent(paper, profile, map, plan.milestones[0])
  approveFixture(root, 'alpha', input)
  const attempts = new ExamAttemptStore(root, 'alpha')
  const attempt = newExamAttempt(paper, contentKey(input))
  attempts.save(attempt)
  const before = store.read('alpha', 'mastery')
  const paused = run('exam', 'grading-fail', 'A\n/exit\n')
  assert.equal(paused.status, 0, paused.stdout + paused.stderr)
  assert.match(paused.stdout, /考试暂停/)
  assert.deepEqual(attempts.read()!.answers, { q1: 'A' })
  assert.deepEqual(store.read('alpha', 'mastery'), before)
  const failed = run('exam', 'grading-fail', 'A\nA\n两个一合起来是二\n')
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  assert.match(failed.stderr, /主观题判分失败，作答已保存/)
  assert.doesNotMatch(failed.stdout, /正在生成试卷|【第 1\/4 题/)
  assert.equal(attempts.read()!.status, 'answering')
  assert.equal(Object.keys(attempts.read()!.answers).length, 4)
  assert.deepEqual(store.read('alpha', 'mastery'), before)
  const resumed = run('exam', 'grading-success')
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr)
  assert.match(resumed.stdout, /恢复考试：已保存 4\/4 题作答/)
  assert.doesNotMatch(resumed.stdout, /正在生成试卷|【第 \d\/4 题/)
  assert.match(resumed.stdout, /大考成绩：1（通过）/)
  assert.equal(attempts.read()!.id, attempt.id)
  assert.equal(attempts.read()!.status, 'completed')
  assert.equal((store.read('alpha', 'plan') as Plan).milestones[0].exam_passed, true)
})

it('正式 practice-gen 会审查已有任务，修复通过才替换；失败时保留原任务', t => {
  for (const behavior of ['repair', 'fail'] as const) {
    const { store, run } = fixture(t)
    store.write('alpha', 'practice', { generated_at: '2026-10-08', tasks: [{ id: 'old-task', node: 'topic', title: '旧任务',
      prompt: 'REJECT_CANDIDATE 旧内容', tests: [{ name: 'test', command: 'true' }] }] })
    const original = store.read('alpha', 'practice')
    const result = run('practice-gen', behavior)
    assert.equal(result.status, behavior === 'repair' ? 0 : 1, result.stdout + result.stderr)
    assert.doesNotMatch(result.stdout, /REJECT_CANDIDATE/)
    if (behavior === 'repair') assert.match(JSON.stringify(store.read('alpha', 'practice')), /APPROVED_CONTENT/)
    else assert.deepEqual(store.read('alpha', 'practice'), original)
    assert.equal(store.has('alpha', 'practice-state'), false)
  }
})

it('正式 learn 恢复时舍弃未批准的日志尾部，重新审查后才更新断点', t => {
  for (const behavior of ['repair', 'fail'] as const) {
    const { root, store, profile, map, run } = fixture(t)
    const question = { question: '1+1=?', choices: ['2', '3', '4', '5'], answer: 'A' }
    store.write('alpha', 'lesson', { node: 'topic', session_id: 'old', started_at: '2026-10-08',
      draft: { node: 'topic', title: '加法', hook: '开始', structure: ['加法'], example: '1+1=2', practice: [question],
        quiz: [question, { ...question, question: '1+1 的结果？' }] },
      approved_turn: { reply: '之前通过审查的回复', learnerMessage: '开始', previousReply: '' } })
    const original = store.read('alpha', 'lesson') as LessonState
    approveFixture(root, 'alpha', lessonContent(original.draft, profile, map))
    approveFixture(root, 'alpha', teachingContent(original.approved_turn!, 'topic', profile, map))
    const result = run('learn', behavior, '/exit\n')
    assert.equal(result.status, behavior === 'repair' ? 0 : 1, result.stdout + result.stderr)
    assert.doesNotMatch(result.stdout, /REJECT_CANDIDATE/)
    if (behavior === 'repair') assert.equal((store.read('alpha', 'lesson') as LessonState).approved_turn?.reply, 'APPROVED_CONTENT')
    else assert.deepEqual(store.read('alpha', 'lesson'), original)
  }
})

it('首次讲授失败仍保存已批准备课，再次开课复用教案且不发布失败回复', t => {
  const { root, store, run } = fixture(t)
  const mastery = store.read('alpha', 'mastery')
  const failed = run('learn', 'fail')
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  const prepared = store.read('alpha', 'lesson') as LessonState
  assert.equal(prepared.draft.node, 'topic')
  assert.equal(prepared.session_id, undefined)
  assert.equal(prepared.approved_turn, undefined)
  assert.deepEqual(store.read('alpha', 'mastery'), mastery)
  const resumed = run('learn', 'repair', '/exit\n')
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr)
  assert.equal(fs.readFileSync(path.join(root, 'prep-count.txt'), 'utf8'), 'prepared\n')
  assert.doesNotMatch(failed.stdout + resumed.stdout, /REJECT_CANDIDATE/)
  assert.equal((store.read('alpha', 'lesson') as LessonState).approved_turn?.reply, 'APPROVED_CONTENT')
})

it('替换已拒绝旧教案后，首段讲授失败仍保留新教案，恢复不重复备课', t => {
  const { root, store, run } = fixture(t)
  const question = { question: '1+1=?', choices: ['2', '3', '4', '5'], answer: 'A' }
  store.write('alpha', 'lesson', { node: 'topic', session_id: 'old', started_at: '2026-10-08',
    draft: { node: 'topic', title: 'REJECT_CANDIDATE 旧教案', hook: '旧开场', structure: ['加法'], example: '1+1=2',
      practice: [question], quiz: [question, { ...question, question: '1+1 的结果？' }] },
    approved_turn: { reply: '旧教案的历史回复', learnerMessage: '开始', previousReply: '' } })
  const mastery = store.read('alpha', 'mastery')
  const failed = run('learn', 'fail')
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  const prepared = store.read('alpha', 'lesson') as LessonState
  assert.equal(prepared.draft.title, '加法')
  assert.equal(prepared.session_id, undefined)
  assert.equal(prepared.approved_turn, undefined)
  assert.deepEqual(store.read('alpha', 'mastery'), mastery)
  const resumed = run('learn', 'repair', '/exit\n')
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr)
  assert.equal(fs.readFileSync(path.join(root, 'prep-count.txt'), 'utf8'), 'prepared\n')
  assert.deepEqual((store.read('alpha', 'lesson') as LessonState).draft, prepared.draft)
  assert.doesNotMatch(failed.stdout + resumed.stdout, /REJECT_CANDIDATE|旧教案的历史回复/)
})
