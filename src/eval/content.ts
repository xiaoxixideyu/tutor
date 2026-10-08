import { validateContentInput, type ContentInput, type ContentReview } from '../core/content-quality.ts'

export interface ContentCase {
  id: string
  provenance: string
  input: ContentInput
  expected: { approved: boolean; rationale: string; rejectedUnits?: { id: string; dimension: 'scope' | 'correctness' }[] }
}
export interface ContentFixtures { version: 1; provenance: string; cases: ContentCase[] }
export interface ContentRun { caseId: string; repeat: number; approved?: boolean; cached?: boolean; review?: ContentReview; error?: string }

export function validateContentFixtures(value: unknown): ContentFixtures {
  const fixtures = value as ContentFixtures
  if (!fixtures || fixtures.version !== 1 || !fixtures.provenance || !Array.isArray(fixtures.cases) || !fixtures.cases.length) throw new Error('内容评测样本格式错误')
  const ids = new Set<string>()
  for (const item of fixtures.cases) {
    if (!/^[a-z0-9-]+$/.test(item.id) || ids.has(item.id) || !item.provenance || typeof item.expected?.approved !== 'boolean' || !item.expected.rationale) throw new Error('样本 id 重复或缺少来源/预期')
    ids.add(item.id)
    validateContentInput(item.input)
    for (const unit of item.expected.rejectedUnits ?? []) if (item.expected.approved || !item.input.units.some(u => u.id === unit.id) || !['scope', 'correctness'].includes(unit.dimension)) throw new Error('预期拒绝单元非法')
  }
  return fixtures
}

export function contentRunPassed(item: ContentCase, run: ContentRun): boolean {
  if (run.error || run.cached || run.approved !== item.expected.approved) return false
  return (item.expected.rejectedUnits ?? []).every(unit => run.review?.units.find(u => u.id === unit.id)?.[unit.dimension] === 'fail')
}
export function summarizeContent(fixtures: ContentFixtures, runs: ContentRun[], repeats: number) {
  const cases = fixtures.cases.map(item => {
    const attempts = runs.filter(run => run.caseId === item.id)
    const correct = attempts.filter(run => contentRunPassed(item, run)).length
    const complete = attempts.length === repeats && new Set(attempts.map(run => run.repeat)).size === repeats
      && attempts.every(run => Number.isInteger(run.repeat) && run.repeat >= 0 && run.repeat < repeats)
    return { id: item.id, expectedApproved: item.expected.approved, correct, total: attempts.length, passed: complete && correct === repeats }
  })
  return { passed: runs.length === fixtures.cases.length * repeats && cases.every(item => item.passed),
    correct: cases.reduce((sum, item) => sum + item.correct, 0), expected: fixtures.cases.length * repeats,
    falseApprovals: runs.filter(run => run.approved === true && fixtures.cases.find(item => item.id === run.caseId)?.expected.approved === false).length,
    falseRejections: runs.filter(run => !run.error && run.approved === false && fixtures.cases.find(item => item.id === run.caseId)?.expected.approved === true).length,
    errors: runs.filter(run => run.error).length, cases }
}
