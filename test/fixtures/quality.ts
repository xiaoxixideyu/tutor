// 状态机/CLI 测试使用已知正确的固定内容；仅为测试签发完整审查回执，无生产绕过开关。
import { randomUUID } from 'node:crypto'
import { contentKey, factProbes, QUALITY_POLICY, requiredAssertions, type ContentInput } from '../../src/core/content-quality.ts'
import { QualityStore } from '../../src/core/quality-store.ts'

export function approveFixture(root: string, courseId: string, input: ContentInput): void {
  new QualityStore(root, courseId).save({
    id: randomUUID(), key: contentKey(input), policy: QUALITY_POLICY, status: 'approved', input,
    startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:00:01Z',
    calls: ['solver', 'reviewer', 'facts'].map(role => ({ role: role as 'solver' | 'reviewer' | 'facts', sessionId: `test-${role}`,
      prompt: '离线测试固定内容', model: 'test', usage: { inputTokens: 0, outputTokens: 0 } })),
    solutions: input.units.flatMap(unit => unit.question ? [{ id: unit.id, status: 'solved' as const,
      answer: unit.question.answer, reasoning: '测试预先校验的固定答案', arithmetic: [] }] : []),
    facts: factProbes(input).map(f => ({ id: f.id, verdict: 'pass', explanation: '固定内容已核对', arithmetic: [] })),
    review: { units: input.units.map(unit => ({ id: unit.id, scope: 'pass', correctness: 'pass', explanation: '离线固定内容已核对', arithmetic: [],
      assertions: requiredAssertions(input, unit).map(a => ({ id: a.id, verdict: 'pass', explanation: '固定内容已核对' })) })) },
    issues: [],
  })
}
