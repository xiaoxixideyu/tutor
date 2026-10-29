import { it } from 'node:test'
import assert from 'node:assert/strict'
import { ResearchBudget, ResearchBudgetError, RESEARCH_LIMITS } from '../src/runtime/budget.ts'

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

it('搜索服务偶发失败不占检索次数、允许再试一次，连续两次失败才停用', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.equal(budget.claim(fallback), undefined)
  const failed = budget.result(fallback, [{ type: 'text', text: '503: no capacity' }], true)
  assert.equal(failed[0].type, 'text')
  // 网关抖动不该吃掉检索预算，也不该立刻停用服务。
  assert.equal(budget.searches, 0)
  assert.equal(budget.available(fallback), true)
  assert.equal(budget.claim(fallback), undefined)
  assert.equal(budget.searches, 1)
  budget.result(fallback, [{ type: 'text', text: '503: no capacity' }], true)
  assert.equal(budget.searches, 0)
  assert.equal(budget.available(fallback), false)
  // 另一个搜索服务仍可用
  assert.equal(budget.available(search), true)
})

it('成功一次后重新计算连续失败次数', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.equal(budget.claim(search), undefined)
  budget.result(search, [{ type: 'text', text: '503: no capacity' }], true)
  assert.equal(budget.claim(search), undefined)
  budget.result(search, [{ type: 'text', text: '{"results":[]}' }], false)
  assert.equal(budget.claim(search), undefined)
  budget.result(search, [{ type: 'text', text: '503: no capacity' }], true)
  assert.equal(budget.available(search), true)
})

it('识别 Exa 的工具命名：search/fetch/crawl 归入预算，agent_run 不暴露', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.equal(budget.claim('mcp__searchix__web_search_exa'), undefined)
  assert.equal(budget.searches, 1)
  assert.equal(budget.claim('mcp__searchix__web_search_advanced_exa'), undefined)
  assert.equal(budget.searches, 2)
  assert.equal(budget.claim('mcp__searchix__web_fetch_exa'), undefined)
  assert.equal(budget.fetches, 1)
  assert.equal(budget.claim('mcp__searchix__crawling_exa'), undefined)
  assert.equal(budget.fetches, 2)
  // 长时研究工具与站点爬取不进入教研预算
  assert.equal(budget.available('mcp__searchix__agent_run'), false)
  assert.equal(budget.available('mcp__searchix__tavily_research'), false)
  assert.equal(budget.available('mcp__searchix__tavily_crawl'), false)
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
  while (budget.requests < RESEARCH_LIMITS.modelRequests) budget.startRequest()
  assert.throws(() => budget.startRequest(), ResearchBudgetError)
  assert.equal(budget.requests, RESEARCH_LIMITS.modelRequests)
})

it('同一步的传输恢复不消耗内容轮数，也不提前剥夺工具；新一步仍受上限约束', () => {
  const budget = new ResearchBudget()
  budget.startRequest('1:1')
  budget.startRequest('1:2')
  budget.startRequest('1:3')
  for (let i = 0; i < 8; i++) budget.startRequest('1:3')
  assert.equal(budget.requests, 3)
  assert.equal(budget.available(search, !budget.hasRequest('1:3')), true)
  assert.equal(budget.available(search, !budget.hasRequest('1:4')), false)
  budget.startRequest('1:4')
  budget.startRequest('2:1')
  while (budget.requests < RESEARCH_LIMITS.modelRequests) budget.startRequest()
  assert.throws(() => budget.checkRequest('2:2'), ResearchBudgetError)
})

it('教研系统指令不随预算计数变化，保证渠道前缀缓存可复用', () => {
  const budget = new ResearchBudget()
  const before = budget.instruction()
  budget.startRequest()
  budget.claim(search)
  budget.result(search, [{ type: 'text', text: 'result' }], false)
  budget.claim('web_fetch')
  assert.equal(budget.instruction(), before)
})

it('兼容连字符命名：Tavily Hikari 的 search/extract 计入预算，未知工具不暴露', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.equal(budget.claim('mcp__searchix__tavily-search'), undefined)
  assert.equal(budget.searches, 1)
  assert.equal(budget.claim('mcp__searchix__tavily-extract'), undefined)
  assert.equal(budget.fetches, 1)
  // extract 与 web_fetch 共用抓取预算
  assert.equal(budget.claim('web_fetch'), undefined)
  assert.equal(budget.fetches, 2)
  assert.ok(budget.claim('web_fetch'))
  // crawl 等未分类工具不暴露
  assert.equal(budget.available('mcp__searchix__tavily-crawl'), false)
  assert.ok(budget.claim('mcp__searchix__tavily-crawl'))
})

it('参数不合规的搜索失败退还预算且不拉黑工具，服务失败才拉黑', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.equal(budget.claim(search), undefined)
  assert.equal(budget.searches, 1)
  // 模型把 include_answer 写成 "false" 被服务端拒绝：这是可自纠的参数错误。
  budget.result(search, [{ type: 'text', text: 'Invalid value for include_answer' }], true, 'argument')
  assert.equal(budget.searches, 0)
  assert.equal(budget.available(search), true)
  // 修正参数后仍能继续检索，不会因为一次手滑丢掉整个知识点的资料。
  assert.equal(budget.claim(search), undefined)
  assert.equal(budget.searches, 1)
  assert.equal(budget.available(search), true)
  // 真正的服务失败第一次允许重试，连续两次才按原语义拉黑该工具。
  budget.result(search, [{ type: 'text', text: '503: no capacity' }], true, 'service')
  assert.equal(budget.available(search), true)
  budget.result(search, [{ type: 'text', text: '503: no capacity' }], true, 'service')
  assert.equal(budget.available(search), false)
})

it('鉴权失败立刻停用搜索服务，不占用重试机会', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.equal(budget.claim(search), undefined)
  budget.result(search, [{ type: 'text', text: '401 Invalid API key' }], true, 'auth')
  assert.equal(budget.searches, 0)
  assert.equal(budget.available(search), false)
})

it('抓取参数错误同样退还抓取预算，不影响检索预算', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.equal(budget.claim('web_fetch'), undefined)
  assert.equal(budget.fetches, 1)
  budget.result('web_fetch', [{ type: 'text', text: 'URL 非法' }], true, 'argument')
  assert.equal(budget.fetches, 0)
  assert.equal(budget.searches, 0)
  assert.equal(budget.available('web_fetch'), true)
})

it('未声明失败类型的错误按服务失败处理：第一次允许重试，连续两次才停用', () => {
  const budget = new ResearchBudget()
  budget.startRequest()
  assert.equal(budget.claim(search), undefined)
  budget.result(search, [{ type: 'text', text: '连接被重置' }], true)
  assert.equal(budget.searches, 0)
  assert.equal(budget.available(search), true)
  assert.equal(budget.claim(search), undefined)
  budget.result(search, [{ type: 'text', text: '连接被重置' }], true)
  assert.equal(budget.available(search), false)
})
