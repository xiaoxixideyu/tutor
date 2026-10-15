import fs from 'node:fs'
import path from 'node:path'
import { loadCostConfig, formatTotalCost, type CostConfig } from '../core/cost.ts'
import type { AgentChat } from '../runtime/chat.ts'
import type { FlowDeps } from './deps.ts'

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
