import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { KnowledgeMapSchema, type KnowledgeMap, type Profile } from '../core/schema.ts'
import { topoOrder } from '../core/knowledge.ts'
import { createAgentChat, type AgentChat } from './agent-chat.ts'
import { generateTurn, parseJsonBlock, trySchema } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'

const name = 'tutor-research-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({ courseId: z.string().required(), batchSize: z.number().default(3) })

interface StoreView {
  root: string
  exists(id: string): boolean
  has(id: string, kind: string): boolean
  read(id: string, kind: string): unknown
  write(id: string, kind: string, data: unknown): void
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

interface BatchResult {
  nodes: { id: string; title?: string; summary?: string; verified?: boolean }[]
  resources?: { node: string; title: string; url?: string; note?: string; material?: string }[]
}

function skeletonPrompt(profile: Profile): string {
  return [
    '任务：为课程构思知识地图骨架（暂不联网）。',
    '',
    '学员档案：',
    `- 学习目的：${profile.goal}`,
    `- 现有基础：${profile.background || '未填写'}`,
    '',
    '输出 6-10 个知识点与依赖关系。输出 JSON（```json 代码块）：',
    '{"nodes": [{"id": "英文slug", "title": "中文标题", "summary": "一句话（按你自身知识，之后会联网验证）", "verified": false}], "edges": [["知识点", "前置知识点"]]}',
    '除该 JSON 外不要输出其他内容。',
  ].join('\n')
}

function batchPrompt(profile: Profile, batch: { id: string; title?: string; summary?: string }[], batchIndex: number, totalBatches: number): string {
  const lines = batch.map((n) => `- ${n.id}（${n.title ?? n.id}）${n.summary ? `：${n.summary}` : ''}`).join('\n')
  return [
    `任务：对下列知识点做联网教研与交叉验证（第 ${batchIndex + 1}/${totalBatches} 批）。`,
    '',
    '本批知识点：',
    lines,
    '',
    `学员目的：${profile.goal}；基础：${profile.background || '未填写'}`,
    '',
    '要求（克制搜索预算）：',
    '- 每个知识点最多 2 次搜索（mcp__searchix__ 工具，查询用英文，优先官方文档/一手资料）；必要时用 web_fetch 抓正文',
    '- 两个独立来源相互印证即视为已验证，不要过度搜索；本批完成立即输出，不要扩大范围',
    '- summary 只写有来源支撑的事实；两个来源冲突时在 resources[].note 注明分歧',
    '',
    '输出 JSON（```json 代码块，只含本批知识点）：',
    '{"nodes": [{"id": "…", "title": "…", "summary": "…", "verified": true 或 false}], "resources": [{"node": "…", "title": "…", "url": "https://…", "note": "推荐理由", "material": "正文摘要（可选 ≤300字）"}]}',
    '除该 JSON 外不要输出其他内容。',
  ].join('\n')
}

type ParseResult = { ok: true; value: unknown } | { ok: false; error: string }

function validateBatch(data: unknown, batchIds: Set<string>): ParseResult {
  const schemaResult = trySchema(BatchSchema, data)
  if (!schemaResult.ok) return schemaResult
  const batch = schemaResult.value as BatchResult
  const unknown = batch.nodes.find((n) => !batchIds.has(n.id))
  if (unknown) return { ok: false, error: `返回了不属于本批的知识点 "${unknown.id}"` }
  const missing = [...batchIds].filter((id) => !batch.nodes.some((n) => n.id === id))
  if (missing.length > 0) return { ok: false, error: `缺少本批知识点：${missing.join('、')}` }
  const resources = batch.resources ?? []
  const orphan = resources.find((r) => !batchIds.has(r.node))
  if (orphan) return { ok: false, error: `resources 中的知识点 "${orphan.node}" 不在本批里` }
  const invalidUrl = resources.find((r) => r.url && !/^https?:\/\//.test(r.url))
  if (invalidUrl) return { ok: false, error: `资源 "${invalidUrl.title}" 的 URL 非法` }
  return schemaResult
}

const BatchSchema = z.object({
  nodes: z
    .array(z.object({ id: z.string().required(), title: z.string(), summary: z.string(), verified: z.boolean() }))
    .required(),
  resources: z
    .array(
      z.object({
        node: z.string().required(),
        title: z.string().required(),
        url: z.string(),
        note: z.string(),
        material: z.string(),
      })
    )
    .default([]),
}) as unknown as Schema<unknown, BatchResult>

function mergeBatch(map: KnowledgeMap, batch: BatchResult): void {
  for (const node of batch.nodes) {
    const existing = map.nodes.find((n) => n.id === node.id)
    if (existing) {
      if (node.title !== undefined) existing.title = node.title
      if (node.summary !== undefined) existing.summary = node.summary
      existing.verified = node.verified ?? false
    } else {
      map.nodes.push({ id: node.id, title: node.title ?? node.id, summary: node.summary, verified: node.verified ?? false })
    }
  }
  const resources = map.resources ?? (map.resources = [])
  for (const resource of batch.resources ?? []) {
    resources.push(resource)
  }
}

async function run(ctx: Context, config: { courseId: string; batchSize: number }): Promise<void> {
  const courseState = ctx.get('courseState') as { store: StoreView } | undefined
  if (!courseState) throw new Error('tutor: 核心服务未就绪')
  const store = courseState.store
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  const out = process.stdout
  if (!store.exists(config.courseId)) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    exit(1)
    return
  }
  if (!store.has(config.courseId, 'profile')) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 缺少课程档案\n`)
    exit(1)
    return
  }
  const profile = store.read(config.courseId, 'profile') as Profile
  const chat = await createAgentChat(ctx)
  if (!chat) throw new Error('tutor: 模型会话创建失败')

  let map: KnowledgeMap
  if (store.has(config.courseId, 'knowledge-map')) {
    map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
    out.write(`已有知识地图（${map.nodes.length} 个知识点），继续教研。\n`)
  } else {
    out.write('正在构思知识地图骨架…\n')
    map = (await generateTurn(chat, skeletonPrompt(profile), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      return trySchema(KnowledgeMapSchema, data.value)
    })) as KnowledgeMap
    map.researched_at = today()
    store.write(config.courseId, 'knowledge-map', map)
    out.write(`骨架完成：${map.nodes.length} 个知识点。\n`)
  }

  const pending = map.nodes.filter((n) => n.verified !== true)
  if (pending.length === 0) {
    out.write('全部知识点均已联网验证。\n')
    await chat.flush()
    exit(0)
    return
  }

  const order = topoOrder(map)
  const queue = order.filter((id) => pending.some((n) => n.id === id))
  const batches: { id: string; title?: string; summary?: string }[][] = []
  for (let i = 0; i < queue.length; i += config.batchSize) {
    const ids = queue.slice(i, i + config.batchSize)
    batches.push(ids.map((id) => map.nodes.find((n) => n.id === id)!))
  }
  out.write(`待教研 ${queue.length} 个知识点，分 ${batches.length} 批（每批 ${config.batchSize} 个）。\n`)

  for (const [index, batch] of batches.entries()) {
    out.write(`\n第 ${index + 1}/${batches.length} 批教研中（${batch.map((n) => n.id).join('、')}）…\n`)
    const batchIds = new Set(batch.map((n) => n.id))
    const result = (await generateTurn(chat, batchPrompt(profile, batch, index, batches.length), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      return validateBatch(data.value, batchIds)
    })) as BatchResult
    mergeBatch(map, result)
    map.verified = map.nodes.every((n) => n.verified)
    map.researched_at = today()
    store.write(config.courseId, 'knowledge-map', map)
    const verified = result.nodes.filter((n) => batchIds.has(n.id) && n.verified).length
    out.write(`  已验证 ${verified}/${batch.length}，来源 +${result.resources?.length ?? 0}（进度已保存，可随时中断）\n`)
  }

  const verifiedTotal = map.nodes.filter((n) => n.verified).length
  out.write(`\n教研完成：${verifiedTotal}/${map.nodes.length} 个知识点已联网验证，来源 ${map.resources?.length ?? 0} 条。\n`)
  await chat.flush()
  printSessionTotal(chat, out)
  exit(0)
}

export function apply(ctx: Context, config: { courseId: string; batchSize: number }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-research-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}

export { name, inject, Config }
