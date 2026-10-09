import yaml from 'yaml'

// 网页字段通过 YAML 序列化写入，避免模型名、地址中的特殊字符被当作配置语法。
export function renderModelTemplate(template: string, env: NodeJS.ProcessEnv): string {
  const settings = yaml.parse(template)
  const provider = settings['llm-pi-ai']?.providers?.tutor
  if (!provider?.models?.length || !settings['agent-default-model']) throw new Error('缺少 tutor 模型配置')
  for (const key of ['TUTOR_LLM_BASE_URL', 'TUTOR_LLM_MODEL']) if (!env[key]) throw new Error(`缺少 ${key}`)
  provider.baseURL = env.TUTOR_LLM_BASE_URL!.replace(/\/+$/, '')
  provider.models[0].id = env.TUTOR_LLM_MODEL
  if (env.TUTOR_LLM_CONTEXT_WINDOW) {
    const size = Number(env.TUTOR_LLM_CONTEXT_WINDOW)
    if (!Number.isSafeInteger(size) || size < 1024 || size > 2_000_000) throw new Error('上下文长度必须是 1024–2000000 之间的整数')
    provider.models[0].contextWindow = size
  }
  settings['agent-default-model'].model = env.TUTOR_LLM_MODEL
  return renderModelSettings(yaml.stringify(settings), env)
}

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
