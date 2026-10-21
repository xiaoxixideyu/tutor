import type { KnowledgeMap, KnowledgeMapResource, QuestionBank } from './schema.ts'
import { getDomain } from 'tldts'
import { ruleAnswerIssue } from './rule-grading.ts'

// 地图的语义校验：结构合法还不够，节点/依赖/资料必须互相自洽。
// 空地图会得到"没有可教的课"；指向未知节点的依赖会让拓扑排序静默丢掉前置关系。
export function assertKnowledgeMap(map: KnowledgeMap): void {
  if (!Array.isArray(map.nodes) || map.nodes.length === 0) {
    throw new Error('知识地图至少需要一个知识点')
  }
  const ids = new Set<string>()
  for (const node of map.nodes) {
    if (ids.has(node.id)) throw new Error(`知识地图节点 id 重复："${node.id}"`)
    ids.add(node.id)
    if (!node.title || !node.title.trim()) throw new Error(`知识点 "${node.id}" 缺少标题`)
  }
  for (const [target, prerequisite] of map.edges ?? []) {
    if (target === prerequisite) throw new Error(`知识点 "${target}" 不能依赖自己`)
    if (!ids.has(target) || !ids.has(prerequisite)) {
      throw new Error(`依赖 "${target}" → "${prerequisite}" 引用了不存在的知识点`)
    }
  }
  for (const resource of map.resources ?? []) {
    if (!ids.has(resource.node)) {
      throw new Error(`资料 "${resource.title}" 挂在不存在的知识点 "${resource.node}" 上`)
    }
  }
  // 依赖成环会让拓扑排序退化成插入顺序，前置课可能排在依赖它的课之后。
  const state = new Map<string, 'visiting' | 'done'>()
  const prerequisites = new Map<string, string[]>()
  for (const [target, prerequisite] of map.edges ?? []) {
    prerequisites.set(target, [...(prerequisites.get(target) ?? []), prerequisite])
  }
  const visit = (node: string, trail: string[]): void => {
    const status = state.get(node)
    if (status === 'done') return
    if (status === 'visiting') {
      throw new Error(`知识地图存在循环依赖：${[...trail, node].join(' → ')}`)
    }
    state.set(node, 'visiting')
    for (const prerequisite of prerequisites.get(node) ?? []) visit(prerequisite, [...trail, node])
    state.set(node, 'done')
  }
  for (const node of ids) visit(node, [])
}

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
export function mergeResearchBatch(map: KnowledgeMap, batch: ResearchBatch, options: { preserveTitles?: boolean } = {}): KnowledgeMap {
  const updates = new Map(batch.nodes.map((node) => [node.id, node]))
  return enforceSourceVerification({ ...map,
    nodes: map.nodes.map((node) => {
      const update = updates.get(node.id)
      return update ? { ...node, ...update, title: options.preserveTitles ? node.title : update.title ?? node.title,
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
    if (new Set(questions.map((q) => q.id)).size !== questions.length) return `知识点 ${node} 的题目 id 重复`
    for (const q of questions) {
      if (q.type === 'choice') {
        if ((q.choices?.length ?? 0) !== 4) return `题目 ${q.id} 的选项数不是 4`
        if (!/^[a-d]$/.test(q.answer.trim().toLowerCase())) return `题目 ${q.id} 的答案不是 A-D 字母`
      }
      const formatIssue = ruleAnswerIssue(q)
      if (formatIssue) return `题目 ${q.id}：${formatIssue}`
    }
  }
  return null
}
