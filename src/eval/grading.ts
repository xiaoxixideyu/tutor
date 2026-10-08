import type { ExamGrading, ExamQuestion } from '../core/exam.ts'

export interface GradingCase {
  id: string
  category: string
  question: ExamQuestion
  answer: string
  expected: { min: number; max: number; rationale: string }
}

export interface GradingSuite {
  id: string
  title: string
  cases: GradingCase[]
}

export interface GradingFixtures {
  version: number
  provenance: string
  maxSpread: number
  suites: GradingSuite[]
}

export interface GradingRun {
  suiteId: string
  repeat: number
  gradings?: ExamGrading[]
  error?: string
}

export function validateGradingFixtures(data: unknown): GradingFixtures {
  const fixture = data as GradingFixtures
  if (!fixture || fixture.version !== 1 || typeof fixture.provenance !== 'string'
    || !Number.isFinite(fixture.maxSpread) || fixture.maxSpread < 0 || fixture.maxSpread > 1
    || !Array.isArray(fixture.suites) || fixture.suites.length === 0) throw new Error('评测集结构无效')
  const suites = new Set<string>()
  for (const suite of fixture.suites) {
    if (!suite || typeof suite.id !== 'string' || !suite.id || suites.has(suite.id)
      || typeof suite.title !== 'string' || !Array.isArray(suite.cases) || suite.cases.length === 0) throw new Error('评测分组为空或重复')
    suites.add(suite.id)
    const ids = new Set<string>()
    const questions = new Set<string>()
    for (const item of suite.cases) {
      const q = item?.question
      const range = item?.expected
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)
        || typeof item.category !== 'string' || typeof item.answer !== 'string'
        || !q || typeof q.id !== 'string' || !q.id || questions.has(q.id) || q.type !== 'subjective'
        || typeof q.node !== 'string' || typeof q.question !== 'string' || typeof q.answer !== 'string'
        || !q.answer || !Number.isFinite(q.points) || q.points <= 0
        || (q.keywords !== undefined && (!Array.isArray(q.keywords) || q.keywords.some(k => typeof k !== 'string')))
        || !range || !Number.isFinite(range.min) || !Number.isFinite(range.max)
        || range.min < 0 || range.max > 1 || range.min > range.max || typeof range.rationale !== 'string') {
        throw new Error(`评测样本无效：${suite.id}/${item?.id ?? '?'}`)
      }
      ids.add(item.id)
      questions.add(q.id)
    }
  }
  return fixture
}

// 只把题目和作答交给阅卷模型；期望分数、样本标签和评分理由留在评测侧。
export function gradingInputs(suite: GradingSuite, repeat: number) {
  const offset = repeat % suite.cases.length
  const ordered = [...suite.cases.slice(offset), ...suite.cases.slice(0, offset)]
  return { questions: ordered.map(item => item.question), answers: new Map(ordered.map(item => [item.question.id, item.answer])) }
}

export function summarizeGrading(fixtures: GradingFixtures, runs: GradingRun[], repeats: number) {
  const cases = fixtures.suites.flatMap(suite => suite.cases.map(item => {
    const samples = Array.from({ length: repeats }, (_, repeat) => {
      const matches = runs.filter(run => run.suiteId === suite.id && run.repeat === repeat)
      if (matches.length !== 1 || matches[0].error) return null
      const grades = matches[0].gradings?.filter(grade => grade.questionId === item.question.id) ?? []
      const score = grades[0]?.score
      return grades.length === 1 && Number.isFinite(score) && score >= 0 && score <= 1 ? score : null
    })
    const scores = samples.filter((score): score is number => score !== null)
    const complete = scores.length === repeats
    const inRange = scores.filter(score => score >= item.expected.min - 1e-9 && score <= item.expected.max + 1e-9).length
    const spread = scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : null
    const stable = complete && repeats > 1 && spread !== null && spread <= fixtures.maxSpread + 1e-9
    return { suiteId: suite.id, caseId: item.id, category: item.category, expected: item.expected,
      samples, complete, inRange, spread, stable, passed: complete && inRange === repeats && stable }
  }))
  const expectedSamples = cases.length * repeats
  const observedSamples = cases.reduce((sum, item) => sum + item.samples.filter(score => score !== null).length, 0)
  const inRangeSamples = cases.reduce((sum, item) => sum + item.inRange, 0)
  return { expectedSamples, observedSamples, inRangeSamples,
    rangeRate: expectedSamples ? inRangeSamples / expectedSamples : 0,
    stableCases: cases.filter(item => item.stable).length,
    passed: cases.length > 0 && cases.every(item => item.passed), cases }
}
