import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { gradingInputs, summarizeGrading, validateGradingFixtures, type GradingRun } from '../src/eval/grading.ts'
import { buildExamGradingPrompt } from '../src/plugin/exam-runner.ts'

const fixtures = validateGradingFixtures(JSON.parse(fs.readFileSync(new URL('../evals/grading.json', import.meta.url), 'utf8')))
const passingRuns = (): GradingRun[] => Array.from({ length: 3 }, (_, repeat) => fixtures.suites.map(suite => ({
  suiteId: suite.id, repeat, gradings: suite.cases.map(item => ({ questionId: item.question.id,
    score: (item.expected.min + item.expected.max) / 2, correct: item.expected.min >= 0.7 })),
}))).flat()

it('固定样本覆盖两个领域，拒绝重复题号与无效期望区间', () => {
  assert.equal(fixtures.suites.length, 2)
  assert.equal(fixtures.suites.reduce((sum, suite) => sum + suite.cases.length, 0), 12)
  const duplicate = structuredClone(fixtures)
  duplicate.suites[0].cases[1].question.id = duplicate.suites[0].cases[0].question.id
  assert.throws(() => validateGradingFixtures(duplicate), /样本无效/)
  const invalidRange = structuredClone(fixtures)
  invalidRange.suites[0].cases[0].expected.max = -1
  assert.throws(() => validateGradingFixtures(invalidRange), /样本无效/)
})

it('正式判分提示不泄露期望分数和样本标签，轮次变化会轮换题序', () => {
  const suite = fixtures.suites[0]
  const first = gradingInputs(suite, 0)
  const second = gradingInputs(suite, 1)
  assert.notEqual(first.questions[0].id, second.questions[0].id)
  assert.equal(second.answers.get(suite.cases[0].question.id), suite.cases[0].answer)
  const prompt = buildExamGradingPrompt(first.questions, first.answers)
  for (const item of suite.cases) {
    assert.ok(prompt.includes(item.answer))
    assert.ok(!prompt.includes(item.id))
    assert.ok(!prompt.includes(item.expected.rationale))
  }
})

it('区间命中与稳定性同时达标才通过', () => {
  const summary = summarizeGrading(fixtures, passingRuns(), 3)
  assert.equal(summary.passed, true)
  assert.equal(summary.inRangeSamples, 36)
  assert.equal(summary.stableCases, 12)
})

it('质量失败不能隐藏在平均分中', () => {
  const runs = passingRuns()
  runs[0].gradings![0].score = 0.5
  const summary = summarizeGrading(fixtures, runs, 3)
  assert.equal(summary.passed, false)
  assert.equal(summary.inRangeSamples, 35)
  assert.equal(summary.cases[0].passed, false)
})

it('区间内分数波动过大仍未通过一致性验收', () => {
  const broad = structuredClone(fixtures)
  broad.suites[0].cases[0].expected.min = 0
  const runs = passingRuns()
  runs[0].gradings![0].score = 0.2
  const summary = summarizeGrading(broad, runs, 3)
  assert.equal(summary.rangeRate, 1)
  assert.equal(summary.cases[0].stable, false)
  assert.equal(summary.passed, false)
})

it('缺轮、重复运行、运行错误和无效得分均不能冒充成功样本', () => {
  const all = passingRuns()
  const missing = summarizeGrading(fixtures, all.slice(1), 3)
  assert.equal(missing.passed, false)
  assert.equal(missing.observedSamples, 30)
  assert.equal(summarizeGrading(fixtures, [...all, all[0]], 3).passed, false)
  const failed = passingRuns()
  failed[0].error = '网络失败'
  assert.equal(summarizeGrading(fixtures, failed, 3).observedSamples, 30)
  const invalid = passingRuns()
  invalid[0].gradings![0].score = NaN
  assert.equal(summarizeGrading(fixtures, invalid, 3).observedSamples, 35)
  assert.equal(summarizeGrading(fixtures, [], 3).passed, false)
})
