import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeExamResult, EXAM_PASS_SCORE, gradeObjective, nextMilestone, paperTotalPoints, paperValid, updatePlanExamRecord, type ExamPaper } from '../src/core/exam.ts'
import type { Mastery, Plan } from '../src/core/schema.ts'

const paper: ExamPaper = {
  milestone: 'm1',
  questions: [
    { id: 'q1', node: 'a', type: 'objective', question: 'x?', choices: ['A. 1', 'B. 2', 'C. 3', 'D. 4'], answer: 'B', points: 1 },
    { id: 'q2', node: 'a', type: 'objective', question: 'y?', answer: 'channel', accept: ['chan'], points: 1 },
    { id: 'q3', node: 'b', type: 'objective', question: 'z?', choices: ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁'], answer: 'A', points: 1 },
    { id: 'q4', node: 'b', type: 'subjective', question: '综合题', answer: '参考', keywords: ['pool', 'channel'], points: 2 },
  ],
}

describe('paperValid', () => {
  it('结构合规返回 null，越界节点/非法选项报错', () => {
    assert.equal(paperValid(paper, ['a', 'b']), null)
    assert.match(paperValid(paper, ['a']) ?? '', /不在里程碑内/)
    const bad = { ...paper, questions: paper.questions.slice(0, 2) }
    assert.match(paperValid(bad, ['a', 'b']) ?? '', /题目数/)
  })
})

describe('gradeObjective', () => {
  it('选择题按字母，简答按归一化', () => {
    assert.equal(gradeObjective(paper.questions[0], 'B').correct, true)
    assert.equal(gradeObjective(paper.questions[0], 'a').correct, false)
    assert.equal(gradeObjective(paper.questions[1], 'Channel').correct, true)
    assert.equal(gradeObjective(paper.questions[1], 'chan ').correct, true)
    assert.equal(gradeObjective(paper.questions[1], 'mutex').correct, false)
  })
})

describe('computeExamResult', () => {
  it('按 points 加权，阈值 0.7', () => {
    assert.equal(EXAM_PASS_SCORE, 0.7)
    assert.equal(paperTotalPoints(paper), 5)
    const allPass = computeExamResult(
      [{ questionId: 'q1', correct: true, score: 1 }, { questionId: 'q2', correct: true, score: 1 }, { questionId: 'q3', correct: true, score: 1 }, { questionId: 'q4', correct: true, score: 2 }],
      5
    )
    assert.equal(allPass.score, 1)
    assert.equal(allPass.passed, true)
    const borderline = computeExamResult(
      [{ questionId: 'q1', correct: true, score: 1 }, { questionId: 'q2', correct: true, score: 1 }, { questionId: 'q3', correct: false, score: 0 }, { questionId: 'q4', correct: true, score: 1.5 }],
      5
    )
    assert.equal(borderline.score, 0.7)
    assert.equal(borderline.passed, true)
    const fail = computeExamResult(
      [{ questionId: 'q1', correct: true, score: 1 }, { questionId: 'q2', correct: false, score: 0 }, { questionId: 'q3', correct: false, score: 0 }, { questionId: 'q4', correct: false, score: 0.5 }],
      5
    )
    assert.equal(fail.passed, false)
  })
})

describe('updatePlanExamRecord / nextMilestone', () => {
  const plan: Plan = {
    path: ['a', 'b'],
    milestones: [
      { id: 'm1', title: '一', nodes: ['a'] },
      { id: 'm2', title: '二', nodes: ['b'] },
    ],
    current: 'b',
  }
  it('写入考试记录，不动其他里程碑', () => {
    const updated = updatePlanExamRecord(plan, 'm1', { date: '2026-09-20', score: 0.9, passed: true })
    assert.equal(updated.milestones[0].exam_passed, true)
    assert.equal(updated.milestones[0].exam_score, 0.9)
    assert.equal(updated.milestones[1].exam_passed, undefined)
  })

  it('nextMilestone：只挑节点全 mastered 且未通过的', () => {
    const mastery: Mastery = { a: { status: 'mastered', score: 1 }, b: { status: 'learning' } }
    assert.equal(nextMilestone(plan, mastery)?.id, 'm1')
    const afterPass = updatePlanExamRecord(plan, 'm1', { date: '2026-09-20', score: 0.9, passed: true })
    assert.equal(nextMilestone(afterPass, mastery), null)
    const bothReady: Mastery = { a: { status: 'mastered' }, b: { status: 'mastered' } }
    assert.equal(nextMilestone(afterPass, bothReady)?.id, 'm2')
  })
})
