import { estimateCost, ratesForModel, type CostConfig, type UsageSample } from '../core/cost.ts'
import type { AgentChat } from '../runtime/chat.ts'

export interface CostEntry {
  model: string
  usage: UsageSample
  source: string
}

export interface CostSummary {
  inputTokens: number
  outputTokens: number
  cost: number
  byModel: { model: string; inputTokens: number; outputTokens: number; cost: number }[]
}

// 一次流程（一节课/一次考试/一次教研）的模型成本台账：所有 chat（含独立审查）都记到同一份。
export class CostLedger {
  readonly entries: CostEntry[] = []

  get size(): number {
    return this.entries.length
  }

  record(model: string, usage: UsageSample, source: string): void {
    if (!model || (usage.inputTokens <= 0 && usage.outputTokens <= 0)) return
    this.entries.push({ model, usage: { ...usage }, source })
  }

  summary(config: CostConfig): CostSummary {
    const byModel = new Map<string, { inputTokens: number; outputTokens: number; cost: number }>()
    let inputTokens = 0, outputTokens = 0, cost = 0
    for (const entry of this.entries) {
      const value = estimateCost(entry.usage, ratesForModel(config, entry.model))
      inputTokens += entry.usage.inputTokens
      outputTokens += entry.usage.outputTokens
      cost += value
      const current = byModel.get(entry.model) ?? { inputTokens: 0, outputTokens: 0, cost: 0 }
      current.inputTokens += entry.usage.inputTokens
      current.outputTokens += entry.usage.outputTokens
      current.cost += value
      byModel.set(entry.model, current)
    }
    return {
      inputTokens, outputTokens, cost: Math.round(cost * 10000) / 10000,
      byModel: [...byModel.entries()].map(([model, value]) => ({ model, ...value })),
    }
  }
}

type ChatUsage = Pick<AgentChat, 'model' | 'totalUsage'>

export function recordChatDelta(costs: CostLedger | undefined, chat: ChatUsage, before: UsageSample, source: string): void {
  if (!costs) return
  const after = chat.totalUsage()
  costs.record(chat.model, {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
  }, source)
}

export function recordChatTotal(costs: CostLedger | undefined, chat: ChatUsage, source: string): void {
  costs?.record(chat.model, chat.totalUsage(), source)
}

export async function withChatUsage<T>(costs: CostLedger | undefined, chat: ChatUsage, source: string, work: () => Promise<T>): Promise<T> {
  const before = chat.totalUsage()
  try { return await work() } finally { recordChatDelta(costs, chat, before, source) }
}
