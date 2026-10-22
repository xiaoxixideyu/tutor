import type { KnowledgeMap, Profile } from '../core/schema.ts'

// 知识地图一次生成的体量上限。
// 推理型模型在"数量不定"的提示下会把单次输出预算全部烧在推理上、正文为空
// （实测 minimax-m3.1-flash：无上限时 8192 输出里 8192 全是 reasoning，正文 0 字符；
//  18–24 节点直接触发网关超时；28–36 节点用掉 86% 预算只剩 13% 余量）。
// 因此地图的节点数必须显式设上限——它同时也决定了后续教研与出题的体量上限。
export const MAX_MAP_NODES = 12
export const MIN_MAP_NODES = 4

export interface MapBudget { min: number; max: number }

// 每日投入越少，知识点粒度要越粗、总量越少；上限固定在 12，保证教研与出题链路能在时限内交付。
export function mapNodeBudget(profile: Profile): MapBudget {
  const minutes = Number.isFinite(profile.daily_minutes) ? Number(profile.daily_minutes) : 60
  const max = Math.min(MAX_MAP_NODES, Math.max(MIN_MAP_NODES + 2, Math.round(minutes / 5)))
  const min = Math.max(MIN_MAP_NODES, Math.round(max * 0.7))
  return { min, max }
}

// 超体量的地图按学习进阶顺序截断：保留前 max 个节点，并丢弃指向被截掉节点的依赖边。
// 截断发生在准入审查之前，审查与落盘看到的都是同一份最终地图。
export function capKnowledgeMap(map: KnowledgeMap, budget: MapBudget): { map: KnowledgeMap; truncated: number } {
  if (map.nodes.length <= budget.max) return { map, truncated: 0 }
  const kept = map.nodes.slice(0, budget.max)
  const keptIds = new Set(kept.map(node => node.id))
  const edges = map.edges.filter(([node, dependency]) => keptIds.has(node) && keptIds.has(dependency))
  return { map: { ...map, nodes: kept, edges }, truncated: map.nodes.length - kept.length }
}
