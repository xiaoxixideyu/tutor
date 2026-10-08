import yaml from 'yaml'

// 可显式比较网关的推理模式；缺省保留已有配置，不把“省略参数”误称为关闭推理。
export function renderModelSettings(rendered: string, env: NodeJS.ProcessEnv): string {
  const thinking = env.TUTOR_LLM_THINKING
  if (!thinking) return rendered
  if (!['on', 'off'].includes(thinking)) throw new Error('TUTOR_LLM_THINKING 必须是 on 或 off')
  if (!env.TUTOR_LLM_MODEL?.startsWith('deepseek-')) throw new Error('显式 thinking 配置目前仅验证 DeepSeek 接口')
  const settings = yaml.parse(rendered)
  const provider = settings['llm-pi-ai']?.providers?.tutor
  if (!provider?.models?.length) throw new Error('缺少 tutor 模型配置')
  provider.compat = { ...provider.compat, thinkingFormat: 'deepseek', supportsReasoningEffort: false }
  provider.reasoning = thinking === 'off' ? 'off' : 'high'
  for (const model of provider.models) model.reasoningEfforts = { off: 'off', high: 'high' }
  return yaml.stringify(settings)
}
