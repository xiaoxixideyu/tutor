import { it } from 'node:test'
import assert from 'node:assert/strict'
import { argumentMismatches, classifyToolError, coerceArguments, searchHeaders } from '../src/runtime/tools.ts'

// 取自 Tavily 代理的实际工具 schema 形状：弱模型常把布尔/数字写成字符串。
const schema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    // 真实 schema：布尔与字符串枚举共用一个 oneOf 分支，没有顶层 type。
    include_answer: { default: false, oneOf: [{ type: 'boolean' }, { enum: ['basic', 'advanced'], type: 'string' }] },
    include_raw_content: { type: 'boolean' },
    max_results: { type: 'integer' },
    chunks_per_source: { type: 'integer' },
    include_domains: { type: 'array', items: { type: 'string' } },
    topic: { type: 'string', enum: ['general', 'news'] },
    answer_mode: { type: ['boolean', 'string'], enum: [true, false, 'basic'] },
    filter: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
}

it('把模型字符串化的布尔与数字按 schema 归一，数组字符串包成单元素数组', () => {
  const args = coerceArguments({
    query: 'Guangdong civil service',
    include_answer: 'false',
    include_raw_content: 'false',
    max_results: '5',
    chunks_per_source: '3',
    include_domains: 'gdzz.gov.cn',
    topic: 'general',
  }, schema)
  assert.deepEqual(args, {
    query: 'Guangdong civil service',
    include_answer: false,
    include_raw_content: false,
    max_results: 5,
    chunks_per_source: 3,
    include_domains: ['gdzz.gov.cn'],
    topic: 'general',
  })
})

it('枚举值原样保留，嵌套对象与 JSON 字符串数组按 schema 归一', () => {
  const args = coerceArguments({ answer_mode: 'basic', include_answer: 'advanced', filter: '{"limit":"2"}', include_domains: '["a.gov.cn","b.gov.cn"]' }, schema)
  assert.equal(args.answer_mode, 'basic')
  // oneOf 的字符串分支同样不能被误转成布尔
  assert.equal(args.include_answer, 'advanced')
  assert.deepEqual(args.filter, { limit: 2 })
  assert.deepEqual(args.include_domains, ['a.gov.cn', 'b.gov.cn'])
})

it('未知字段与无 schema 时不做改写', () => {
  assert.deepEqual(coerceArguments({ extra: 'true' }, schema), { extra: 'true' })
  assert.deepEqual(coerceArguments({ include_answer: 'false' }, undefined), { include_answer: 'false' })
})

it('oneOf 分支：本来就正确的值不被改写，只有类型不符时才归一', () => {
  const numeric = { type: 'object', properties: { limit: { oneOf: [{ type: 'integer' }, { type: 'string' }] } } }
  // 数字 5 已满足 integer 分支，不能被第二个分支改成 "5"。
  assert.deepEqual(coerceArguments({ limit: 5 }, numeric), { limit: 5 })
  assert.deepEqual(coerceArguments({ limit: '5' }, numeric), { limit: '5' })
  const booleanFirst = { type: 'object', properties: { include_answer: { oneOf: [{ enum: ['basic', 'advanced'] }, { type: 'boolean' }] } } }
  assert.deepEqual(coerceArguments({ include_answer: 'false' }, booleanFirst), { include_answer: false })
  assert.deepEqual(coerceArguments({ include_answer: 'basic' }, booleanFirst), { include_answer: 'basic' })
})

it('归一之后仍不符合类型的字段给出可执行的修正提示', () => {
  const mismatches = argumentMismatches(coerceArguments({ max_results: 'many', chunks_per_source: '3.5' }, schema), schema)
  assert.equal(mismatches.length, 2)
  assert.match(mismatches[0], /max_results 需要 integer/)
  assert.match(mismatches[1], /chunks_per_source 需要 integer/)
  // oneOf 分支（include_answer）不做类型断言：枚举分支无法用单一 type 判定。
  assert.deepEqual(argumentMismatches({ include_answer: 'maybe' }, schema), [])
  // 归一成功的调用不应产生任何提示，否则会白白挡掉正常请求。
  assert.deepEqual(argumentMismatches(coerceArguments({ include_answer: 'false', max_results: '5' }, schema), schema), [])
})

it('区分参数错误与服务错误：参数错误可重试，服务错误才拉黑工具', () => {
  assert.equal(classifyToolError('{"detail":{"error":"Invalid value for include_answer. Must be True, False, \'basic\', or \'advanced\'."}}'), 'argument')
  assert.equal(classifyToolError('{"detail":[{"type":"missing","loc":["body","query"],"msg":"Field required"}]}'), 'argument')
  assert.equal(classifyToolError('503: no capacity'), 'service')
  assert.equal(classifyToolError('Streamable HTTP error: Error POSTing to endpoint'), 'service')
  assert.equal(classifyToolError('搜索服务调用失败：socket hang up'), 'service')
  // 密钥问题重试没有意义，单独归类
  assert.equal(classifyToolError("web_search_exa error (401): Invalid API key. Provide a valid key using 'Authorization: Bearer <key>'"), 'auth')
  assert.equal(classifyToolError('403 Forbidden'), 'auth')
})

it('Exa 用 x-api-key 认证，其他搜索服务只发 Bearer', () => {
  assert.deepEqual(searchHeaders('https://mcp.exa.ai/mcp', 'exa-key'), {
    authorization: 'Bearer exa-key', 'x-api-key': 'exa-key',
  })
  // Tavily 网关不认识 x-api-key，不要多发头
  assert.deepEqual(searchHeaders('https://tavily.ivanli.cc/mcp', 'th-token'), {
    authorization: 'Bearer th-token',
  })
  // 不是 Exa 的域名即使名字里带 exa 也不加头
  assert.deepEqual(searchHeaders('https://exa.example.com/mcp', 'k'), { authorization: 'Bearer k' })
})
