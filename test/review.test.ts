import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dueReviews, pickReviewQuestions, postponeReview } from '../src/core/review.ts'
import { applyReviewResult, nextReviewStage } from '../src/core/assessment.ts'
import { retrievability, STAGE_STABILITY } from '../src/core/scheduler.ts'
import type { Mastery, QuestionBank } from '../src/core/schema.ts'

function choice(id: string, difficulty: 1 | 2 | 3, answer = 'B'): QuestionBank[string][number] {
  return { id, difficulty, type: 'choice', question: `Q ${id}`, choices: ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁'], answer }
}

describe('dueReviews', () => {
  it('只收到期项，按到期日排序，带逾期天数', () => {
    const mastery: Mastery = {
      a: { status: 'learning', review_due: '2026-09-17', review_stage: 2 },
      b: { status: 'weak', review_due: '2026-09-10' },
      c: { status: 'learning', review_due: '2026-10-01' },
      d: { status: 'weak' },
    }
    const due = dueReviews(mastery, '2026-09-18')
    assert.deepEqual(due.map((d) => d.node), ['b', 'a'])
    assert.equal(due[0].overdue_days, 8)
    assert.equal(due[1].stage, 2)
    assert.equal(due[1].overdue_days, 1)
    // 旧数据没有实测锚点：不给保留率估计（不猜）
    assert.equal('retention' in due[0], false)
  })

  it('有实测锚点时给出稳定性与今日保留率估计', () => {
    const mastery: Mastery = {
      a: { status: 'mastered', score: 1, review_due: '2026-09-18', review_stage: 3, stability: 7, last_touched_at: '2026-09-08' },
    }
    const due = dueReviews(mastery, '2026-09-18')
    assert.equal(due[0].stability, 7)
    assert.equal(due[0].retention, retrievability(10, 7))
    assert.equal(due[0].overdue_days, 0)
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
  it('通过则阶梯 +1，间隔按稳定性扩张（旧数据按 stage 迁移）', () => {
    const mastery: Mastery = { a: { status: 'learning', score: 0.6, review_stage: 1 } }
    assert.equal(nextReviewStage(mastery.a), 2)
    const updated = applyReviewResult(mastery, 'a', 0.6, '2026-09-18')
    assert.equal(updated.a.status, 'learning')
    assert.equal(updated.a.review_stage, 2)
    // 旧 stage 1 → 迁移稳定性 1 天；hard 通过 ×1.4 → 1.4 天
    assert.equal(updated.a.stability, 1.4)
    assert.equal(updated.a.review_due, '2026-09-19')
    assert.equal(updated.a.last_touched_at, '2026-09-18')
  })

  it('通过则分数取更高，保持或晋升 mastered', () => {
    const mastery: Mastery = { a: { status: 'learning', score: 0.6, review_stage: 3 } }
    const better = applyReviewResult(mastery, 'a', 1, '2026-09-18')
    assert.equal(better.a.score, 1)
    assert.equal(better.a.status, 'mastered')
    // stage 3 → 迁移 7 天；easy ×2.4 = 16.8 天
    assert.equal(better.a.review_due, '2026-10-05')
    const masteredKept = applyReviewResult(
      { a: { status: 'mastered', score: 1, review_stage: 4 } },
      'a',
      0.5,
      '2026-09-18'
    )
    assert.equal(masteredKept.a.status, 'mastered')
    assert.equal(masteredKept.a.review_stage, 4)
  })

  it('不通过则衰减稳定性、回退一级并次日重试（不清空复习队列）', () => {
    const mastery: Mastery = { a: { status: 'mastered', score: 1, review_due: '2026-09-18', review_stage: 2 } }
    const updated = applyReviewResult(mastery, 'a', 0.33, '2026-09-18')
    assert.equal(updated.a.status, 'weak')
    assert.equal(updated.a.score, 0.33)
    assert.equal(updated.a.review_stage, 1)
    assert.equal(updated.a.review_due, '2026-09-19')
    assert.equal(updated.a.lapses, 1)
    // 旧 stage 2 → 3 天 × 0.3 = 0.9 → 不低于 MIN_STABILITY 1
    assert.equal(updated.a.stability, 1)
    const again = applyReviewResult(updated, 'a', 0.3, '2026-09-19')
    assert.equal(again.a.lapses, 2)
  })

  it('阶梯边界：stage4 通过不再封顶间隔、stage1 失败停在第 1 阶', () => {
    const capped = applyReviewResult({ a: { status: 'mastered', score: 1, review_stage: 4 } }, 'a', 1, '2026-09-18')
    assert.equal(capped.a.review_stage, 4)
    // 14 × 2.4 = 33.6 → 34 天：间隔随稳定性继续扩张，不再卡在 14 天
    assert.equal(capped.a.review_due, '2026-10-22')
    const floor = applyReviewResult({ a: { status: 'learning', score: 0.6, review_stage: 1 } }, 'a', 0.2, '2026-09-18')
    assert.equal(floor.a.review_stage, 1)
    assert.equal(floor.a.review_due, '2026-09-19')
    assert.equal(floor.a.status, 'weak')
  })

  it('旧数据无 review_stage：通过按首次复习，失败停在第 1 阶', () => {
    const first = applyReviewResult({ a: { status: 'learning', score: 0.6 } }, 'a', 0.7, '2026-09-18')
    assert.equal(first.a.review_stage, 1)
    // 无历史稳定性：从 INITIAL_STABILITY 1.5 起算，hard ×1.4 = 2.1 → 2 天
    assert.equal(first.a.review_due, '2026-09-20')
    const failed = applyReviewResult({ a: { status: 'learning', score: 0.6 } }, 'a', 0.3, '2026-09-18')
    assert.equal(failed.a.review_stage, 1)
    assert.equal(failed.a.review_due, '2026-09-19')
  })

  it('stage3 失败回退到 stage2 并次日重试；0.5 边界算通过', () => {
    const stepped = applyReviewResult({ a: { status: 'learning', score: 0.7, review_stage: 3 } }, 'a', 0.4, '2026-09-18')
    assert.equal(stepped.a.review_stage, 2)
    assert.equal(stepped.a.review_due, '2026-09-19')
    const boundary = applyReviewResult({ a: { status: 'learning', score: 0.6, review_stage: 1 } }, 'a', 0.5, '2026-09-18')
    assert.equal(boundary.a.review_stage, 2)
    assert.equal(boundary.a.review_due, '2026-09-19')
  })

  it('逾期后成功回忆获得稳定性加成：隔得越久通过，间隔扩张越多但仍有界', () => {
    const onTime = applyReviewResult(
      { a: { status: 'mastered', score: 1, review_stage: 3, stability: 7, last_touched_at: '2026-09-11' } },
      'a', 0.8, '2026-09-18'
    )
    const overdue = applyReviewResult(
      { a: { status: 'mastered', score: 1, review_stage: 3, stability: 7, last_touched_at: '2026-08-19' } },
      'a', 0.8, '2026-09-18'
    )
    // 准时：7 × 1.8 = 12.6；逾期 30 天：12.6 × 1.6（封顶） = 20.16
    assert.equal(onTime.a.stability, 12.6)
    assert.equal(overdue.a.stability, 20.16)
    assert.equal(onTime.a.review_due, '2026-10-01')
    assert.equal(overdue.a.review_due, '2026-10-08')
    assert.ok((overdue.a.stability ?? 0) > (onTime.a.stability ?? 0))
  })

  it('旧数据按 review_stage 迁移稳定性（1/3/7/14）', () => {
    assert.deepEqual(STAGE_STABILITY, { 1: 1, 2: 3, 3: 7, 4: 14 })
  })
})

describe('postponeReview', () => {
  it('题库缺失时顺延 1 天，状态与阶梯不动', () => {
    const mastery: Mastery = { a: { status: 'learning', score: 0.6, review_due: '2026-09-18', review_stage: 2 } }
    const postponed = postponeReview(mastery, 'a', '2026-09-18')
    assert.equal(postponed.a.review_due, '2026-09-19')
    assert.equal(postponed.a.review_stage, 2)
    assert.equal(postponed.a.status, 'learning')
    assert.equal(postponed.a.score, 0.6)
  })

  it('无 review_due 的节点原样返回', () => {
    const mastery: Mastery = { a: { status: 'weak', score: 0.3 } }
    assert.equal(postponeReview(mastery, 'a', '2026-09-18'), mastery)
  })
})
