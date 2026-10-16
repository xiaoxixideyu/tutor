import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays, daysBetween, gradeForScore, intervalDays, memoryCard, MIN_STABILITY,
  nextStability, retrievability, stabilityOf, STAGE_STABILITY,
} from '../src/core/scheduler.ts'

describe('scheduler：日期与可提取性', () => {
  it('addDays / daysBetween 按 UTC 日期计算，可跨月', () => {
    assert.equal(addDays('2026-09-17', 3), '2026-09-20')
    assert.equal(addDays('2026-09-28', 5), '2026-10-03')
    assert.equal(daysBetween('2026-09-17', '2026-10-17'), 30)
    assert.equal(daysBetween('2026-10-17', '2026-09-17'), -30)
    assert.equal(daysBetween('bad', '2026-09-17'), 0)
  })

  it('R(t) = 0.9^(t/S)：S 天时保留率 90%，两倍 S 时 81%', () => {
    assert.equal(retrievability(0, 10), 1)
    assert.equal(retrievability(10, 10), 0.9)
    assert.equal(retrievability(20, 10), 0.81)
    assert.equal(retrievability(5, 0), 0)
  })

  it('旧数据按 review_stage 迁移；无锚点不给保留率（不猜）', () => {
    assert.deepEqual(STAGE_STABILITY, { 1: 1, 2: 3, 3: 7, 4: 14 })
    assert.equal(stabilityOf({ review_stage: 2 }), 3)
    assert.equal(stabilityOf({ stability: 4.2, review_stage: 1 }), 4.2)
    assert.equal(stabilityOf({}), undefined)
    assert.equal(stabilityOf(undefined), undefined)
    assert.equal(memoryCard({ review_stage: 2 }, '2026-09-18'), undefined)
    const card = memoryCard({ review_stage: 2, stability: 3, last_touched_at: '2026-09-08' }, '2026-09-18')
    assert.deepEqual(card, { elapsedDays: 10, stability: 3, retention: retrievability(10, 3) })
  })
})

describe('scheduler：评分与稳定性演进', () => {
  it('分数映射四级评分', () => {
    assert.equal(gradeForScore(0.33), 'again')
    assert.equal(gradeForScore(0.5), 'hard')
    assert.equal(gradeForScore(0.74), 'hard')
    assert.equal(gradeForScore(0.75), 'good')
    assert.equal(gradeForScore(0.99), 'good')
    assert.equal(gradeForScore(1), 'easy')
  })

  it('首学/无历史：从 INITIAL_STABILITY 1.5 起算', () => {
    assert.equal(nextStability(undefined, 'hard'), 2.1)
    assert.equal(nextStability(undefined, 'good'), 2.7)
    assert.equal(nextStability(undefined, 'easy'), 3.6)
  })

  it('逾期后成功回忆有加成，封顶 0.6 倍', () => {
    assert.equal(nextStability(10, 'good', 10), 18) // 准时：1.8 倍
    assert.equal(nextStability(10, 'good', 20), 23.4) // 逾期到 2 倍：×1.3
    assert.equal(nextStability(10, 'good', 100), 28.8) // 严重逾期：封顶 ×1.6
  })

  it('失败衰减到 0.3 倍，不低于 MIN_STABILITY', () => {
    assert.equal(nextStability(5, 'again'), 1.5)
    assert.equal(nextStability(2, 'again'), MIN_STABILITY)
    assert.equal(nextStability(300, 'again'), 90)
  })

  it('稳定性封顶 MAX_STABILITY 365 天', () => {
    assert.equal(nextStability(300, 'easy', 300), 365)
  })

  it('目标保留率反推间隔：0.9 时间隔即 stability，目标放宽则间隔更长', () => {
    assert.equal(intervalDays(10), 10)
    assert.equal(intervalDays(10, 0.8), 21)
    assert.equal(intervalDays(0.2), 1) // 下限 1 天
    assert.equal(intervalDays(500), 365) // 上限 365 天
  })

  it('隔一天 vs 隔一个月：准时通过间隔小幅扩张，逾期一个月通过加成更大但仍从短到长', () => {
    const onTime = nextStability(7, 'good', 7)
    const monthLater = nextStability(7, 'good', 30)
    assert.equal(onTime, 12.6)
    assert.equal(monthLater, 20.16)
    assert.ok(monthLater > onTime)
    // 隔一个月失败：稳定性衰减，次日重试重建（不清队列）
    const failed = nextStability(7, 'again', 30)
    assert.equal(failed, 2.1)
  })
})
