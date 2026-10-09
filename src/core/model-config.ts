import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type ThinkingMode = 'default' | 'on' | 'off'

interface ModelConfig {
  baseUrl: string
  model: string
  apiKey: string
  thinking: ThinkingMode
  contextWindow: number
  researchDeadlineMs: number
}

interface SavedModelConfig extends ModelConfig {
  version: 1
  updatedAt: string
}

export class ModelConfigError extends Error {}

// 与 CLI 共用 .env 的回退规则。只读已有文件，不把网页修改写回 .env。
export function readModelEnvironment(root: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited }
  const file = path.join(root, '.env')
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (match && !(match[1] in env)) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return env
}

function baseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new ModelConfigError('请填写模型服务的基础地址')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new ModelConfigError('服务地址必须是完整的 http:// 或 https:// 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ModelConfigError('服务地址仅支持 HTTP/HTTPS，不能包含账号、密码、查询参数或片段')
  }
  if (/\/chat\/completions\/?$/.test(url.pathname)) throw new ModelConfigError('请填写基础地址，不要包含 /chat/completions')
  return url.toString().replace(/\/+$/, '')
}

function validate(value: Record<string, unknown>): ModelConfig {
  const url = baseUrl(value.baseUrl)
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256 || /[\s\x00-\x1f\x7f]/.test(value.model.trim())) {
    throw new ModelConfigError('模型名称不能为空，且不能包含空白或控制字符（最长 256 字符）')
  }
  if (typeof value.apiKey !== 'string' || !value.apiKey.trim() || value.apiKey.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value.apiKey.trim())) {
    throw new ModelConfigError('请填写有效的 API Key')
  }
  const thinking = value.thinking ?? 'default'
  if (typeof thinking !== 'string' || !['default', 'on', 'off'].includes(thinking)) throw new ModelConfigError('推理设置必须为服务默认、开启或关闭')
  if (thinking !== 'default' && !value.model.trim().startsWith('deepseek-')) {
    throw new ModelConfigError('显式推理开关目前仅支持 deepseek-* 模型；其他模型请选择“服务默认”')
  }
  const contextWindow = value.contextWindow ?? 262144
  if (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 2_000_000) {
    throw new ModelConfigError('上下文长度必须是 1024–2000000 之间的整数')
  }
  const researchDeadlineMs = value.researchDeadlineMs ?? 480_000
  if (typeof researchDeadlineMs !== 'number' || !Number.isSafeInteger(researchDeadlineMs) || researchDeadlineMs < 60_000 || researchDeadlineMs > 1_800_000) {
    throw new ModelConfigError('教研回合时限必须是 1–30 分钟（60000–1800000 毫秒）')
  }
  return { baseUrl: url, model: value.model.trim(), apiKey: value.apiKey.trim(), thinking: thinking as ThinkingMode, contextWindow, researchDeadlineMs }
}

export class ModelConfigStore {
  readonly file: string
  private readonly defaults: ModelConfig
  private readonly env: NodeJS.ProcessEnv

  constructor(root: string, options: { file?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.env = readModelEnvironment(root, options.env)
    this.file = path.resolve(options.file ?? this.env.TUTOR_MODEL_CONFIG_FILE ?? path.join(root, 'data/model-config.json'))
    this.defaults = {
      baseUrl: (this.env.TUTOR_LLM_BASE_URL ?? '').replace(/\/+$/, ''),
      model: this.env.TUTOR_LLM_MODEL ?? '', apiKey: this.env.TUTOR_LLM_API_KEY ?? '',
      thinking: (this.env.TUTOR_LLM_THINKING || 'default') as ThinkingMode,
      contextWindow: Number(this.env.TUTOR_LLM_CONTEXT_WINDOW || 262144),
      researchDeadlineMs: Number(this.env.TUTOR_RESEARCH_DEADLINE_MS || this.env.TUTOR_LLM_DEADLINE_MS || 480_000),
    }
  }

  private read(): { config: ModelConfig; source: 'saved' | 'environment'; updatedAt: string | null } {
    let text: string
    try { text = fs.readFileSync(this.file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config: this.defaults, source: 'environment', updatedAt: null }
      throw new ModelConfigError('无法读取已保存的模型设置，请检查本机文件权限')
    }
    try {
      const saved = JSON.parse(text) as SavedModelConfig
      if (!saved || saved.version !== 1 || typeof saved.updatedAt !== 'string') throw new Error('invalid version')
      return { config: validate({ ...saved }), source: 'saved', updatedAt: saved.updatedAt }
    } catch {
      // JSON/YAML 解析错误可能带原文，不把含密钥的配置片段返回给页面。
      throw new ModelConfigError('已保存的模型设置损坏，未回退到其他渠道；请检查本机配置文件')
    }
  }

  publicConfig() {
    const { config, source, updatedAt } = this.read()
    return { baseUrl: config.baseUrl, model: config.model, thinking: config.thinking, contextWindow: config.contextWindow, researchDeadlineMs: config.researchDeadlineMs,
      apiKeySet: Boolean(config.apiKey), configured: Boolean(config.baseUrl && config.model && config.apiKey), source, updatedAt }
  }

  save(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ModelConfigError('模型设置必须是一个对象')
    const value = input as Record<string, unknown>
    if (value.apiKey !== undefined && typeof value.apiKey !== 'string') throw new ModelConfigError('API Key 必须是文本')
    const previous = this.read().config
    const nextUrl = baseUrl(value.baseUrl)
    const replacement = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
    let previousUrl = previous.baseUrl
    try { if (previousUrl) previousUrl = baseUrl(previousUrl) } catch { /* 旧环境地址可由网页修正 */ }
    if (!replacement && nextUrl !== previousUrl) throw new ModelConfigError('更换服务地址时，请填写新渠道的 API Key；不会沿用旧渠道的密钥')
    const config = validate({ ...value, baseUrl: nextUrl, apiKey: replacement || previous.apiKey,
      researchDeadlineMs: value.researchDeadlineMs ?? previous.researchDeadlineMs })
    const saved: SavedModelConfig = { version: 1, ...config, updatedAt: new Date().toISOString() }
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(temporary, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, this.file)
    } catch {
      throw new ModelConfigError('模型设置保存失败，原配置已保留；请检查本机文件权限')
    } finally {
      try { fs.unlinkSync(temporary) } catch { /* 已原子替换或未创建 */ }
    }
    return this.publicConfig()
  }

  // 每次启动流程重新读取；复制为子进程环境，后续保存不会改动正在运行的模型会话。
  environment(): NodeJS.ProcessEnv {
    const current = this.read().config
    if (!current.baseUrl || !current.model || !current.apiKey) throw new ModelConfigError('请先在“模型设置”中填写服务地址、模型名称和 API Key')
    const config = validate({ ...current })
    return { ...this.env, TUTOR_LLM_BASE_URL: config.baseUrl, TUTOR_LLM_MODEL: config.model,
      TUTOR_LLM_API_KEY: config.apiKey, TUTOR_LLM_THINKING: config.thinking === 'default' ? '' : config.thinking,
      TUTOR_LLM_CONTEXT_WINDOW: String(config.contextWindow), TUTOR_RESEARCH_DEADLINE_MS: String(config.researchDeadlineMs), TUTOR_MODEL_CONFIG_RESOLVED: '1' }
  }
}
