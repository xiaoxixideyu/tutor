#!/usr/bin/env node
// tutor 前端壳：本地 JSON-RPC 服务 + 静态页（三期；设计 §4.3：壳只做转发，业务在 src/core/rpc.ts）
// 用法：npm run serve  →  http://127.0.0.1:8787（仅本机，无鉴权，勿暴露公网）
import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CourseStore } from '../src/core/store.ts'
import { handleRpcRequest, RPC_ERRORS } from '../src/core/rpc.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staticDir = path.join(root, 'static')
const store = new CourseStore(process.env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses'))
const port = Number(process.env.TUTOR_SERVER_PORT ?? 8788)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) reject(new Error('请求体过大'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.resolve(staticDir, relative)
  if (!file.startsWith(staticDir + path.sep) && file !== staticDir) {
    res.writeHead(403).end()
    return
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404')
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  res.end(fs.readFileSync(file))
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/rpc') {
      const body = await readBody(req)
      let request
      try {
        request = JSON.parse(body)
      } catch {
        sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { ...RPC_ERRORS.parse } })
        return
      }
      // today 统一在壳注入（UTC ISO，与核心 today()/addDays 同源）
      sendJson(res, 200, handleRpcRequest(store, request, () => new Date().toISOString().slice(0, 10)))
      return
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/lesson/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ type: 'hello', courseId: lesson?.courseId ?? null })}\n\n`)
      lessonClients.add(res)
      req.on('close', () => lessonClients.delete(res))
      return
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/lesson/state') {
      const active = lesson && lesson.child.exitCode === null ? lesson.courseId : null
      sendJson(res, 200, { active })
      return
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/lesson/start') {
      const body = JSON.parse(await readBody(req))
      const result = lessonStart(String(body.courseId ?? ''))
      sendJson(res, result.ok ? 200 : 409, result)
      return
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/lesson/input') {
      const body = JSON.parse(await readBody(req))
      if (!lesson || lesson.child.exitCode !== null) {
        sendJson(res, 409, { ok: false, error: '没有进行中的课堂，先开始一节课' })
        return
      }
      lesson.child.stdin.write(`${String(body.line ?? '')}\n`)
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/lesson/stop') {
      if (!lesson || lesson.child.exitCode !== null) {
        sendJson(res, 409, { ok: false, error: '没有进行中的课堂' })
        return
      }
      const child = lesson.child
      child.stdin.write('/exit\n')
      const guard = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 8000)
      child.once('exit', () => clearTimeout(guard))
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET') {
      serveStatic(res, req.url.split('?')[0])
      return
    }
    res.writeHead(405).end()
  } catch (error) {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC_ERRORS.internal.code, message: error instanceof Error ? error.message : String(error) },
    })
  }
})

// ---- 课堂桥：SSE 推子进程 stdout，POST 传 stdin（壳只做传输，业务在 learn-runner）----
const COURSE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
let lesson = null
const lessonClients = new Set()

function lessonBroadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const client of lessonClients) client.write(payload)
}

function lessonStart(courseId) {
  if (lesson && lesson.child.exitCode === null && lesson.child.pid) {
    if (lesson.courseId === courseId) return { ok: true, resumed: true, courseId }
    return { ok: false, error: `已有进行中的课堂（${lesson.courseId}），先结束它再开始新课` }
  }
  if (!COURSE_ID_PATTERN.test(courseId)) return { ok: false, error: `课程名 "${courseId}" 非法` }
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'agent.mjs'), 'learn', courseId], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  lesson = { courseId, child }
  child.stdout.on('data', (chunk) => lessonBroadcast({ type: 'out', text: chunk.toString('utf8') }))
  child.stderr.on('data', (chunk) => lessonBroadcast({ type: 'err', text: chunk.toString('utf8') }))
  child.on('exit', (code) => {
    lessonBroadcast({ type: 'exit', code: code ?? -1 })
    lesson = null
  })
  return { ok: true, started: true, courseId }
}

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`tutor 前端壳已启动：http://127.0.0.1:${port}（仅本机访问）\n`)
})

process.on('exit', () => {
  lesson?.child.kill()
})
