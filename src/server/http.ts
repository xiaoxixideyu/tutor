import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CourseStore, COURSE_ID_PATTERN } from '../core/store.ts'
import { handleRpcRequest, RPC_ERRORS, type RpcRequest } from '../core/rpc.ts'
import type { KnowledgeMap } from '../core/schema.ts'
import { ModelConfigStore } from '../core/model-config.ts'
import { FlowExit, createLineQueue, type FlowIO, type LineQueue } from '../flows/io.ts'
import { runFlowInProcess } from '../flows/run.ts'

export const FLOW_PROTOCOL_VERSION = 1
const RUNNERS = new Set(['new', 'assess', 'plan', 'research', 'learn', 'exam', 'practice-gen', 'practice', 'audit-content'])
const STOP_LINES: Record<string, string> = { learn: '/exit', exam: '', practice: 'q' }
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }

export interface FlowStart {
  kind: string
  courseId: string
  milestoneId: string
  nodeId: string
}

interface Flow extends FlowStart {
  flowId: string
  status: 'running' | 'stopping' | 'completed' | 'failed'
  code?: number
  buffer: string[]
  bytes: number
  clients: Set<ServerResponse>
  guard?: ReturnType<typeof setTimeout>
  queue: LineQueue
  controller: AbortController
  task: Promise<void>
}

export type FlowRunner = (input: FlowStart, io: FlowIO, env: NodeJS.ProcessEnv) => Promise<number>

export interface TutorServerOptions {
  root: string
  coursesRoot?: string
  today?: () => string
  stopTimeoutMs?: number
  modelConfigFile?: string
  modelEnvironment?: NodeJS.ProcessEnv
  // 注入确定性流程，测试真实 HTTP/SSE 而不调用模型。
  runFlow?: FlowRunner
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function localSettingsRequest(req: IncomingMessage): boolean {
  try {
    const target = new URL(`http://${req.headers.host ?? ''}`)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password) return false
    if (req.headers.origin && req.headers.origin !== target.origin) return false
    return req.headers['sec-fetch-site'] !== 'cross-site'
  } catch { return false }
}

async function body(req: IncomingMessage): Promise<unknown> {
  let text = ''
  for await (const chunk of req) {
    text += chunk.toString()
    if (text.length > 1_000_000) throw new Error('请求体过大')
  }
  return JSON.parse(text)
}

function snapshot(flow: Flow) {
  return { flowId: flow.flowId, kind: flow.kind, courseId: flow.courseId,
    milestoneId: flow.milestoneId, nodeId: flow.nodeId, status: flow.status, ...(flow.code !== undefined ? { code: flow.code } : {}) }
}

export function createTutorServer(options: TutorServerOptions) {
  const root = path.resolve(options.root)
  const staticDir = path.join(root, 'static')
  const store = new CourseStore(options.coursesRoot ?? path.join(root, 'courses'))
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10))
  const models = new ModelConfigStore(root, { file: options.modelConfigFile, env: options.modelEnvironment })
  const flows = new Map<string, Flow>()
  let active: Flow | null = null
  const runFlow: FlowRunner = options.runFlow ?? ((input, io, env) => runFlowInProcess(
    { kind: input.kind, courseId: input.courseId, ...(input.milestoneId ? { milestoneId: input.milestoneId } : {}), ...(input.nodeId ? { nodeId: input.nodeId } : {}) },
    io, { root, env }))

  function broadcast(flow: Flow, event: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify({ ...snapshot(flow), ...event })}\n\n`
    flow.buffer.push(payload)
    flow.bytes += Buffer.byteLength(payload)
    // 每个流程最多保留 400 块 / 1 MiB，已退出流程也可重连查看结果。
    while (flow.buffer.length > 400 || (flow.bytes > 1_048_576 && flow.buffer.length > 1)) {
      flow.bytes -= Buffer.byteLength(flow.buffer.shift()!)
    }
    for (const client of flow.clients) if (!client.writableEnded) client.write(payload)
  }

  function finish(flow: Flow, code: number): void {
    if (flow.code !== undefined) return
    if (flow.guard) clearTimeout(flow.guard)
    flow.code = code
    flow.status = code === 0 ? 'completed' : 'failed'
    if (active === flow) active = null
    broadcast(flow, { type: 'exit', code })
  }

  function start(input: FlowStart) {
    if (!RUNNERS.has(input.kind)) return { ok: false, error: `未知流程 "${input.kind}"` }
    if (!COURSE_ID_PATTERN.test(input.courseId)) return { ok: false, error: `课程名 "${input.courseId}" 非法` }
    if (input.milestoneId && (input.kind !== 'exam' || !COURSE_ID_PATTERN.test(input.milestoneId))) return { ok: false, error: '里程碑参数非法' }
    if (input.nodeId && (!['practice', 'practice-gen', 'research'].includes(input.kind) || !/^[a-z0-9][a-z0-9-]*$/.test(input.nodeId))) {
      return { ok: false, error: '知识点参数非法' }
    }
    if (active) {
      if (active.status === 'running' && active.kind === input.kind && active.courseId === input.courseId && active.milestoneId === input.milestoneId && active.nodeId === input.nodeId) {
        return { ok: true, resumed: true, ...snapshot(active) }
      }
      return { ok: false, error: `已有进行中的流程（${active.kind} ${active.courseId}），先结束它再开始新的` }
    }
    if (input.kind !== 'new' && !store.exists(input.courseId)) return { ok: false, error: `课程 "${input.courseId}" 不存在——先用 new 访谈建档` }
    if (input.nodeId && (!store.has(input.courseId, 'knowledge-map') || !(store.read(input.courseId, 'knowledge-map') as KnowledgeMap).nodes.some((node) => node.id === input.nodeId))) {
      return { ok: false, error: '所选知识点不在本课程知识地图中' }
    }
    // 每次启动流程冻结模型配置；practice 为零模型流程，不要求已配置模型。
    const env = input.kind === 'practice' ? { ...(options.modelEnvironment ?? process.env) } : models.environment()
    const queue = createLineQueue()
    const controller = new AbortController()
    const flow: Flow = { ...input, flowId: randomUUID(), status: 'running', buffer: [], bytes: 0, clients: new Set(), queue, controller,
      task: Promise.resolve() }
    const io: FlowIO = {
      out: text => { if (flow.code === undefined) broadcast(flow, { type: 'out', text }) },
      err: text => { if (flow.code === undefined) broadcast(flow, { type: 'err', text }) },
      readLine: () => queue.read(),
      closeInput: () => queue.close(),
      signal: controller.signal,
      tty: false,
    }
    // 保留最近 8 个流程的内存回放；跨服务重启的课程断点由课程状态持久化。
    while (flows.size > 8) {
      const oldest = flows.values().next().value!
      for (const client of oldest.clients) client.end()
      flows.delete(oldest.flowId)
    }
    active = flow
    flows.set(flow.flowId, flow)
    flow.task = (async () => {
      let code: number
      try {
        code = await runFlow(input, io, { ...env, TUTOR_COURSES_ROOT: store.root })
      } catch (error) {
        if (error instanceof FlowExit) code = error.code
        else {
          broadcast(flow, { type: 'err', text: `流程启动失败：${error instanceof Error ? error.message : String(error)}\n` })
          code = -1
        }
      }
      finish(flow, code)
    })()
    return { ok: true, started: true, ...snapshot(flow) }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname === '/api/model-config') {
        if (!localSettingsRequest(req)) { json(res, 403, { ok: false, error: '模型设置仅允许从本机同源页面访问' }); return }
        if (req.method === 'GET') {
          json(res, 200, { ok: true, config: models.publicConfig(), active: active ? snapshot(active) : null }); return
        }
        if (req.method === 'POST') {
          if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
            json(res, 415, { ok: false, error: '模型设置请求必须使用 application/json' }); return
          }
          let input
          try { input = await body(req) } catch { json(res, 400, { ok: false, error: '模型设置请求必须是有效的 JSON' }); return }
          const config = models.save(input)
          json(res, 200, { ok: true, config, active: active ? snapshot(active) : null }); return
        }
        json(res, 405, { ok: false, error: '不支持此操作' }); return
      }
      if (req.method === 'POST' && url.pathname === '/rpc') {
        let request
        try { request = await body(req) } catch {
          json(res, 200, { jsonrpc: '2.0', id: null, error: RPC_ERRORS.parse }); return
        }
        // 流程持有课程快照，同一课程的网页复习不能同时回写。
        const rpc = request as RpcRequest | null
        if (active && rpc?.params?.id === active.courseId && ['submitReview', 'applyReview'].includes(rpc?.method ?? '')) {
          json(res, 200, { jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: -32602, message: '本课程有进行中的流程，请结束后提交复习' } }); return
        }
        json(res, 200, handleRpcRequest(store, request as RpcRequest, today)); return
      }
      if (req.method === 'GET' && url.pathname === '/flow/state') {
        const requested = flows.get(url.searchParams.get('flowId') ?? '')
        json(res, 200, { protocolVersion: FLOW_PROTOCOL_VERSION, active: active ? snapshot(active) : null, flow: requested ? snapshot(requested) : null }); return
      }
      if (req.method === 'GET' && url.pathname === '/flow/stream') {
        const flow = flows.get(url.searchParams.get('flowId') ?? '')
        if (!flow) { json(res, 404, { ok: false, error: '流程不存在或回放已过期，请刷新页面' }); return }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(`data: ${JSON.stringify({ type: 'hello', ...snapshot(flow) })}\n\n`)
        for (const event of flow.buffer) res.write(event)
        flow.clients.add(res)
        req.on('close', () => flow.clients.delete(res))
        return
      }
      if (req.method === 'POST' && url.pathname.startsWith('/flow/')) {
        const value = await body(req)
        if (!value || typeof value !== 'object' || Array.isArray(value)) { json(res, 400, { ok: false, error: '请求体必须是对象' }); return }
        const input = value as Record<string, unknown>
        if (url.pathname === '/flow/start') {
          const result = start({ kind: String(input.kind ?? ''), courseId: String(input.courseId ?? ''), milestoneId: String(input.milestoneId ?? ''), nodeId: String(input.nodeId ?? '') })
          json(res, result.ok ? 200 : 409, result); return
        }
        if (url.pathname !== '/flow/input' && url.pathname !== '/flow/stop') { json(res, 404, { ok: false, error: '未知操作' }); return }
        if (!active || input.flowId !== active.flowId) { json(res, 409, { ok: false, error: '流程已结束或已切换，请刷新页面后继续' }); return }
        const flow = active
        if (url.pathname === '/flow/input') {
          if (flow.status !== 'running' || flow.queue.closed) { json(res, 409, { ok: false, error: '流程正在结束' }); return }
          if (typeof input.line !== 'string' || /[\r\n]/.test(input.line)) { json(res, 400, { ok: false, error: '每次只能提交一行输入' }); return }
          flow.queue.push(input.line)
        } else if (flow.status !== 'stopping') {
          flow.status = 'stopping'
          broadcast(flow, { type: 'state' })
          const line = STOP_LINES[flow.kind]
          if (line !== undefined) flow.queue.push(line)
          else flow.queue.close()
          flow.guard = setTimeout(() => {
            // 流程未在时限内响应停止：中止在途请求并释放活动槽位。
            flow.queue.close()
            flow.controller.abort(new Error('流程停止超时'))
            finish(flow, -1)
          }, options.stopTimeoutMs ?? 8000)
        }
        json(res, 200, { ok: true, ...snapshot(flow) }); return
      }
      if (req.method === 'GET') {
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
        const file = path.resolve(staticDir, relative)
        if (!file.startsWith(staticDir + path.sep)) { res.writeHead(403).end(); return }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('404'); return }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(fs.readFileSync(file)); return
      }
      res.writeHead(405).end()
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  return {
    server,
    close(): Promise<void> {
      for (const flow of flows.values()) {
        if (flow.guard) clearTimeout(flow.guard)
        for (const client of flow.clients) client.end()
        if (flow.code === undefined) {
          flow.queue.close()
          flow.controller.abort(new Error('服务关闭'))
        }
      }
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
