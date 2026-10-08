import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyExamAttempt, ExamAttemptStore, newExamAttempt } from '../src/core/exam-attempt.ts'
import { gradeObjective, type ExamPaper } from '../src/core/exam.ts'
import { CourseStore } from '../src/core/store.ts'
import type { KnowledgeMap, Mastery, Plan } from '../src/core/schema.ts'

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-exam-attempt-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new CourseStore(root)
  store.create('alpha', { goal: '基础运算' })
  store.write('alpha', 'plan', { path: ['topic'], current: 'topic', milestones: [{ id: 'm1', title: '基础运算', nodes: ['topic'] }] })
  store.write('alpha', 'mastery', { topic: { status: 'mastered', score: 1, review_stage: 1, review_due: '2026-10-09' } })
  const map: KnowledgeMap = { verified: false, nodes: [{ id: 'topic', title: '基础运算' }], edges: [] }
  const paper: ExamPaper = { milestone: 'm1', questions: [
    { id: 'q1', node: 'topic', type: 'objective', question: '1+1=?', choices: ['1', '2', '3', '4'], answer: 'B', points: 1 },
    { id: 'q2', node: 'topic', type: 'objective', question: '1÷2 的结果（只填数值）', answer: '1/2', points: 1 },
    { id: 'q3', node: 'topic', type: 'objective', question: '2-1=?', choices: ['1', '2', '3', '4'], answer: 'A', points: 1 },
    { id: 'q4', node: 'topic', type: 'subjective', question: '解释 1+1=2', answer: '两个一合起来是二', points: 2 },
  ] }
  const attempts = new ExamAttemptStore(root, 'alpha')
  const attempt = newExamAttempt(paper, 'a'.repeat(64))
  const finishAnswers = () => {
    attempt.answers = { q1: 'B', q2: '2/4', q3: 'A', q4: '两个一合起来是二' }
    attempt.gradings = paper.questions.slice(0, 3).map(q => gradeObjective(q, attempt.answers[q.id]))
      .concat({ questionId: 'q4', score: 1, correct: true, note: '解释正确' })
  }
  return { root, store, map, paper, attempts, attempt, finishAnswers }
}

it('考试断点保存部分实际作答，未作答题和掌握度保持原状', t => {
  const { store, attempts, attempt } = fixture(t)
  const before = store.read('alpha', 'mastery')
  attempt.answers.q1 = 'B'
  attempts.save(attempt)
  const resumed = attempts.read()!
  assert.equal(resumed.id, attempt.id)
  assert.equal(resumed.status, 'answering')
  assert.deepEqual(resumed.answers, { q1: 'B' })
  assert.equal(resumed.gradings, undefined)
  assert.deepEqual(store.read('alpha', 'mastery'), before)
})

it('未答完、遗漏判分均不能提交考试成绩', t => {
  const { store, map, attempts, attempt, finishAnswers } = fixture(t)
  const before = store.read('alpha', 'mastery')
  assert.throws(() => applyExamAttempt(attempt, attempts, store, 'alpha', map, '2026-10-08'), /作答不完整/)
  finishAnswers()
  attempt.gradings!.pop()
  assert.throws(() => applyExamAttempt(attempt, attempts, store, 'alpha', map, '2026-10-08'), /遗漏/)
  assert.deepEqual(store.read('alpha', 'mastery'), before)
  assert.equal(attempts.read(), undefined)
})

it('掌握度写入后计划写入中断，恢复只推进一次复习阶梯并归档原成绩', t => {
  const { root, store, map, attempts, attempt, finishAnswers } = fixture(t)
  finishAnswers()
  const interrupted = {
    has: store.has.bind(store), read: store.read.bind(store),
    write: (id: string, kind: 'mastery' | 'plan', data: unknown) => {
      if (kind === 'plan') throw new Error('模拟计划写入中断')
      store.write(id, kind, data)
    },
  }
  assert.throws(() => applyExamAttempt(attempt, attempts, interrupted, 'alpha', map, '2026-10-08'), /模拟计划写入中断/)
  assert.equal((store.read('alpha', 'mastery') as Mastery).topic.review_stage, 2)
  assert.equal((store.read('alpha', 'plan') as Plan).milestones[0].exam_passed, undefined)
  const resumed = attempts.read()!
  assert.equal(resumed.status, 'graded')
  const result = applyExamAttempt(resumed, attempts, store, 'alpha', map, '2026-10-09')
  assert.equal(result.date, '2026-10-08')
  assert.equal(result.score, 1)
  assert.equal(result.after.mastery.topic.review_stage, 2)
  assert.equal(result.after.mastery.topic.review_due, '2026-10-11')
  assert.equal((store.read('alpha', 'plan') as Plan).milestones[0].exam_passed, true)
  const completed = attempts.read()!
  assert.equal(completed.status, 'completed')
  const archive = JSON.parse(fs.readFileSync(path.join(root, 'alpha', 'exams', `${attempt.id}.json`), 'utf8'))
  assert.deepEqual(archive.answers, attempt.answers)
  assert.deepEqual(archive.result, JSON.parse(JSON.stringify(result)))
  const masteryBytes = fs.readFileSync(path.join(root, 'alpha', 'mastery.yaml'), 'utf8')
  assert.deepEqual(applyExamAttempt(completed, attempts, store, 'alpha', map, '2026-10-10'), result)
  assert.equal(fs.readFileSync(path.join(root, 'alpha', 'mastery.yaml'), 'utf8'), masteryBytes)
})

it('提交断点与后来课程状态冲突时，保留成绩和新状态供检查', t => {
  const { store, map, attempts, attempt, finishAnswers } = fixture(t)
  finishAnswers()
  const interrupted = { has: store.has.bind(store), read: store.read.bind(store), write: () => { throw new Error('写入中断') } }
  assert.throws(() => applyExamAttempt(attempt, attempts, interrupted, 'alpha', map, '2026-10-08'), /写入中断/)
  store.write('alpha', 'mastery', { topic: { status: 'weak', score: 0 } })
  const changed = store.read('alpha', 'mastery')
  const checkpoint = fs.readFileSync(attempts.file, 'utf8')
  assert.throws(() => applyExamAttempt(attempts.read()!, attempts, store, 'alpha', map, '2026-10-08'), /课程状态发生变化/)
  assert.deepEqual(store.read('alpha', 'mastery'), changed)
  assert.equal(fs.readFileSync(attempts.file, 'utf8'), checkpoint)
})

it('完成归档写入失败时保留提交断点，恢复不重复推进掌握度', t => {
  const { root, store, map, attempts, attempt, finishAnswers } = fixture(t)
  finishAnswers()
  const archiveDir = path.join(root, 'alpha', 'exams')
  fs.writeFileSync(archiveDir, '模拟不可写的归档目录')
  assert.throws(() => applyExamAttempt(attempt, attempts, store, 'alpha', map, '2026-10-08'), /EEXIST|ENOTDIR/)
  assert.equal(attempts.read()!.status, 'graded')
  assert.equal(attempt.status, 'graded')
  assert.equal((store.read('alpha', 'mastery') as Mastery).topic.review_stage, 2)
  fs.unlinkSync(archiveDir)
  applyExamAttempt(attempts.read()!, attempts, store, 'alpha', map, '2026-10-09')
  assert.equal(attempts.read()!.status, 'completed')
  assert.equal((store.read('alpha', 'mastery') as Mastery).topic.review_stage, 2)
  assert.ok(fs.existsSync(path.join(archiveDir, `${attempt.id}.json`)))
})

it('损坏、未知作答题号或缺失提交记录的考试断点被拒绝且原文件保留', t => {
  const { attempts, attempt, finishAnswers } = fixture(t)
  finishAnswers()
  for (const broken of [
    '{',
    JSON.stringify({ ...attempt, answers: { ghost: 'B' } }),
    JSON.stringify({ ...attempt, status: 'graded' }),
    JSON.stringify({ ...attempt, status: 'completed', answers: { q1: 'B' } }),
  ]) {
    fs.writeFileSync(attempts.file, broken)
    assert.throws(() => attempts.read(), /考试断点无法读取，原文件已保留/)
    assert.equal(fs.readFileSync(attempts.file, 'utf8'), broken)
  }
})
