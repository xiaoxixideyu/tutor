import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { KnowledgeMapSchema, type KnowledgeMap, type Profile } from '../core/schema.ts'
import { enforceSourceVerification, mergeResearchBatch, sourceDomains, topoOrder } from '../core/knowledge.ts'
import { createAgentChat, permanentModelError } from './agent-chat.ts'
import { pendingResearchNodes, ResearchProgressStore, researchNodes } from '../core/research.ts'
import { parseJsonBlock, trySchema } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'
import { mapContent } from '../core/content-quality.ts'
import { createContentGate, generateApproved } from './content-gate.ts'
import { profileScope } from '../core/interview.ts'
import { researchStatus } from './research-status.ts'

const name = 'tutor-research-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({ courseId: z.string().required(), nodeId: z.string() })

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
  const minutes = profile.daily_minutes ?? 30
  return [
    '任务：为课程构思知识地图骨架（暂不联网）。',
    '',
    '学员档案：',
    `- 学习目的与原始范围：${profileScope(profile)}`,
    `- 现有基础：${profile.background || '未填写'}`,
    `- 每日投入：约 ${minutes} 分钟`,
    '',
    `知识点粒度（关键约束）：每个知识点必须是「一节课能讲完」的量——约 ${minutes} 分钟、3–5 个讲解要点。`,
    '首先遵守学员明确指定的课程范围、课时数量和排除项；不复教学员已会的基础，不为了凑节点数补入周边主题。',
    '在目标范围内，覆盖面宽的主题再拆成多个有依赖关系的细知识点；每节课内紧密相关的讲解要点保留在同一节点。',
    '反例：用一个"基础"节点囊括 环境/语法/控制流/函数/模块——应拆成各自独立、各一节课的知识点。',
    '',
    '节点数量由学习目标与课时决定，没有最低数量：明确两节微课就输出两个节点，不把一节课的各个讲解要点拆成多节课。输出 JSON（```json 代码块）：',
    '{"nodes": [{"id": "英文slug", "title": "中文标题", "summary": "一句话（按你自身知识，之后会联网验证）", "verified": false}], "edges": [["知识点", "前置知识点"]]}',
    '除该 JSON 外不要输出其他内容。',
  ].join('\n')
}

export function nodePrompt(profile: Profile, node: { id: string; title?: string; summary?: string }): string {
  const lines = `- ${node.id}（${node.title ?? node.id}）${node.summary ? `：${node.summary}` : ''}`
  return [
    '任务：只对下列一个知识点做联网教研与交叉验证，完成后立即给出结果。',
    '',
    '本次知识点：',
    lines,
    '',
    `学员目的与原始范围：${profileScope(profile)}；基础：${profile.background || '未填写'}`,
    '',
    '要求（克制搜索预算）：',
    '- 先用一轮工具调用提交 2 个互补的英文查询，优先官方文档/一手资料。通常完成 2 次搜索；服务不可用时最多增加 1 次替代搜索',
    '- 必要时最多抓取 2 个来源正文。只保留相关片段，不下载整站，不追读本地缓存，不继续扩大搜索',
    '- 两个独立来源相互印证才标 verified=true；系统要求至少两个不同注册域名（同站不同页面或子域不算两个来源）。不够则保留 verified=false，不要编造来源',
    '- summary 只写有来源支撑的事实；两个来源冲突时在 resources[].note 注明分歧',
    '- 区分必要条件与常用做法，不把示例中的写法概括成“必须”；material 只摘录本课范围内需要的事实与例子，排除项不进入摘要',
    '- 引用稳定的页面标题与链接，不写与知识内容无关的章节编号；版本相关结论必须写明版本，不能混用不同版本的编号或行为',
    '- 选型类课程以任务需求、实测质量、延迟、成本、数据与部署约束为主；未经本次来源核实的型号、价格、窗口长度、显存或许可数字不要写入，不凭记忆补全产品排行表',
    '- resources 最多 3 条；summary 是学习范围摘要，最多 120 字符。每条 material 只保留最多 3 个核心事实、180 字符以内，note 一句话且最多 120 字符，title 最多 120 字符；程序会校验长度，缺少足够证据时提交现有资料并保持 verified=false',
    '',
    '输出 JSON（```json 代码块，只含当前知识点，不更改标题或扩展课程）：',
    '{"nodes": [{"id": "…", "title": "…", "summary": "…", "verified": true 或 false}], "resources": [{"node": "…", "title": "…", "url": "https://…", "note": "推荐理由", "material": "正文摘要（可选 ≤180字符）"}]}',
    '除该 JSON 外不要输出其他内容。',
  ].join('\n')
}

type ParseResult = { ok: true; value: unknown } | { ok: false; error: string }

async function checkUrl(url: string): Promise<string | null> {
  // 网关/网络抖动会把有效来源误判为死链（实测 pkg.go.dev 被误杀），失败后间隔 1s 重试一次再判死
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000))
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) })
      await response.body?.cancel()
      if (response.status >= 200 && response.status < 400) return response.url
      if (response.status >= 500) continue // 服务端错误可能是暂时性的，重试
      return null // 404 等客户端错误是确定性的，直接判死
    } catch {
      continue
    }
  }
  return null
}

async function pruneDeadResources(
  resources: { node: string; title: string; url?: string; note?: string; material?: string }[],
  out: NodeJS.WriteStream
): Promise<void> {
  const withUrl = resources.filter((r) => r.url !== undefined)
  const verdicts = await Promise.all(withUrl.map((r) => checkUrl(r.url!)))
  for (let i = withUrl.length - 1; i >= 0; i--) {
    const resource = withUrl[i]
    if (verdicts[i]) { resource.url = verdicts[i]!; continue }
    out.write(`  ⚠ 来源暂无法访问，未计入本次资料：${resource.title}（${resource.url}）\n`)
    const index = resources.indexOf(resource)
    if (index >= 0) resources.splice(index, 1)
  }
}

export function validateBatch(data: unknown, batchIds: Set<string>): ParseResult {
  const schemaResult = trySchema(BatchSchema, data)
  if (!schemaResult.ok) return schemaResult
  const batch = schemaResult.value as BatchResult
  if (new Set(batch.nodes.map((n) => n.id)).size !== batch.nodes.length) return { ok: false, error: '本批知识点 id 重复' }
  const unknown = batch.nodes.find((n) => !batchIds.has(n.id))
  if (unknown) return { ok: false, error: `返回了不属于本批的知识点 "${unknown.id}"` }
  const missing = [...batchIds].filter((id) => !batch.nodes.some((n) => n.id === id))
  if (missing.length > 0) return { ok: false, error: `缺少本批知识点：${missing.join('、')}` }
  const resources = batch.resources ?? []
  if (resources.length > 3) return { ok: false, error: '一个知识点最多保留 3 条最相关来源' }
  const orphan = resources.find((r) => !batchIds.has(r.node))
  if (orphan) return { ok: false, error: `resources 中的知识点 "${orphan.node}" 不在本批里` }
  const invalidUrl = resources.find((r) => r.url && !/^https?:\/\//.test(r.url))
  if (invalidUrl) return { ok: false, error: `资源 "${invalidUrl.title}" 的 URL 非法` }
  for (const item of [...batch.nodes, ...resources]) {
    for (const [field, limit] of Object.entries({ summary: 120, material: 180, note: 120, title: 120 })) {
      const value = (item as Record<string, unknown>)[field]
      if (typeof value === 'string' && [...value].length > limit) return { ok: false,
        error: `${'id' in item ? item.id : item.node} 的 ${field} 超过 ${limit} 字符。只保留已取得来源支撑的核心事实，完整改写后返回当前知识点 JSON；保留必要限定条件，不机械截断、不扩大搜索。` }
    }
  }
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

async function run(ctx: Context, config: { courseId: string; nodeId?: string }): Promise<void> {
  const courseState = ctx.get('courseState') as { store: StoreView } | undefined
  if (!courseState) throw new Error('tutor: 核心服务未就绪')
  const store = courseState.store
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  const out = process.stdout
  if (!store.exists(config.courseId)) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    process.stdin.destroy()
  exit(1)
    return
  }
  if (!store.has(config.courseId, 'profile')) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 缺少课程档案\n`)
    process.stdin.destroy()
  exit(1)
    return
  }
  const profile = store.read(config.courseId, 'profile') as Profile
  const gate = createContentGate(ctx, store, config.courseId)
  const progress = new ResearchProgressStore(store.root, config.courseId)
  // 骨架无须联网；每个知识点另建会话，避免累积整门课的抓取正文。
  const chat = await createAgentChat(ctx, { tools: 'none' })
  if (!chat) throw new Error('tutor: 模型会话创建失败')

  let map: KnowledgeMap
  if (store.has(config.courseId, 'knowledge-map')) {
    map = enforceSourceVerification(store.read(config.courseId, 'knowledge-map') as KnowledgeMap)
    out.write(`已有知识地图（${map.nodes.length} 个知识点），继续教研。\n`)
  } else {
    out.write('正在构思知识地图骨架…\n')
    map = await generateApproved<KnowledgeMap>(chat, skeletonPrompt(profile), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      return trySchema(KnowledgeMapSchema, data.value)
    }, gate, value => mapContent(value, profile))
    map.researched_at = today()
    store.write(config.courseId, 'knowledge-map', map)
    out.write(`骨架完成：${map.nodes.length} 个知识点。\n`)
  }

  // verified 只代表来源数量；旧地图仍需独立内容审查。修复通过前保留原文件。
  const previousReview = await gate.review(mapContent(map, profile))
  if (!previousReview.approved) {
    if (config.nodeId || map.nodes.some(node => progress.status(map, profile, node.id) !== 'pending')) {
      throw new Error(`已有课程地图未通过审查；单点恢复或已有教研进度时不自动重写整张地图，原有节点与资料已保留。请先核查并修复具体问题。记录：${previousReview.evidenceFile}`)
    }
    map = await generateApproved<KnowledgeMap>(chat, [skeletonPrompt(profile),
      '修复已有地图，保留仍在课程范围内的节点 id；返回完整地图并修正摘要与资料。',
      JSON.stringify(map), `独立审查发现：${previousReview.issues.join('\n')}`].join('\n'), text => {
      const data = parseJsonBlock(text)
      return data.ok ? trySchema(KnowledgeMapSchema, data.value) : data
    }, gate, value => mapContent(value, profile))
    store.write(config.courseId, 'knowledge-map', map)
  }

  if (config.nodeId && !map.nodes.some(node => node.id === config.nodeId)) throw new Error('所选知识点不在本课程知识地图中')
  const pending = config.nodeId ? [config.nodeId] : pendingResearchNodes(map, profile, progress)
  if (pending.length === 0) {
    const unverified = map.nodes.filter(node => !node.verified).length
    out.write(unverified ? `全部知识点均已完成资料检查；其中 ${unverified} 个仍待来源交叉验证，可选择知识点单独补查。\n` : '全部知识点均已联网验证。\n')
    await chat.flush()
    process.stdin.destroy()
  exit(0)
    return
  }

  const order = topoOrder(map)
  const queue = order.filter((id) => pending.includes(id))
  if (!config.nodeId && queue.length < map.nodes.length) out.write(`保留并跳过 ${map.nodes.length - queue.length} 个已有教研结果。\n`)
  out.write(`待教研 ${queue.length} 个知识点，逐个执行、逐个保存；每个知识点使用独立会话。\n`)
  const result = await researchNodes(map, queue, {
    research: async (current, id) => {
      const node = current.nodes.find(node => node.id === id)!
      // 推理模型的 max_tokens 包含推理用量；正文长度由 validateBatch 独立约束。
      const nodeChat = await createAgentChat(ctx, { tools: 'research', maxTokens: 8192, retryOnLength: false,
        onProgress: message => out.write(`  ${message}\n`) })
      if (!nodeChat) throw new Error('无法创建本知识点的教研会话')
      try {
        return await generateApproved<KnowledgeMap>(nodeChat, nodePrompt(profile, node), async (text) => {
          const data = parseJsonBlock(text)
          if (!data.ok) return data
          const validated = validateBatch(data.value, new Set([id]))
          if (!validated.ok) return validated
          const batch = validated.value as BatchResult
          if (batch.resources?.length) await pruneDeadResources(batch.resources, out)
          // 教研补充摘要和资料，课程标题由已有骨架决定；无需为同义改写重跑模型。
          return { ok: true, value: { ...mergeResearchBatch(current, batch, { preserveTitles: true }), researched_at: today() } }
        }, gate, value => mapContent(value, profile), {
          reviewLimitRepair: '本知识点资料太长，独立审查达到预算。请只保留原课程要求的核心事实，summary 缩至 100 字以内，每条 material 缩至 150 字以内，note 一句话；去掉无关的章节编号和冗长方法清单。保留已取得的真实来源链接，不新增搜索，不扩大课程，不改变节点 id。返回原结构的完整 JSON，仍须接受完整内容审查。',
        })
      } finally { await nodeChat.flush(); printSessionTotal(nodeChat, out) }
    },
    save: (next, node) => {
      store.write(config.courseId, 'knowledge-map', next); map = next
      // 只在已通过准入并成功写入地图后记录调度断点。
      progress.save(next, profile, node)
    },
    permanentError: permanentModelError,
    report: event => {
      const completed = map.nodes.length - pendingResearchNodes(map, profile, progress).length
      researchStatus({ phase: event.type === 'saved' ? 'saved' : 'node', node: event.node,
        title: map.nodes.find(node => node.id === event.node)?.title, completed, total: map.nodes.length,
        message: event.type === 'start' ? '正在教研当前知识点。' : event.type === 'saved' ? '当前知识点已通过审查并保存，继续下一点。' : '当前知识点尚未完成，已保存进度保留。' })
      if (event.type === 'start') out.write(`\n第 ${event.index}/${event.total} 个知识点教研中（${event.node}）…\n`)
      else if (event.type === 'failed') out.write(`  ${event.node} 未完成：${event.error}。已保存的知识点保留。\n`)
      else {
        const verified = map.nodes.find(node => node.id === event.node)?.verified
        out.write(`  ${event.node} 已保存：${verified ? '来源已验证' : `来源待交叉验证（${sourceDomains(map.resources ?? [], event.node).length} 个独立域名）`}。\n`)
      }
    },
  })
  map = result.map
  if (result.failed.length) throw new Error(`${result.stopped ? '连续两个知识点未完成，已停止本次教研以避免重复消耗。' : ''}未完成：${result.failed.join('、')}；已保存进度可继续。`)

  const verifiedTotal = map.nodes.filter((n) => n.verified).length
  const remaining = pendingResearchNodes(map, profile, progress).length
  out.write(`\n本次教研已保存：${map.nodes.length - remaining}/${map.nodes.length} 个知识点已完成资料检查，${verifiedTotal} 个已联网验证，来源 ${map.resources?.length ?? 0} 条；尚待教研 ${remaining} 个。\n`)
  await chat.flush()
  printSessionTotal(chat, out)
  process.stdin.destroy()
  exit(0)
}

export function apply(ctx: Context, config: { courseId: string; nodeId?: string }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-research-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy()
  exit(1)
  })
}

export { name, inject, Config }
