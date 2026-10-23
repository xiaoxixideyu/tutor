import { parse } from 'yaml'

export interface UsageSample {
  // 总输入，包含缓存读取与写入；成本配置暂按同一输入单价估算。
  inputTokens: number
  outputTokens: number
}

export interface ReportedUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

// Harness 的输入计数互不重叠：inputTokens 仅为未缓存部分。
export function normalizeUsage(usage: ReportedUsage | undefined): UsageSample | null {
  if (!usage || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return null
  const counts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
  if (counts.some(count => !Number.isFinite(count) || count < 0)) return null
  return { inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), outputTokens: usage.outputTokens }
}

export interface CostRates {
  input: number
  output: number
}

export interface CostConfig {
  currency: string
  defaultRates: CostRates
  modelRates: Record<string, CostRates>
}

export const DEFAULT_COST_CONFIG: CostConfig = {
  currency: '¥',
  defaultRates: { input: 2, output: 8 },
  modelRates: {},
}

export function loadCostConfig(text: string | undefined): CostConfig {
  if (!text || !text.trim()) return { ...DEFAULT_COST_CONFIG }
  try {
    const raw = parse(text) as Record<string, unknown> | null
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_COST_CONFIG }
    const rates = (raw.rates ?? {}) as Record<string, unknown>
    const defaultRates = readRates(rates.default) ?? DEFAULT_COST_CONFIG.defaultRates
    const modelRates: Record<string, CostRates> = {}
    for (const [model, value] of Object.entries(rates)) {
      if (model === 'default') continue
      const parsed = readRates(value)
      if (parsed) modelRates[model] = parsed
    }
    return {
      currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : DEFAULT_COST_CONFIG.currency,
      defaultRates,
      modelRates,
    }
  } catch {
    return { ...DEFAULT_COST_CONFIG }
  }
}

function readRates(value: unknown): CostRates | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.input !== 'number' || typeof record.output !== 'number') return null
  return { input: record.input, output: record.output }
}

export function ratesForModel(config: CostConfig, model: string): CostRates {
  return config.modelRates[model] ?? config.defaultRates
}

export function addUsage(a: UsageSample, b: UsageSample): UsageSample {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

export function estimateCost(usage: UsageSample, rates: CostRates): number {
  const cost = (usage.inputTokens / 1_000_000) * rates.input + (usage.outputTokens / 1_000_000) * rates.output
  return Math.round(cost * 10000) / 10000
}
