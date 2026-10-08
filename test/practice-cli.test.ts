import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CourseStore } from '../src/core/store.ts'
import type { KnowledgeMap, Mastery, PracticeTaskFile, PracticeTaskState, Profile } from '../src/core/schema.ts'
import { practiceContent } from '../src/core/content-quality.ts'
import { approveFixture } from './fixtures/quality.ts'
import { practiceTaskKey } from '../src/core/practice.ts'

it('真实实践 CLI 能在课程全部掌握后练习指定节点，执行测试且不推进复习阶梯', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-practice-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new CourseStore(root)
  store.create('alpha', { goal: '测试' })
  store.write('alpha', 'knowledge-map', { verified: false, nodes: [{ id: 'basics', title: '基础' }], edges: [] })
  store.write('alpha', 'plan', { path: [], scope: ['basics'], milestones: [] })
  const mastery: Mastery = { basics: { status: 'mastered', score: 1, review_stage: 3, review_due: '2026-10-15' } }
  store.write('alpha', 'mastery', mastery)
  store.write('alpha', 'practice', { generated_at: '2026-10-08', tasks: [{ id: 'basics-task', node: 'basics', title: '巩固基础',
    prompt: '完成文件', tests: [{ name: 'file-exists', command: 'test -f answer.txt' }],
    starter_files: [{ path: 'answer.txt', content: '初始内容' }] }] })
  const dir = path.join(root, 'alpha', 'sandbox', 'basics-task')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'answer.txt'), '学员已有作答')
  const script = fileURLToPath(new URL('../scripts/practice.mjs', import.meta.url))
  const unreviewed = spawnSync(process.execPath, [script, 'practice', 'alpha', '--node', 'basics'], {
    env: { ...process.env, TUTOR_COURSES_ROOT: root }, input: 'r\n', encoding: 'utf8', timeout: 5000,
  })
  assert.equal(unreviewed.status, 1)
  assert.match(unreviewed.stderr, /audit-content/)
  assert.equal(store.has('alpha', 'practice-state'), false)
  assert.doesNotMatch(unreviewed.stdout, /完成文件|运行测试/)
  approveFixture(root, 'alpha', practiceContent((store.read('alpha', 'practice') as PracticeTaskFile).tasks, 'basics',
    store.read('alpha', 'profile') as Profile, store.read('alpha', 'knowledge-map') as KnowledgeMap))
  const result = spawnSync(process.execPath, [script, 'practice', 'alpha', '--node', 'basics'], {
    env: { ...process.env, TUTOR_COURSES_ROOT: root }, input: 'r\n', encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /实践完成/)
  assert.equal((store.read('alpha', 'practice-state') as PracticeTaskState).done, true)
  assert.deepEqual(store.read('alpha', 'mastery'), mastery)
  assert.equal(fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8'), '学员已有作答')
  const invalid = spawnSync(process.execPath, [script, 'practice', 'alpha', '--node', 'unknown'], {
    env: { ...process.env, TUTOR_COURSES_ROOT: root }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /知识地图/)

  const revised = store.read('alpha', 'practice') as PracticeTaskFile
  revised.tasks[0].tests.push({ name: 'correct-content', command: 'test "$(cat answer.txt)" = "correct"' })
  store.write('alpha', 'practice', revised)
  approveFixture(root, 'alpha', practiceContent((store.read('alpha', 'practice') as PracticeTaskFile).tasks, 'basics', store.read('alpha', 'profile') as Profile,
    store.read('alpha', 'knowledge-map') as KnowledgeMap))
  const run = (input: string) => spawnSync(process.execPath, [script, 'practice', 'alpha', '--node', 'basics'], {
    env: { ...process.env, TUTOR_COURSES_ROOT: root }, input, encoding: 'utf8', timeout: 5000,
  })
  const paused = run('q\n')
  assert.equal(paused.status, 0, paused.stdout + paused.stderr)
  assert.match(paused.stdout, /任务内容已更新/)
  let state = store.read('alpha', 'practice-state') as PracticeTaskState
  assert.equal(state.done, false)
  assert.equal(state.attempts, 0)
  assert.equal(state.content_key, practiceTaskKey((store.read('alpha', 'practice') as PracticeTaskFile).tasks[0]))
  assert.equal(fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8'), '学员已有作答')
  assert.match(run('r\nq\n').stdout, /未全部通过/)
  state = store.read('alpha', 'practice-state') as PracticeTaskState
  assert.equal(state.done, false)
  assert.deepEqual(state.done_tests, ['file-exists'])
  assert.deepEqual(store.read('alpha', 'mastery'), mastery)
})
