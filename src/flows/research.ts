import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { KnowledgeMapSchema, type KnowledgeMap, type Profile } from '../core/schema.ts'
import { assertKnowledgeMap, enforceSourceVerification, mergeResearchBatch, sourceDomains, topoOrder } from '../core/knowledge.ts'
import { permanentModelError } from '../runtime/chat.ts'
import { safeFetch } from '../runtime/url-safety.ts'
import { pendingResearchNodes, ResearchProgressStore, researchNodes } from '../core/research.ts'
import { parseJsonBlock, trySchema } from './generation.ts'
import { recordChatTotal } from './cost-ledger.ts'
import { mapContent } from '../core/content-quality.ts'
import { rejectSourceReason } from '../core/source-quality.ts'
import { createContentGate, generateApproved } from './content-gate.ts'
import { profileScope } from '../core/interview.ts'
import { capKnowledgeMap, mapNodeBudget, type MapBudget } from './map-budget.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'

interface BatchResult {
  nodes: { id: string; title?: string; summary?: string; verified?: boolean }[]
  resources?: { node: string; title: string; url?: string; note?: string; material?: string }[]
}

export function skeletonPrompt(profile: Profile, budget: MapBudget): string {
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
    '每节课必须围绕一个具体问题或任务：summary 写清「什么场景下遇到什么问题 → 这节课用什么手段解决」，不能只罗列概念或术语。',
    '一节课只保留解决该问题必需的概念；不要把教材同一章的名词打包成一节“核心概念/总览”课（学员明确要求先总览时除外）。',
    '节点顺序要体现问题递进：后一个节点最好由前一个节点解决后暴露的新问题/新限制自然引出；edges 用来表达这种依赖。',
    '首先遵守学员明确指定的课程范围、课时数量和排除项；不复教学员已会的基础，不为了凑节点数补入周边主题。',
    '在目标范围内，覆盖面宽的主题再拆成多个有依赖关系的细知识点；每节课内紧密相关的讲解要点保留在同一节点。',
    '反例：用一个"基础"节点囊括 环境/语法/控制流/函数/模块——应拆成各自独立、各一节课的知识点；同样不要把五六个角色/组件名词塞进一节名为“架构与核心概念”的课。',
    '',
    `节点数量由学习目标与课时决定，并控制在 ${budget.min}–${budget.max} 个之间（单次输出的体量上限，超出会被截断）：明确两节微课就输出两个节点，不把一节课的各个讲解要点拆成多节课。输出 JSON（\`\`\`json 代码块）：`,
    '{"nodes": [{"id": "英文slug", "title": "中文标题", "summary": "一句话（不超过 40 字，点出遇到的问题与解决手段，按你自身知识，之后会联网验证）", "verified": false}], "edges": [["知识点", "前置知识点"]]}',
    '除该 JSON 外不要输出其他内容：不要写解释、前言、推理过程或总结。',
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
    '- summary 保留课程骨架里的问题线索：先写这节课要解决的具体问题，再写核心机制/结论，不要改写成术语清单；只写有来源支撑的事实。若骨架只给了术语，就从节点标题和学员目的推断他实际会遇到的问题，再写手段',
    '- 两个来源冲突时在 resources[].note 注明分歧',
    '- 区分必要条件与常用做法，不把示例中的写法概括成“必须”；material 只摘录本课范围内需要的事实与例子，排除项不进入摘要',
    '- resources 只收直接支撑本知识点结论的资料：讲前置或后续课内容的资料不要挂到本知识点（整图复审判为越界会要求删改，浪费返工）',
    '- 来源只收正文可核对的原始/权威页面：官方文档、政府与教育机构网站、项目官方仓库、标准组织；官网首页、栏目导航页、登录页、搜索结果页，以及百科、问答、文库、博客平台、内容农场都会被程序剔除，不要提交；宁可不写 resources，也不要拿这类页面凑数',
    '- summary 只写学习内容，不写教研过程：不要出现“检索失败”“未取得资料”“待补证”“无法核实”这类说明；证据不足时按已有知识写范围，并保持 verified=false',
    '- 引用稳定的页面标题与链接，不写与知识内容无关的章节编号；版本相关结论必须写明版本，不能混用不同版本的编号或行为',
    '- 选型类课程以任务需求、实测质量、延迟、成本、数据与部署约束为主；未经本次来源核实的型号、价格、窗口长度、显存或许可数字不要写入，不凭记忆补全产品排行表',
    '- resources 最多 3 条；输出前逐字段自检长度（程序硬校验，超限会被拒绝并浪费重试预算）：summary 40–120 字（一句话讲清范围，写完删掉举例与修饰）、每条 material ≤180 字（最多 3 条事实、平均每条 ≤60 字，能短则短）、note 一句话 ≤120 字、title ≤120 字；缺少足够证据时提交现有资料并保持 verified=false',
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
      const { response, url: finalUrl } = await safeFetch(url, { signal: AbortSignal.timeout(10_000) })
      await response.body?.cancel()
      if (response.status >= 200 && response.status < 400) return finalUrl.toString()
      if (response.status >= 500) continue // 服务端错误可能是暂时性的，重试
      return null // 404 等客户端错误是确定性的，直接判死
    } catch {
      continue
    }
  }
  return null
}

export async function pruneResources(
  resources: { node: string; title: string; url?: string; note?: string; material?: string }[],
  out: (text: string) => void
): Promise<void> {
  // 先按来源类型剔除（零网络开销），再检查死链：搜索结果页、百科与博客平台不进入地图。
  for (let i = resources.length - 1; i >= 0; i--) {
    const resource = resources[i]
    if (!resource.url) continue
    const reason = rejectSourceReason(resource.url)
    if (!reason) continue
    out(`  ⚠ 来源不合格，已剔除：${resource.title}（${reason}）\n`)
    resources.splice(i, 1)
  }
  const withUrl = resources.filter((r) => r.url !== undefined)
  const verdicts = await Promise.all(withUrl.map((r) => checkUrl(r.url!)))
  for (let i = withUrl.length - 1; i >= 0; i--) {
    const resource = withUrl[i]
    if (verdicts[i]) { resource.url = verdicts[i]!; continue }
    out(`  ⚠ 来源暂无法访问，未计入本次资料：${resource.title}（${resource.url}）\n`)
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
  // 教研过程的失败说明不是教学内容：summary 会经备课提示词进入课堂，必须改写成学习范围。
  // 只匹配过程自述，"未取得许可"这类正常表述不受影响。
  const narration = /检索失败|搜索失败|联网失败|联网检索|未取得[^。；]{0,10}?(资料|来源|正文|证据)|待补证|待补充核实|待核实|无法核实|无法验证|资料不足|证据不足|暂不纳入/
  const narrated = batch.nodes.find((node) => narration.test(node.summary ?? ''))
  if (narrated) {
    const phrase = (narrated.summary ?? '').match(narration)?.[0] ?? ''
    return { ok: false, error: `summary 写了教研过程说明（“${phrase}”）：学员不需要知道资料是否查到。请改成只写这节课要解决的问题与做法，保持 verified=false 即可，不要解释检索情况。` }
  }
  // 长度违规一次报全（逐字段给当前字数与需删字数）：只报第一个会让模型只修一处、来回拉锯，
  // 而"每节点模型请求"预算有限，每次拉锯都在烧修复机会。
  const overages: string[] = []
  for (const item of [...batch.nodes, ...resources]) {
    for (const [field, limit] of Object.entries({ summary: 120, material: 180, note: 120, title: 120 })) {
      const value = (item as Record<string, unknown>)[field]
      if (typeof value !== 'string') continue
      const length = [...value].length
      if (length > limit) overages.push(`${'id' in item ? item.id : item.node} 的 ${field} 超限（当前 ${length} 字 / 上限 ${limit} 字，需再删约 ${length - limit} 字）`)
    }
  }
  if (overages.length > 0) {
    return { ok: false,
      error: `以下字段超过长度上限，必须压缩后重发：${overages.join('；')}。压缩策略：只保留最核心的事实，删去举例、修饰语、重复说明与次要限定；不要新增或扩写其他内容。保留必要限定条件，不机械截断、不扩大搜索，返回当前知识点完整 JSON。` }
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

export async function runResearch(deps: FlowDeps, config: { courseId: string; nodeId?: string }): Promise<void> {
  const { store, io } = deps
  if (!store.exists(config.courseId)) {
    io.err(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    io.closeInput()
    throw new FlowExit(1)
  }
  if (!store.has(config.courseId, 'profile')) {
    io.err(`tutor: 课程 "${config.courseId}" 缺少课程档案\n`)
    io.closeInput()
    throw new FlowExit(1)
  }
  const profile = store.read(config.courseId, 'profile') as Profile
  const gate = createContentGate(deps, config.courseId)
  const progress = new ResearchProgressStore(store.root, config.courseId)
  // 骨架无须联网；每个知识点另建会话，避免累积整门课的抓取正文。
  const chat = await deps.createChat({ tools: 'none', retryOnLength: false })

  let map: KnowledgeMap
  const budget = mapNodeBudget(profile)
  if (store.has(config.courseId, 'knowledge-map')) {
    map = enforceSourceVerification(store.read(config.courseId, 'knowledge-map') as KnowledgeMap)
    io.out(`已有知识地图（${map.nodes.length} 个知识点），继续教研。\n`)
  } else {
    io.out('正在构思知识地图骨架…\n')
    map = await generateApproved<KnowledgeMap>(chat, skeletonPrompt(profile, budget), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      const schemaResult = trySchema(KnowledgeMapSchema, data.value)
      if (!schemaResult.ok) return schemaResult
      // 骨架必须自洽：依赖与资料指向存在的知识点、依赖不成环。
      const capped = capKnowledgeMap(schemaResult.value as KnowledgeMap, budget)
      if (capped.truncated > 0) io.out(`知识地图超出体量上限（${budget.max} 个知识点），已保留前 ${budget.max} 个。\n`)
      try {
        assertKnowledgeMap(capped.map)
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true as const, value: capped.map }
    }, gate, value => mapContent(value, profile), { out: io.out })
    map.researched_at = deps.today()
    store.write(config.courseId, 'knowledge-map', map)
    io.out(`骨架完成：${map.nodes.length} 个知识点。\n`)
  }

  // verified 只代表来源数量；旧地图仍需独立内容审查。修复通过前保留原文件。
  const previousReview = await gate.review(mapContent(map, profile))
  if (!previousReview.approved) {
    if (config.nodeId || map.nodes.some(node => progress.status(map, profile, node.id) !== 'pending')) {
      throw new Error(`已有课程地图未通过审查；单点恢复或已有教研进度时不自动重写整张地图，原有节点与资料已保留。请先核查并修复具体问题。记录：${previousReview.evidenceFile}`)
    }
    map = await generateApproved<KnowledgeMap>(chat, [skeletonPrompt(profile, budget),
      '修复已有地图，保留仍在课程范围内的节点 id；返回完整地图并修正摘要与资料。',
      JSON.stringify(map), `独立审查发现：${previousReview.issues.join('\n')}`].join('\n'), text => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      const schemaResult = trySchema(KnowledgeMapSchema, data.value)
      if (!schemaResult.ok) return schemaResult
      const capped = capKnowledgeMap(schemaResult.value as KnowledgeMap, budget)
      try {
        assertKnowledgeMap(capped.map)
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true as const, value: capped.map }
    }, gate, value => mapContent(value, profile), { out: io.out })
    store.write(config.courseId, 'knowledge-map', map)
  }

  if (config.nodeId && !map.nodes.some(node => node.id === config.nodeId)) throw new Error('所选知识点不在本课程知识地图中')
  const pending = config.nodeId ? [config.nodeId] : pendingResearchNodes(map, profile, progress)
  if (pending.length === 0) {
    const unverified = map.nodes.filter(node => !node.verified).length
    const sourced = new Set((map.resources ?? []).map(resource => resource.node))
    const empty = map.nodes.filter(node => !sourced.has(node.id)).length
    io.out(unverified
      ? `全部知识点均已完成资料检查；其中 ${unverified} 个仍待来源交叉验证${empty ? `，${empty} 个未取得任何来源（可单点补查）` : ''}。\n`
      : '全部知识点均已联网验证。\n')
    await chat.flush()
    io.closeInput()
    throw new FlowExit(0)
  }

  const order = topoOrder(map)
  const queue = order.filter((id) => pending.includes(id))
  if (!config.nodeId && queue.length < map.nodes.length) io.out(`保留并跳过 ${map.nodes.length - queue.length} 个已有教研结果。\n`)
  io.out(`待教研 ${queue.length} 个知识点，逐个执行、逐个保存；每个知识点使用独立会话。\n`)
  const result = await researchNodes(map, queue, {
    research: async (current, id) => {
      const node = current.nodes.find(node => node.id === id)!
      // 推理模型的 max_tokens 包含推理用量；正文长度由 validateBatch 独立约束。
      const nodeChat = await deps.createChat({ tools: 'research', maxTokens: 8192, retryOnLength: false,
        onProgress: message => io.out(`  ${message}\n`) })
      try {
        return await generateApproved<KnowledgeMap>(nodeChat, nodePrompt(profile, node), async (text) => {
          const data = parseJsonBlock(text)
          if (!data.ok) return data
          const validated = validateBatch(data.value, new Set([id]))
          if (!validated.ok) return validated
          const batch = validated.value as BatchResult
          if (batch.resources?.length) await pruneResources(batch.resources, io.out)
          // 教研补充摘要和资料，课程标题由已有骨架决定；无需为同义改写重跑模型。
          return { ok: true, value: { ...mergeResearchBatch(current, batch, { preserveTitles: true }), researched_at: deps.today() } }
        }, gate, value => mapContent(value, profile), {
          reviewLimitRepair: '本知识点资料太长，独立审查达到预算。请只保留原课程要求的核心事实，summary 缩至 100 字以内，每条 material 缩至 150 字以内，note 一句话；去掉无关的章节编号和冗长方法清单。保留已取得的真实来源链接，不新增搜索，不扩大课程，不改变节点 id。返回原结构的完整 JSON，仍须接受完整内容审查。',
          out: io.out,
        })
      } finally { await nodeChat.flush(); recordChatTotal(deps.costs, nodeChat, 'research-node') }
    },
    save: (next, node) => {
      store.write(config.courseId, 'knowledge-map', next); map = next
      // 只在已通过准入并成功写入地图后记录调度断点。
      progress.save(next, profile, node)
    },
    permanentError: permanentModelError,
    report: event => {
      const completed = map.nodes.length - pendingResearchNodes(map, profile, progress).length
      deps.status({ phase: event.type === 'saved' ? 'saved' : 'node', node: event.node,
        title: map.nodes.find(node => node.id === event.node)?.title, completed, total: map.nodes.length,
        message: event.type === 'start' ? '正在教研当前知识点。' : event.type === 'saved' ? '当前知识点已通过审查并保存，继续下一点。' : '当前知识点尚未完成，已保存进度保留。' })
      if (event.type === 'start') io.out(`\n第 ${event.index}/${event.total} 个知识点教研中（${event.node}）…\n`)
      else if (event.type === 'failed') io.out(`  ${event.node} 未完成：${event.error}。已保存的知识点保留。\n`)
      else {
        const verified = map.nodes.find(node => node.id === event.node)?.verified
        const domains = sourceDomains(map.resources ?? [], event.node).length
        io.out(`  ${event.node} 已保存：${verified ? '来源已验证' : domains > 0 ? `来源待交叉验证（${domains} 个独立域名，需 ≥2）` : '本次未取得可用来源，可稍后单点补查'}。\n`)
      }
    },
  })
  map = result.map
  if (result.failed.length) throw new Error(`${result.stopped ? '连续两个知识点未完成，已停止本次教研以避免重复消耗。' : ''}未完成：${result.failed.join('、')}；已保存进度可继续。`)

  const verifiedTotal = map.nodes.filter((n) => n.verified).length
  const remaining = pendingResearchNodes(map, profile, progress).length
  const done = map.nodes.length - remaining
  const sourced = new Set((map.resources ?? []).map(resource => resource.node))
  const savedOnly = map.nodes.filter(node => sourced.has(node.id) && !node.verified).length
  const empty = map.nodes.filter(node => !sourced.has(node.id)).length
  io.out(`\n本次教研已保存：${done}/${map.nodes.length} 个知识点完成资料检查——${verifiedTotal} 个已联网验证、${savedOnly} 个有来源但未通过交叉验证、${empty} 个未取得来源；来源 ${map.resources?.length ?? 0} 条；尚待教研 ${remaining} 个。\n`)
  await chat.flush()
  recordChatTotal(deps.costs, chat, 'research-skeleton')
  io.closeInput()
  throw new FlowExit(0)
}
