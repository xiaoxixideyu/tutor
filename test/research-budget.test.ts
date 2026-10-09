import { it } from 'node:test'
import assert from 'node:assert/strict'
import { ResearchBudget, ResearchBudgetError, RESEARCH_LIMITS } from '../src/plugin/research-budget.ts'

const search = 'mcp__searchix__search_proxy_tavily_search'
const fallback = 'mcp__searchix__search_proxy_exa_search'

it('同轮并发工具调用也受次数限制，未知工具不能消耗或绕过预算', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.ok(budget.claim('grep'))
  assert.equal(budget.searches, 0)
  assert.equal(Array.from({ length: 10 }, () => budget.claim(search)).filter(result => result === undefined).length, 3)
  assert.equal(Array.from({ length: 10 }, () => budget.claim('web_fetch')).filter(result => result === undefined).length, 2)
  assert.equal(budget.available(search), false)
  assert.equal(budget.available('web_fetch'), false)
})

it('失败的搜索服务本知识点内不反复尝试，剩余预算可用于其他服务', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.equal(budget.claim(fallback), undefined)
  const failed = budget.result(fallback, [{ type: 'text', text: '503: no capacity' }], true)
  assert.equal(failed[0].type, 'text')
  assert.equal(budget.available(fallback), false)
  assert.equal(budget.available(search), true)
  assert.ok(budget.claim(fallback))
  assert.equal(budget.searches, 1)
})

it('长网页正文不会堆积成数万 token，截断明确标记且总字数受限', () => {
  const budget = new ResearchBudget()
  const outputs = Array.from({ length: 8 }, () => budget.result('web_fetch', [{ type: 'text', text: 'source '.repeat(10000) }], false))
  const texts = outputs.flatMap(content => content.filter(block => block.type === 'text').map(block => block.text))
  assert.ok(texts.every(text => text.length <= RESEARCH_LIMITS.resultChars))
  assert.ok(texts.reduce((sum, text) => sum + text.length, 0) <= RESEARCH_LIMITS.totalChars)
  assert.match(texts[0], /截断/)
  assert.equal(budget.available('web_fetch'), false)
})

it('工具阶段之后留出汇总和修复回合，反复拒绝工具或修复不能无限追加请求', () => {
  const budget = new ResearchBudget()
  for (let i = 0; i < RESEARCH_LIMITS.toolRounds; i++) budget.startRequest()
  assert.equal(budget.available(search), false)
  budget.startRequest()
  assert.ok(budget.claim(search))
  budget.startRequest()
  assert.throws(() => budget.startRequest(), ResearchBudgetError)
  assert.equal(budget.requests, RESEARCH_LIMITS.modelRequests)
})
