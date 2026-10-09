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
  assert.ok(!JSON.stringify(before).includes('environment-secret'))
  const config = store.save({ baseUrl: 'https://second.invalid/v1/', model: 'next-model', apiKey: 'replacement-secret', contextWindow: 32768, researchDeadlineMs: 600000 })
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
    { thinking: 'unknown' }, { thinking: ['on'] }, { thinking: 'off', model: 'other-model' }, { contextWindow: 0 }, { contextWindow: 1.5 },
    { researchDeadlineMs: 0 }, { researchDeadlineMs: 1_800_001 }, { researchDeadlineMs: '600000' },
  ]) assert.throws(() => store.save({ ...valid, ...invalid }))
  assert.equal(fs.readFileSync(store.file, 'utf8'), previous)
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
