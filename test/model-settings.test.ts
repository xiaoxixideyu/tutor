import { it } from 'node:test'
import assert from 'node:assert/strict'
import yaml from 'yaml'
import { renderModelSettings } from '../src/core/model-settings.ts'

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
