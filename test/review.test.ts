import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dueReviews, pickReviewQuestions } from '../src/core/review.ts'
import { applyReviewResult, nextReviewStage, REVIEW_INTERVALS } from '../src/core/assessment.ts'
import type { Mastery, QuestionBank } from '../src/core/schema.ts'

function choice(id: string, difficulty: 1 | 2 | 3, answer = 'B'): QuestionBank[string][number] {
  return { id, difficulty, type: 'choice', question: `Q ${id}`, choices: ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁'], answer }
}

describe('dueReviews', () => {
  it('只收到期项，按到期日排序', () => {
    const mastery: Mastery = {
      a: { status: 'learning', review_due: '2026-09-17', review_stage: 2 },
      b: { status: 'weak', review_due: '2026-09-10' },
      c: { status: 'learning', review_due: '2026-10-01' },
      d: { status: 'weak' },
    }
    const due = dueReviews(mastery, '2026-09-18')
    assert.deepEqual(due.map((d) => d.node), ['b', 'a'])
    assert.equal(due[1].stage, 2)
  })
})

describe('pickReviewQuestions', () => {
  it('优先 d2+d3，缺则回退，至多 2 题', () => {
    const bank: QuestionBank = { x: [choice('x1', 1), choice('x2', 2), choice('x3', 3)] }
    assert.deepEqual(pickReviewQuestions(bank, 'x').map((q) => q.difficulty), [2, 3])
    const partial: QuestionBank = { y: [choice('y1', 1), choice('y2', 2)] }
    assert.deepEqual(pickReviewQuestions(partial, 'y').map((q) => q.difficulty), [2, 1])
    assert.deepEqual(pickReviewQuestions({}, 'ghost'), [])
  })
})

describe('applyReviewResult / nextReviewStage', () => {
  it('通过则阶梯 +1（1/3/7/14 封顶）', () => {
    assert.deepEqual(REVIEW_INTERVALS, [1, 3, 7, 14])
    const mastery: Mastery = { a: { status: 'learning', score: 0.6, review_stage: 1 } }
    assert.equal(nextReviewStage(mastery.a), 2)
    const updated = applyReviewResult(mastery, 'a', 0.6, '2026-09-18')
    assert.equal(updated.a.status, 'learning')
    assert.equal(updated.a.review_due, '2026-09-21')
    assert.equal(updated.a.review_stage, 2)
  })

  it('通过则分数取更高，保持或晋升 mastered', () => {
    const mastery: Mastery = { a: { status: 'learning', score: 0.6, review_stage: 3 } }
    const better = applyReviewResult(mastery, 'a', 1, '2026-09-18')
    assert.equal(better.a.score, 1)
    assert.equal(better.a.status, 'mastered')
    const masteredKept = applyReviewResult(
      { a: { status: 'mastered', score: 1, review_stage: 4 } },
      'a',
      0.5,
      '2026-09-18'
    )
    assert.equal(masteredKept.a.status, 'mastered')
    assert.equal(masteredKept.a.review_stage, 4)
  })

  it('不通过则重置（清 review_due/stage，按新分数定级）', () => {
    const mastery: Mastery = { a: { status: 'mastered', score: 1, review_due: '2026-09-18', review_stage: 2 } }
    const updated = applyReviewResult(mastery, 'a', 0.33, '2026-09-18')
    assert.equal(updated.a.status, 'weak')
    assert.equal(updated.a.score, 0.33)
    assert.equal('review_due' in updated.a, false)
    assert.equal('review_stage' in updated.a, false)
  })
})
