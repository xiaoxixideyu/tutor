import fs from 'node:fs'
import path from 'node:path'
import { loadCostConfig, formatTotalCost, type CostConfig } from '../core/cost.ts'
import type { AgentChat } from '../runtime/chat.ts'
import type { FlowDeps } from './deps.ts'
import type { CostLedger } from './cost-ledger.ts'

function formatTokens(count: number): string {
  return count >= 10000 ? `${Math.round(count / 100) / 10}k` : String(count)
}

export function printCostLedger(deps: Pick<FlowDeps, 'io' | 'workspace' | 'costs'>): void {
  const ledger: CostLedger | undefined = deps.costs
  if (!ledger || ledger.size === 0) return
  const config = loadCostConfigFromRepo(deps.workspace)
  const summary = ledger.summary(config as CostConfig)
  const models = summary.byModel.map((item) => `${item.model} ${config.currency}${item.cost.toFixed(4)}`).join('，')
  deps.io.out(`\n本次流程总成本 ${config.currency}${summary.cost.toFixed(4)}（输入 ${formatTokens(summary.inputTokens)} · 输出 ${formatTokens(summary.outputTokens)}${models ? `；${models}` : ''}）\n`)
}

export function loadCostConfigFromRepo(workspace: string): CostConfig {
  try {
    const file = path.resolve(workspace, 'config', 'cost.yaml')
    return loadCostConfig(fs.readFileSync(file, 'utf8'))
  } catch {
    return loadCostConfig(undefined)
  }
}

export function printSessionTotal(chat: AgentChat, deps: Pick<FlowDeps, 'io' | 'workspace'>, turns?: number): void {
  const config = loadCostConfigFromRepo(deps.workspace)
  deps.io.out(`\n${formatTotalCost(chat.totalUsage(), chat.model, config, deps.io.tty, turns)}\n`)
}
