import type { KnowledgeMap, QuestionBank } from './schema.ts'

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
