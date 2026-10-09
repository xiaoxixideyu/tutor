import { it } from 'node:test'
import assert from 'node:assert/strict'
import yaml from 'yaml'
import fs from 'node:fs'
import { renderModelSettings, renderModelTemplate } from '../src/core/model-settings.ts'

it('推理模式仅在显式配置时改写，使用 DeepSeek thinking 协议并保留原路由和兼容字段', () => {
  const source = yaml.stringify({ 'llm-pi-ai': { providers: { tutor: { baseURL: 'https://example.invalid/v1', apiKeyEnv: 'TUTOR_LLM_API_KEY',
    compat: { supportsDeveloperRole: false }, models: [{ id: 'deepseek-fixture', contextWindow: 262144 }] } } } })
  assert.equal(renderModelSettings(source, {}), source)
  const profile = yaml.parse(renderModelSettings(source, { TUTOR_LLM_MODEL: 'deepseek-fixture', TUTOR_LLM_THINKING: 'off' }))['llm-pi-ai'].providers.tutor
  assert.equal(profile.reasoning, 'off')
  assert.equal(profile.compat.thinkingFormat, 'deepseek')
  assert.equal(profile.compat.supportsDeveloperRole, false)
  assert.equal(profile.baseURL, 'https://example.invalid/v1')
  assert.equal(profile.apiKeyEnv, 'TUTOR_LLM_API_KEY')
  assert.throws(() => renderModelSettings(source, { TUTOR_LLM_MODEL: 'other', TUTOR_LLM_THINKING: 'off' }), /DeepSeek/)
})

it('网页模型名及 URL 作为 YAML 值安全保存，密钥不写入运行时模板', () => {
  const template = fs.readFileSync(new URL('../config/settings.yaml', import.meta.url), 'utf8')
  const model = 'model:variant#revision'
  const source = renderModelTemplate(template, { TUTOR_LLM_BASE_URL: 'https://first.invalid/v1/', TUTOR_LLM_MODEL: model,
    TUTOR_LLM_CONTEXT_WINDOW: '32768', TUTOR_LLM_API_KEY: 'never-write-this-secret' })
  const parsed = yaml.parse(source)
  assert.equal(parsed['agent-default-model'].model, model)
  assert.equal(parsed['llm-pi-ai'].providers.tutor.models[0].contextWindow, 32768)
  assert.equal(parsed['llm-pi-ai'].providers.tutor.baseURL, 'https://first.invalid/v1')
  assert.ok(!source.includes('never-write-this-secret'))
})
