import { planMapMismatch, planMapMismatchText } from '../core/plan.ts'
import type { KnowledgeMap, Plan } from '../core/schema.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'

// 教学流程入口的统一前置校验：地图增删节点后，旧计划会指向不存在的节点或漏掉新节点。
// 与其在内容审查/内容生成深处报错，不如在这里给出可执行的修复命令。
export function requirePlanMapConsistency(deps: FlowDeps, courseId: string, plan: Plan, map: KnowledgeMap): void {
  const mismatch = planMapMismatch(plan, map)
  if (!mismatch) return
  deps.io.err(`tutor: 教学计划与知识地图不一致（${planMapMismatchText(mismatch)}）。请先运行 npm run agent -- plan ${courseId} 重新生成计划。\n`)
  throw new FlowExit(1)
}
