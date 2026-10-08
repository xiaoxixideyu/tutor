import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyExamMastery, computeExamResult, EXAM_PASS_SCORE, gradeObjective, nextMilestone, paperTotalPoints, paperValid, updatePlanExamRecord, validateSubjectiveGradings, type ExamPaper, type ExamGrading } from '../src/core/exam.ts'
import type { Mastery, Plan } from '../src/core/schema.ts'

const paper: ExamPaper = {
  milestone: 'm1',
  questions: [
    { id: 'q1', node: 'a', type: 'objective', question: 'x?', choices: ['A. 1', 'B. 2', 'C. 3', 'D. 4'], answer: 'B', points: 1 },
    { id: 'q2', node: 'a', type: 'objective', question: 'y?（只填数值）', answer: '1/2', accept: ['0.5'], points: 1 },
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
  it('选择题按字母，数值填空接受等价表示', () => {
    assert.equal(gradeObjective(paper.questions[0], 'B').correct, true)
    assert.equal(gradeObjective(paper.questions[0], 'a').correct, false)
    assert.equal(gradeObjective(paper.questions[1], '2/4').correct, true)
    assert.equal(gradeObjective(paper.questions[1], '0.5 ').correct, true)
    assert.equal(gradeObjective(paper.questions[1], 'mutex').correct, false)
  })
})

describe('computeExamResult', () => {
  it('按 points 加权，阈值 0.7', () => {
    assert.equal(EXAM_PASS_SCORE, 0.7)
    assert.equal(paperTotalPoints(paper), 5)
    const allPass = computeExamResult(paper,
      [{ questionId: 'q1', correct: true, score: 1 }, { questionId: 'q2', correct: true, score: 1 }, { questionId: 'q3', correct: true, score: 1 }, { questionId: 'q4', correct: true, score: 1 }])
    assert.equal(allPass.score, 1)
    assert.equal(allPass.passed, true)
    const borderline = computeExamResult(paper,
      [{ questionId: 'q1', correct: true, score: 1 }, { questionId: 'q2', correct: true, score: 1 }, { questionId: 'q3', correct: false, score: 0 }, { questionId: 'q4', correct: true, score: 0.75 }])
    assert.equal(borderline.score, 0.7)
    assert.equal(borderline.passed, true)
    const fail = computeExamResult(paper,
      [{ questionId: 'q1', correct: true, score: 1 }, { questionId: 'q2', correct: false, score: 0 }, { questionId: 'q3', correct: false, score: 0 }, { questionId: 'q4', correct: false, score: 0.25 }])
    assert.equal(fail.passed, false)
  })
})

describe('大考评分与掌握度边界', () => {
  const grades: ExamGrading[] = paper.questions.map((q) => ({ questionId: q.id, score: 1, correct: true }))
  const mastery: Mastery = { a: { status: 'mastered', score: 1, review_stage: 1 }, b: { status: 'mastered', score: 1, review_stage: 1 } }

  it('真实客观题判分 + 模型 0–1 主观题判分，全对得满分', () => {
    const subjective = validateSubjectiveGradings({ gradings: [{ questionId: 'q4', score: 1, note: '完整' }] }, [paper.questions[3]])
    assert.ok(subjective.ok)
    const combined = paper.questions.slice(0, 3).map((q) => gradeObjective(q, q.answer)).concat(subjective.value)
    assert.equal(computeExamResult(paper, combined).score, 1)
  })

  it('同一节点按权重聚合，题序不改变掌握度，每场只升一阶', () => {
    const mixed = grades.map((g) => g.questionId === 'q1' ? { ...g, score: 0, correct: false } : g)
    const first = applyExamMastery(paper, mixed, mastery, '2026-10-08')
    const reversed = applyExamMastery({ ...paper, questions: [...paper.questions].reverse() }, [...mixed].reverse(), mastery, '2026-10-08')
    assert.deepEqual(first, reversed)
    assert.equal(first.a.score, 0.5)
    assert.equal(first.a.status, 'learning')
    assert.equal(first.b.review_stage, 2)
    assert.equal(first.b.review_due, '2026-10-11')
    assert.equal(mastery.b.review_stage, 1)
  })

  it('缺项、重复题号、未知题号、越界或非数值判分均拒绝，不生成成绩', () => {
    for (const raw of [[], [{ questionId: 'q4', score: 2 }], [{ questionId: 'q4', score: -1 }],
      [{ questionId: 'q4', score: NaN }], [{ questionId: 'q4', score: '1' }],
      [{ questionId: 'ghost', score: 1 }], [{ questionId: 'q4', score: 1 }, { questionId: 'q4', score: 1 }]]) {
      assert.equal(validateSubjectiveGradings({ gradings: raw }, [paper.questions[3]]).ok, false)
    }
    assert.throws(() => computeExamResult(paper, grades.slice(1)), /遗漏/)
    assert.throws(() => applyExamMastery(paper, grades.slice(1), mastery, '2026-10-08'), /遗漏/)
  })

  it('试卷题号须唯一且覆盖所有节点', () => {
    assert.match(paperValid({ ...paper, questions: paper.questions.map((q) => ({ ...q, id: 'same' })) }, ['a', 'b'])!, /重复/)
    assert.match(paperValid(paper, ['a', 'b', 'c'])!, /未覆盖/)
    assert.match(paperValid({ ...paper, questions: paper.questions.map((q) => ({ ...q, points: NaN })) }, ['a', 'b'])!, /points/)
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
