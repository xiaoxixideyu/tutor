import fs from 'node:fs'
import path from 'node:path'
import { loadCostConfig, formatTotalCost, type CostConfig } from '../core/cost.ts'
import type { AgentChat } from './agent-chat.ts'

export function loadCostConfigFromRepo(): CostConfig {
  try {
    const file = path.resolve(process.cwd(), 'config', 'cost.yaml')
    return loadCostConfig(fs.readFileSync(file, 'utf8'))
  } catch {
    return loadCostConfig(undefined)
  }
}

export function printSessionTotal(chat: AgentChat, out: NodeJS.WriteStream, turns?: number): void {
  const config = loadCostConfigFromRepo()
  const colorEnabled = out.isTTY === true
  out.write(`\n${formatTotalCost(chat.totalUsage(), chat.model, config, colorEnabled, turns)}\n`)
}
