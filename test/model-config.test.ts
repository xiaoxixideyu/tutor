import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelConfigStore } from '../src/core/model-config.ts'

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-model-config-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const envFile = path.join(root, '.env')
  const original = 'TUTOR_LLM_BASE_URL=https://first.invalid/v1\nTUTOR_LLM_MODEL=deepseek-fixture\nTUTOR_LLM_API_KEY=environment-secret\n'
  fs.writeFileSync(envFile, original)
  const store = new ModelConfigStore(root, { env: {} })
  return { root, envFile, original, store }
}

it('网页配置优先于启动环境，重建后仍有效；.env 不改动且密钥不回显', (t) => {
  const { root, envFile, original, store } = fixture(t)
  const before = store.publicConfig()
  assert.equal(before.source, 'environment')
  assert.equal(before.apiKeySet, true)
  assert.equal(before.requestsPerMinute, 8)
  assert.ok(!JSON.stringify(before).includes('environment-secret'))
  const config = store.save({ baseUrl: 'https://second.invalid/v1/', model: 'next-model', apiKey: 'replacement-secret', contextWindow: 32768, researchDeadlineMs: 600000, requestsPerMinute: 6 })
  assert.equal(config.source, 'saved')
  assert.equal(config.baseUrl, 'https://second.invalid/v1')
  assert.ok(!JSON.stringify(config).includes('replacement-secret'))
  assert.equal(fs.readFileSync(envFile, 'utf8'), original)
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600)
  const resumed = new ModelConfigStore(root, { env: { TUTOR_LLM_MODEL: 'stale-model', TUTOR_LLM_THINKING: 'on' } })
  const launch = resumed.environment()
  assert.equal(launch.TUTOR_LLM_MODEL, 'next-model')
  assert.equal(launch.TUTOR_LLM_API_KEY, 'replacement-secret')
  assert.equal(launch.TUTOR_LLM_THINKING, '')
  assert.equal(launch.TUTOR_LLM_CONTEXT_WINDOW, '32768')
  assert.equal(launch.TUTOR_RESEARCH_DEADLINE_MS, '600000')
  assert.equal(launch.TUTOR_MODEL_CONFIG_RESOLVED, '1')
  assert.equal(launch.TUTOR_LLM_REQUESTS_PER_MINUTE, '6')
  assert.equal(launch.TUTOR_MODEL_RATE_LIMIT_FILE, path.join(root, 'data/model-rate-limits.sqlite'))
  store.save({ baseUrl: config.baseUrl, model: config.model })
  assert.equal(store.publicConfig().requestsPerMinute, 6, '旧页面保存未提供限流字段时保留最新配额')
})

it('留空密钥只在同一基础地址沿用，切换渠道必须提供新密钥', (t) => {
  const { store } = fixture(t)
  store.save({ baseUrl: 'https://first.invalid/v1/', model: 'deepseek-second', apiKey: '' })
  assert.equal(store.environment().TUTOR_LLM_API_KEY, 'environment-secret')
  const previous = fs.readFileSync(store.file, 'utf8')
  for (const baseUrl of ['https://second.invalid/v1', 'https://first.invalid/another-account']) {
    assert.throws(() => store.save({ baseUrl, model: 'new-model', apiKey: '' }), /新渠道的 API Key/)
  }
  assert.equal(fs.readFileSync(store.file, 'utf8'), previous)
})

it('不合法的渠道、字段或推理设置不覆盖已保存配置', (t) => {
  const { store } = fixture(t)
  const valid = { baseUrl: 'https://first.invalid/v1', model: 'deepseek-fixture', apiKey: 'replacement-secret' }
  store.save(valid)
  const previous = fs.readFileSync(store.file, 'utf8')
  for (const invalid of [
    { baseUrl: 'file:///private/config' }, { baseUrl: 'https://user:password@first.invalid/v1' },
    { baseUrl: 'https://first.invalid/v1?api_key=hidden' }, { baseUrl: 'https://first.invalid/v1/chat/completions' },
    { model: 'model\nother: value' }, { model: 'bad\0model' }, { apiKey: 123 }, { apiKey: 'bad\nkey' }, { apiKey: 'bad\0key' },
    { thinking: 'unknown' }, { thinking: ['max'] }, { thinking: 'ultra' }, { contextWindow: 0 }, { contextWindow: 1.5 },
    { researchDeadlineMs: 0 }, { researchDeadlineMs: 1_800_001 }, { researchDeadlineMs: '600000' },
    { requestsPerMinute: 0 }, { requestsPerMinute: 601 }, { requestsPerMinute: 1.5 }, { requestsPerMinute: '8' },
  ]) assert.throws(() => store.save({ ...valid, ...invalid }))
  assert.equal(fs.readFileSync(store.file, 'utf8'), previous)
})

it('推理档位支持多档与通用模型，旧 on 兼容为 max；draft 不落盘', (t) => {
  const { store } = fixture(t)
  const base = { baseUrl: 'https://first.invalid/v1', apiKey: 'replacement-secret' }
  const high = store.save({ ...base, model: 'other-model', thinking: 'high' })
  assert.equal(high.thinking, 'high')
  const legacy = store.save({ ...base, model: 'other-model', thinking: 'on' })
  assert.equal(legacy.thinking, 'max')
  assert.equal(store.environment().TUTOR_LLM_THINKING, 'max')
  const before = fs.readFileSync(store.file, 'utf8')
  const draft = store.draft({ baseUrl: 'https://first.invalid/v1', model: 'other-model-2', apiKey: '', thinking: 'low' })
  assert.equal(draft.model, 'other-model-2')
  assert.equal(draft.thinking, 'low')
  assert.equal(fs.readFileSync(store.file, 'utf8'), before, 'draft 只校验表单，不应写入配置')
})

it('旧版已保存设置默认 8 次，独立 DSH_HOME 仍共用渠道队列', (t) => {
  const { root, store } = fixture(t)
  store.save({ baseUrl: 'https://first.invalid/v1', model: 'deepseek-fixture' })
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'))
  delete saved.requestsPerMinute
  fs.writeFileSync(store.file, JSON.stringify(saved))
  const first = new ModelConfigStore(root, { env: { DSH_HOME: path.join(root, 'one'), TUTOR_LLM_REQUESTS_PER_MINUTE: '99' } })
  const second = new ModelConfigStore(root, { env: { DSH_HOME: path.join(root, 'two') } })
  assert.equal(first.publicConfig().requestsPerMinute, 8)
  assert.equal(first.environment().TUTOR_MODEL_RATE_LIMIT_FILE, second.environment().TUTOR_MODEL_RATE_LIMIT_FILE)
  const custom = new ModelConfigStore(root, { env: { TUTOR_MODEL_RATE_LIMIT_FILE: path.join(root, 'shared.sqlite') } })
  assert.equal(custom.environment().TUTOR_MODEL_RATE_LIMIT_FILE, path.join(root, 'shared.sqlite'))
})

it('配置文件损坏时不泄漏片段，也不静默回退到别的渠道', (t) => {
  const { store } = fixture(t)
  fs.mkdirSync(path.dirname(store.file), { recursive: true })
  fs.writeFileSync(store.file, '{"apiKey":"must-stay-private",broken')
  assert.throws(() => store.publicConfig(), (error: unknown) => error instanceof Error && /损坏/.test(error.message) && !error.message.includes('must-stay-private'))
  assert.throws(() => store.environment(), /未回退/)
})

it('未配置模型时可读取空设置，但启动模型流程必须先完成设置', (t) => {
  const { root } = fixture(t)
  const empty = new ModelConfigStore(root, { env: { TUTOR_LLM_BASE_URL: '', TUTOR_LLM_MODEL: '', TUTOR_LLM_API_KEY: '' } })
  assert.equal(empty.publicConfig().configured, false)
  assert.throws(() => empty.environment(), /模型设置/)
  empty.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model:latest', apiKey: 'local-placeholder' })
  assert.equal(empty.environment().TUTOR_LLM_MODEL, 'local-model:latest')
})

it('教研搜索可在网页配置：环境回显、密钥掩码、换址必须新 Token、清空回退环境', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-model-config-search-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { TUTOR_MCP_SEARCH_URL: 'https://search.env.invalid/mcp', TUTOR_MCP_SEARCH_TOKEN: 'env-search-token' }
  const store = new ModelConfigStore(root, { env })
  // 无保存文件：直接回显环境里的搜索配置（网页可见 .env 已配置），但不回显 Token
  const fromEnv = store.publicConfig()
  assert.equal(fromEnv.searchMcpUrl, 'https://search.env.invalid/mcp')
  assert.equal(fromEnv.searchTokenSet, true)
  assert.equal(fromEnv.searchConfigured, true)
  assert.ok(!JSON.stringify(fromEnv).includes('env-search-token'))
  // 网页保存覆盖环境；地址尾部斜杠规范化
  const saved = store.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local', apiKey: 'local-key',
    searchMcpUrl: 'https://tavily.ivanli.cc/mcp/', searchToken: 'th-secret' })
  assert.equal(saved.searchMcpUrl, 'https://tavily.ivanli.cc/mcp')
  assert.equal(store.environment().TUTOR_MCP_SEARCH_URL, 'https://tavily.ivanli.cc/mcp')
  assert.equal(store.environment().TUTOR_MCP_SEARCH_TOKEN, 'th-secret')
  // 换址未给 Token：拒绝且原文件保留
  const previous = fs.readFileSync(store.file, 'utf8')
  assert.throws(() => store.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local', searchMcpUrl: 'https://other.invalid/mcp', searchToken: '' }), /搜索服务/)
  assert.equal(fs.readFileSync(store.file, 'utf8'), previous)
  // 同址留空 Token：沿用已保存 Token
  const kept = store.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local', searchMcpUrl: 'https://tavily.ivanli.cc/mcp', searchToken: '' })
  assert.equal(kept.searchTokenSet, true)
  // 清空网页搜索字段：回退环境变量里的搜索配置
  const cleared = store.save({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'local', searchMcpUrl: '', searchToken: '' })
  assert.equal(cleared.searchMcpUrl, 'https://search.env.invalid/mcp')
  assert.equal(store.environment().TUTOR_MCP_SEARCH_URL, 'https://search.env.invalid/mcp')
  assert.equal(store.environment().TUTOR_MCP_SEARCH_TOKEN, 'env-search-token')
})
