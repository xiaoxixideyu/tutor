import { parse } from 'yaml'

export interface UsageSample {
  inputTokens: number
  outputTokens: number
}

export interface CostRates {
  input: number
  output: number
}

export interface CostConfig {
  currency: string
  defaultRates: CostRates
  modelRates: Record<string, CostRates>
  warn: number
  alarm: number
}

export type CostColor = 'green' | 'yellow' | 'red'

export const DEFAULT_COST_CONFIG: CostConfig = {
  currency: '¥',
  defaultRates: { input: 2, output: 8 },
  modelRates: {},
  warn: 0.05,
  alarm: 0.2,
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
    const turnCost = (raw.turn_cost ?? {}) as Record<string, unknown>
    return {
      currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : DEFAULT_COST_CONFIG.currency,
      defaultRates,
      modelRates,
      warn: typeof turnCost.warn === 'number' ? turnCost.warn : DEFAULT_COST_CONFIG.warn,
      alarm: typeof turnCost.alarm === 'number' ? turnCost.alarm : DEFAULT_COST_CONFIG.alarm,
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

export function costColor(cost: number, config: CostConfig): CostColor {
  if (cost >= config.alarm) return 'red'
  if (cost >= config.warn) return 'yellow'
  return 'green'
}

const COLORS: Record<CostColor, string> = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
}
const RESET = '\x1b[0m'

function colorize(text: string, color: CostColor, enabled: boolean): string {
  return enabled ? `${COLORS[color]}${text}${RESET}` : text
}

function formatTokens(count: number): string {
  if (count >= 10000) return `${Math.round(count / 100) / 10}k`
  return String(count)
}

function usageLine(usage: UsageSample, config: CostConfig, model: string, colorEnabled: boolean): string {
  const rates = ratesForModel(config, model)
  const cost = estimateCost(usage, rates)
  const text = `${config.currency}${cost.toFixed(4)}（输入 ${formatTokens(usage.inputTokens)} · 输出 ${formatTokens(usage.outputTokens)}）`
  return colorize(text, costColor(cost, config), colorEnabled)
}

export function formatTurnCost(usage: UsageSample, model: string, config: CostConfig, colorEnabled: boolean): string {
  return `本回合 ${usageLine(usage, config, model, colorEnabled)}`
}

export function formatTotalCost(usage: UsageSample, model: string, config: CostConfig, colorEnabled: boolean, turns?: number): string {
  const turnNote = turns !== undefined ? `（${turns} 回合）` : ''
  return `会话累计${turnNote} ${usageLine(usage, config, model, colorEnabled)}`
}
