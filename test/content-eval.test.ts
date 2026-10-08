import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { contentRunPassed, summarizeContent, validateContentFixtures, type ContentRun } from '../src/eval/content.ts'

const fixtures = validateContentFixtures(JSON.parse(fs.readFileSync(new URL('../evals/content-regressions.json', import.meta.url), 'utf8')))

it('固定内容样本同时包含真实错误和正确对照，概率原卷四道越界题逐题验收', () => {
  assert.ok(fixtures.cases.some(item => item.expected.approved))
  assert.ok(fixtures.cases.some(item => !item.expected.approved))
  const paper = fixtures.cases.find(item => item.id === 'probability-exam-scope-bad')!
  assert.deepEqual(paper.expected.rejectedUnits?.map(item => item.id), ['q3', 'q4', 'q5', 'q6'])
  const duplicate = structuredClone(fixtures)
  duplicate.cases.push(duplicate.cases[0])
  assert.throws(() => validateContentFixtures(duplicate), /重复/)
})

it('拒绝坏样本但遗漏问题定位、运行出错、使用缓存或缺少重复轮次，都不能算验收通过', () => {
  const bad = fixtures.cases.find(item => item.id === 'probability-exam-scope-bad')!
  const run: ContentRun = { caseId: bad.id, repeat: 0, approved: false, review: { units: bad.input.units.map(unit => ({ id: unit.id,
    scope: unit.id === 'q3' ? 'fail' : 'pass', correctness: 'pass', explanation: '核查说明', arithmetic: [], assertions: [] })) } }
  assert.equal(contentRunPassed(bad, run), false)
  for (const unit of run.review!.units) if (['q4', 'q5', 'q6'].includes(unit.id)) unit.scope = 'fail'
  assert.equal(contentRunPassed(bad, run), true)
  assert.equal(contentRunPassed(bad, { ...run, error: '模型未响应' }), false)
  assert.equal(contentRunPassed(bad, { ...run, cached: true }), false)
  const subset = { ...fixtures, cases: [bad] }
  assert.equal(summarizeContent(subset, [run], 2).passed, false)
  assert.equal(summarizeContent(subset, [run, { ...run, repeat: 1 }], 2).passed, true)
  assert.equal(summarizeContent(subset, [run, run], 2).passed, false)
})
