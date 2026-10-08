import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { CourseStore } from '../src/core/store.ts'
import { lessonContent, mapContent, planContent, teachingContent } from '../src/core/content-quality.ts'
import type { KnowledgeMap, LessonState, Plan, Profile } from '../src/core/schema.ts'
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
  const run = (mode: string, behavior: 'repair' | 'fail', input = '') => spawnSync(process.execPath,
    [fileURLToPath(new URL('./fixtures/admission-runner.ts', import.meta.url)), mode, root, behavior],
    { input, encoding: 'utf8', timeout: 10000 })
  return { root, store, profile, map, run }
}

it('正式 exam runner 在第四次修复通过后才展示试卷；耗尽修复不展示、不记分', t => {
  for (const behavior of ['repair', 'fail'] as const) {
    const { store, run } = fixture(t)
    const mastery = store.read('alpha', 'mastery')
    const result = run('exam', behavior)
    assert.equal(result.status, 1, result.stderr) // repair 后 stdin EOF，按正式逻辑中止考试
    assert.doesNotMatch(result.stdout, /REJECT_CANDIDATE/)
    if (behavior === 'repair') assert.match(result.stdout, /试卷就绪[\s\S]*APPROVED_CONTENT/)
    else assert.doesNotMatch(result.stdout, /试卷就绪|第 1\/4 题/)
    assert.deepEqual(store.read('alpha', 'mastery'), mastery)
  }
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
