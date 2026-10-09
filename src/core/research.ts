import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { contentKey, mapContent } from './content-quality.ts'
import { COURSE_ID_PATTERN } from './store.ts'
import type { KnowledgeMap, Profile } from './schema.ts'

// 完成教研与拥有两个独立来源是两件事。断点仅控制调度，不授予内容准入或 verified。
export class ResearchProgressStore {
  private readonly directory: string
  constructor(root: string, courseId: string) {
    if (!COURSE_ID_PATTERN.test(courseId)) throw new Error('非法课程 id')
    this.directory = path.join(path.resolve(root), courseId, 'research-progress')
  }
  private file(node: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(node)) throw new Error('非法知识点 id')
    return path.join(this.directory, `${node}.json`)
  }
  private key(map: KnowledgeMap, profile: Profile, node: string): string {
    if (!map.nodes.some(item => item.id === node)) throw new Error('知识点不存在')
    const input = mapContent(map, profile)
    input.units = [input.units[0], ...input.units.filter(unit => unit.id === `node:${node}`),
      ...(map.resources ?? []).filter(resource => resource.node === node)
        .map((resource, index) => ({ id: `resource:${index}`, node, content: resource }))]
    return contentKey(input)
  }
  completed(map: KnowledgeMap, profile: Profile, node: string): boolean {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(node), 'utf8'))
      return saved.version === 1 && saved.key === this.key(map, profile, node) && typeof saved.completedAt === 'string'
    } catch { return false }
  }
  status(map: KnowledgeMap, profile: Profile, node: string): 'pending' | 'saved' | 'verified' {
    const verified = map.nodes.find(item => item.id === node)?.verified === true
    if (this.completed(map, profile, node)) return verified ? 'verified' : 'saved'
    // 兼容没有逐点断点的旧已验证地图；有断点但内容失配或文件损坏时必须重新处理。
    return verified && !fs.existsSync(this.file(node)) ? 'verified' : 'pending'
  }
  save(map: KnowledgeMap, profile: Profile, node: string): void {
    const file = this.file(node)
    const value = { version: 1, key: this.key(map, profile, node), completedAt: new Date().toISOString() }
    fs.mkdirSync(this.directory, { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(tmp, file) }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
  }
}

export function pendingResearchNodes(map: KnowledgeMap, profile: Profile, progress: ResearchProgressStore): string[] {
  return map.nodes.filter(node => progress.status(map, profile, node.id) === 'pending').map(node => node.id)
}

type ResearchEvent = { type: 'start' | 'saved'; node: string; index: number; total: number }
  | { type: 'failed'; node: string; error: string }

// 工作单位与保存单位相同。某节点失败不撤销先前结果，连续失败时停止以免空耗。
export async function researchNodes(initial: KnowledgeMap, nodes: string[], options: {
  research: (map: KnowledgeMap, node: string) => Promise<KnowledgeMap>
  save: (map: KnowledgeMap, node: string) => void | Promise<void>
  report?: (event: ResearchEvent) => void
  permanentError?: (error: unknown) => boolean
}): Promise<{ map: KnowledgeMap; failed: string[]; stopped: boolean }> {
  let map = initial
  const failed: string[] = []
  let consecutiveFailures = 0
  for (const [index, node] of nodes.entries()) {
    options.report?.({ type: 'start', node, index: index + 1, total: nodes.length })
    let next: KnowledgeMap
    try { next = await options.research(map, node) }
    catch (error) {
      if ((error instanceof Error && error.name === 'AbortError') || options.permanentError?.(error)) throw error
      failed.push(node)
      options.report?.({ type: 'failed', node, error: error instanceof Error ? error.message : String(error) })
      if (++consecutiveFailures >= 2) return { map, failed, stopped: true }
      continue
    }
    // 落盘错误不吞掉，也不继续生成：未成功保存的结果不能当作进度。
    await options.save(next, node)
    map = next
    consecutiveFailures = 0
    options.report?.({ type: 'saved', node, index: index + 1, total: nodes.length })
  }
  return { map, failed, stopped: false }
}
