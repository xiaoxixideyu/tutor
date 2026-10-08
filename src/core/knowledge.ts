import type { KnowledgeMap, KnowledgeMapResource, QuestionBank } from './schema.ts'
import { getDomain } from 'tldts'

// 注册域名只是来源独立性的保守代理：同站子域、不同页面和重定向别名不能充当两份证据。
// 数量门槛不能证明事实正确，仍须由教研给出交叉核对结论。
export function sourceDomains(resources: KnowledgeMapResource[], node: string): string[] {
  const domains = new Set<string>()
  for (const resource of resources) {
    if (resource.node !== node || !resource.url) continue
    try {
      const url = new URL(resource.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
      const domain = getDomain(url.hostname, { allowPrivateDomains: false })
      if (domain) domains.add(domain)
    } catch { /* 非法地址不能作为验证证据 */ }
  }
  return [...domains].sort()
}

export function enforceSourceVerification(map: KnowledgeMap): KnowledgeMap {
  const nodes = map.nodes.map((node) => ({ ...node,
    verified: node.verified === true && sourceDomains(map.resources ?? [], node.id).length >= 2,
  }))
  return { ...map, nodes, verified: nodes.length > 0 && nodes.every((node) => node.verified) }
}

export interface ResearchBatch {
  nodes: { id: string; title?: string; summary?: string; verified?: boolean }[]
  resources?: KnowledgeMapResource[]
}

// 一批重新教研后替换本批旧资料。旧的失效链接不能混入新证据并抬高验证状态。
export function mergeResearchBatch(map: KnowledgeMap, batch: ResearchBatch): KnowledgeMap {
  const updates = new Map(batch.nodes.map((node) => [node.id, node]))
  return enforceSourceVerification({ ...map,
    nodes: map.nodes.map((node) => {
      const update = updates.get(node.id)
      return update ? { ...node, ...update, title: update.title ?? node.title,
        summary: update.summary ?? node.summary, verified: update.verified ?? false } : node
    }),
    resources: [...(map.resources ?? []).filter((r) => !updates.has(r.node)), ...(batch.resources ?? [])],
  })
}

export function topoOrder(map: KnowledgeMap): string[] {
  const ids = map.nodes.map((n) => n.id)
  const idSet = new Set(ids)
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]))
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const [node, prerequisite] of map.edges) {
    if (node === prerequisite || !idSet.has(node) || !idSet.has(prerequisite)) continue
    dependents.get(prerequisite)!.push(node)
    indegree.set(node, indegree.get(node)! + 1)
  }
  const result: string[] = []
  const remaining = new Set(ids)
  while (true) {
    const next = ids.find((id) => remaining.has(id) && indegree.get(id) === 0)
    if (next === undefined) break
    remaining.delete(next)
    result.push(next)
    for (const dependent of dependents.get(next)!) {
      indegree.set(dependent, indegree.get(dependent)! - 1)
    }
  }
  for (const id of ids) if (remaining.has(id)) result.push(id)
  return result
}

export function validateBank(bank: QuestionBank, nodeIds: string[]): string | null {
  for (const node of nodeIds) {
    const questions = bank[node]
    if (!questions || questions.length !== 3) return `知识点 ${node} 的题目数量不是 3`
    const difficulties = new Set(questions.map((q) => q.difficulty))
    if (difficulties.size !== 3) return `知识点 ${node} 的难度层级不完整（需覆盖 1/2/3）`
    for (const q of questions) {
      if (q.type === 'choice') {
        if ((q.choices?.length ?? 0) !== 4) return `题目 ${q.id} 的选项数不是 4`
        if (!/^[a-d]$/.test(q.answer.trim().toLowerCase())) return `题目 ${q.id} 的答案不是 A-D 字母`
      }
    }
  }
  return null
}
