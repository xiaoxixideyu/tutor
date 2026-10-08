import { addUsage, estimateCost, ratesForModel, type CostConfig, type UsageSample } from '../core/cost.ts'

export interface CourseAttempt {
  type: string
  attemptId?: string
  model?: string
  usage?: UsageSample | null
  elapsedMs?: number | null
  firstTextMs?: number
  outcome?: { eventType?: string }
}
export interface CourseStage {
  stageId: string
  courseId: string
  stage: string
  model: string
  status: string
  attempts: CourseAttempt[]
}

export function summarizeCourseCosts(stages: CourseStage[], config: CostConfig) {
  if (new Set(stages.map(stage => stage.stageId)).size !== stages.length) throw new Error('阶段记录重复，不能重复计费')
  const rows = stages.map(stage => {
    const final = stage.attempts.filter(item => item.type === 'attempt')
    const finished = new Set(final.map(item => item.attemptId))
    const incomplete = stage.attempts.filter(item => item.type === 'attempt-start' && !finished.has(item.attemptId))
    const usage = final.reduce((sum, item) => addUsage(sum, item.usage ?? { inputTokens: 0, outputTokens: 0 }), { inputTokens: 0, outputTokens: 0 })
    return { stageId: stage.stageId, courseId: stage.courseId, stage: stage.stage, model: stage.model, status: stage.status,
      attempts: final.length + incomplete.length, unreportedAttempts: final.filter(item => !item.usage).length + incomplete.length,
      usage, estimated: estimateCost(usage, ratesForModel(config, stage.model)),
      responseMs: final.filter(item => item.outcome?.eventType === 'assistant/message' && typeof item.elapsedMs === 'number').map(item => item.elapsedMs!),
    }
  })
  return { rows, usage: rows.reduce((sum, row) => addUsage(sum, row.usage), { inputTokens: 0, outputTokens: 0 }),
    estimated: Math.round(rows.reduce((sum, row) => sum + row.estimated, 0) * 10000) / 10000,
    unreportedAttempts: rows.reduce((sum, row) => sum + row.unreportedAttempts, 0), currency: config.currency, actualBill: null }
}
