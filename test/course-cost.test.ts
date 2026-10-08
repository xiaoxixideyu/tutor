import { it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeCourseCosts, type CourseStage } from '../src/eval/course-cost.ts'
import { DEFAULT_COST_CONFIG } from '../src/core/cost.ts'

it('完整课程账包含失败用量，开始/错误通知不重复计费，未结算请求单独列出', () => {
  const stages: CourseStage[] = [{ stageId: '1', courseId: 'course', stage: 'research', model: 'model', status: 'failed', attempts: [
    { type: 'attempt-start', attemptId: '1' },
    { type: 'attempt', attemptId: '1', usage: { inputTokens: 100, outputTokens: 20 } },
    { type: 'request-error' },
    { type: 'attempt-start', attemptId: '2' },
    { type: 'attempt', attemptId: '2', usage: null },
    { type: 'attempt-start', attemptId: '3' },
  ] }, { stageId: '2', courseId: 'course', stage: 'learn', model: 'model', status: 'completed', attempts: [
    { type: 'attempt', attemptId: '1', usage: { inputTokens: 200, outputTokens: 40 } },
  ] }]
  const summary = summarizeCourseCosts(stages, DEFAULT_COST_CONFIG)
  assert.deepEqual(summary.usage, { inputTokens: 300, outputTokens: 60 })
  assert.equal(summary.unreportedAttempts, 2)
  assert.equal(summary.rows[0].attempts, 3)
  assert.equal(summary.actualBill, null)
  assert.throws(() => summarizeCourseCosts([...stages, stages[0]], DEFAULT_COST_CONFIG), /重复/)
})
