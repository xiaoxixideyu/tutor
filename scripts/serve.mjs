#!/usr/bin/env node
// tutor 前端壳：本地 JSON-RPC 服务 + 静态页（三期；设计 §4.3：壳只做转发，业务在 src/core/rpc.ts）
// 用法：npm run serve  →  http://127.0.0.1:8787（仅本机，无鉴权，勿暴露公网）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CourseStore } from '../src/core/store.ts'
import { handleRpcRequest, RPC_ERRORS } from '../src/core/rpc.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staticDir = path.join(root, 'static')
const store = new CourseStore(process.env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses'))
const port = Number(process.env.TUTOR_SERVER_PORT ?? 8787)

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

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`tutor 前端壳已启动：http://127.0.0.1:${port}（仅本机访问）\n`)
})
