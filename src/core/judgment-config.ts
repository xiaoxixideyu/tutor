export type JudgmentProvider = 'llm' | 'typesafe'
export type JudgmentUrlMode = 'base' | 'endpoint'
export type JudgmentQuestionType = 'choice' | 'noul'

export interface JudgmentSettings {
  provider: JudgmentProvider
  baseUrl: string
  urlMode: JudgmentUrlMode
  questionType: JudgmentQuestionType
  model: string
  apiKey: string
  minimumConfidence: number
  timeoutMs: number
  requestsPerMinute: number
}

export class JudgmentConfigError extends Error {}

export const DEFAULT_JUDGMENT_SETTINGS: JudgmentSettings = {
  provider: 'llm',
  baseUrl: 'https://api.typesafe.ai/v1',
  urlMode: 'base',
  questionType: 'choice',
  model: 'jev-latest',
  apiKey: '',
  minimumConfidence: 0.95,
  timeoutMs: 5000,
  requestsPerMinute: 60,
}

export function judgmentBaseUrl(value: unknown, mode: JudgmentUrlMode = 'base'): string {
  if (!['base', 'endpoint'].includes(mode))
    throw new JudgmentConfigError('判断地址方式仅支持基础地址或完整请求地址')
  if (typeof value !== 'string' || !value.trim() || value.length > 2048)
    throw new JudgmentConfigError('请填写快速判断服务的基础地址')
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new JudgmentConfigError('判断服务地址必须是完整的 HTTP/HTTPS 地址')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new JudgmentConfigError('判断服务地址不能包含账号、密码或片段')
  if (mode === 'base' && url.search)
    throw new JudgmentConfigError('基础地址不能包含查询参数，请选择完整请求地址')
  if (
    [...url.searchParams.keys()].some((name) =>
      /key|token|secret|password|signature|authorization|^auth$/i.test(name),
    )
  )
    throw new JudgmentConfigError('地址中不能携带密钥，请使用独立的 API Key 字段')
  if (mode === 'base' && /\/(systemone|chat\/completions)\/?$/.test(url.pathname))
    throw new JudgmentConfigError('请填写判断服务的基础地址，不要包含 /systemone 或 /chat/completions')
  return mode === 'endpoint' ? url.toString() : url.toString().replace(/\/+$/, '')
}

export function judgmentRequestUrl(settings: JudgmentSettings): string {
  const address = judgmentBaseUrl(settings.baseUrl, settings.urlMode)
  return settings.urlMode === 'endpoint' ? address : address + '/systemone'
}

export function optionalModelName(value: unknown): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value.trim()))
    throw new JudgmentConfigError('核验模型名称不能包含空白或控制字符（最长 256 字符）')
  return value.trim()
}

export function validateJudgmentSettings(value: unknown, requireKey = false): JudgmentSettings {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
    throw new JudgmentConfigError('判断设置必须是一个对象')
  const raw = { ...DEFAULT_JUDGMENT_SETTINGS, ...(value as Partial<JudgmentSettings> | undefined) }
  if (!['llm', 'typesafe'].includes(raw.provider))
    throw new JudgmentConfigError('判断方式仅支持大模型或 TypeSafe')
  if (!['choice', 'noul'].includes(raw.questionType))
    throw new JudgmentConfigError('判断请求格式仅支持 Choice 或 Noul')
  const baseUrl = judgmentBaseUrl(raw.baseUrl, raw.urlMode)
  const model = optionalModelName(raw.model)
  if (!model) throw new JudgmentConfigError('请填写快速判断模型名称')
  if (
    typeof raw.apiKey !== 'string' ||
    raw.apiKey.length > 8192 ||
    /[\s\x00-\x1f\x7f]/.test(raw.apiKey.trim())
  )
    throw new JudgmentConfigError('快速判断服务 API Key 不合法')
  const apiKey = raw.apiKey.trim()
  if (requireKey && raw.provider === 'typesafe' && !apiKey)
    throw new JudgmentConfigError('启用 TypeSafe 时，请填写快速判断服务的 API Key')
  if (
    typeof raw.minimumConfidence !== 'number' ||
    !Number.isFinite(raw.minimumConfidence) ||
    raw.minimumConfidence < 0.5 ||
    raw.minimumConfidence > 1
  )
    throw new JudgmentConfigError('判断置信度阈值必须在 0.5–1 之间')
  if (!Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 500 || raw.timeoutMs > 60000)
    throw new JudgmentConfigError('快速判断等待上限必须在 500–60000 毫秒之间')
  if (
    !Number.isSafeInteger(raw.requestsPerMinute) ||
    raw.requestsPerMinute < 1 ||
    raw.requestsPerMinute > 600
  )
    throw new JudgmentConfigError('快速判断每分钟请求数必须在 1–600 之间')
  return {
    provider: raw.provider,
    baseUrl,
    urlMode: raw.urlMode,
    questionType: raw.questionType,
    model,
    apiKey,
    minimumConfidence: raw.minimumConfidence,
    timeoutMs: raw.timeoutMs,
    requestsPerMinute: raw.requestsPerMinute,
  }
}

export function judgmentSettingsFromEnvironment(env: NodeJS.ProcessEnv): JudgmentSettings {
  return validateJudgmentSettings({
    provider: env.TUTOR_JUDGMENT_PROVIDER ?? DEFAULT_JUDGMENT_SETTINGS.provider,
    baseUrl: env.TUTOR_JUDGMENT_BASE_URL || DEFAULT_JUDGMENT_SETTINGS.baseUrl,
    urlMode: env.TUTOR_JUDGMENT_URL_MODE || DEFAULT_JUDGMENT_SETTINGS.urlMode,
    questionType: env.TUTOR_JUDGMENT_QUESTION_TYPE || DEFAULT_JUDGMENT_SETTINGS.questionType,
    model: env.TUTOR_JUDGMENT_MODEL || DEFAULT_JUDGMENT_SETTINGS.model,
    apiKey: env.TUTOR_JUDGMENT_API_KEY ?? '',
    minimumConfidence: Number(
      env.TUTOR_JUDGMENT_MIN_CONFIDENCE || DEFAULT_JUDGMENT_SETTINGS.minimumConfidence,
    ),
    timeoutMs: Number(env.TUTOR_JUDGMENT_TIMEOUT_MS || DEFAULT_JUDGMENT_SETTINGS.timeoutMs),
    requestsPerMinute: Number(
      env.TUTOR_JUDGMENT_REQUESTS_PER_MINUTE || DEFAULT_JUDGMENT_SETTINGS.requestsPerMinute,
    ),
  })
}

export function judgmentEnvironment(settings: JudgmentSettings): NodeJS.ProcessEnv {
  return {
    TUTOR_JUDGMENT_PROVIDER: settings.provider,
    TUTOR_JUDGMENT_BASE_URL: settings.baseUrl,
    TUTOR_JUDGMENT_URL_MODE: settings.urlMode,
    TUTOR_JUDGMENT_QUESTION_TYPE: settings.questionType,
    TUTOR_JUDGMENT_MODEL: settings.model,
    TUTOR_JUDGMENT_API_KEY: settings.apiKey,
    TUTOR_JUDGMENT_MIN_CONFIDENCE: String(settings.minimumConfidence),
    TUTOR_JUDGMENT_TIMEOUT_MS: String(settings.timeoutMs),
    TUTOR_JUDGMENT_REQUESTS_PER_MINUTE: String(settings.requestsPerMinute),
  }
}
