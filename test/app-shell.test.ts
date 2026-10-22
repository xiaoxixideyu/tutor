// 单壳/视图控制器的浏览器级冒烟测试：用假 API 启动一个静态服务，验证
// app.html 的路由、视图挂载与聊天交互不依赖真实模型。
import { it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const hasChrome = fs.existsSync(chrome)

const COURSES = [{
  id: 'demo', goal: '示例课程', current: 'demo-node', mastered: 1, total: 2, dueCount: 1,
  stage: 'ready', contentReady: true, hasPlan: true, hasPractice: true, error: undefined,
  nodes: [{ id: 'demo-node', title: '示例节点', status: 'learning', score: 0.5, practiceCount: 0, researchStatus: 'pending' }],
  counts: { mastered: 1, learning: 1, weak: 0, unknown: 0 },
  milestones: [{ id: 'm1', title: '里程碑', nodes: ['demo-node'], masteredCount: 1, examPassed: false, examable: true }],
  totalNodes: 1, research: { completed: 0, verified: 0, pending: 1, total: 1 },
}]

function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(value))
    }
    if (url.pathname === '/rpc') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const request = JSON.parse(body || '{}')
        const result = request.method === 'listCourses' ? COURSES
          : request.method === 'courseStatus' ? COURSES[0]
            : request.method === 'dueReviews' ? [{ id: 'demo', due: [{ node: 'demo-node' }], earliestDue: '2026-10-22' }]
              : request.method === 'contentIssues' ? []
                : request.method === 'masteryHistory' ? { id: 'demo', days: 30, activity: [], pace: {}, nodes: [] }
                  : {}
        send({ jsonrpc: '2.0', id: request.id ?? null, result })
      })
      return
    }
    if (url.pathname === '/flow/state') { send({ protocolVersion: 1, flows: [], flow: null }); return }
    if (url.pathname === '/flow/start') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const request = JSON.parse(body || '{}')
        send({ ok: true, flowId: 'flow-demo', kind: request.kind ?? 'learn', courseId: request.courseId ?? 'demo', milestoneId: '', nodeId: '', status: 'running', code: undefined })
      })
      return
    }
    if (url.pathname === '/flow/input') { send({ ok: true }); return }
    if (url.pathname.startsWith('/flow/')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return }
    const file = path.join(root, 'static', url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''))
    if (!file.startsWith(path.join(root, 'static')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('404'); return
    }
    const ext = path.extname(file)
    res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' })
    res.end(fs.readFileSync(file))
  })
  server.listen(0, '127.0.0.1')
  return once(server, 'listening').then(() => ({
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }))
}

it('单壳工作区：左栏课程、路由与看板视图都能渲染（浏览器冒烟）', { skip: hasChrome ? false : '本机没有 Chrome，跳过浏览器冒烟' }, async (t) => {
  const { port, close } = await startServer()
  t.after(close)
  const profile = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tutor-shell-'))
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }))

  const render = async (route: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`,
      '--virtual-time-budget=4000', '--timeout=8000', '--dump-dom', `http://127.0.0.1:${port}/app.html${route}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', () => resolve(out))
  })

  const list = await render('')
  assert.match(list, /工作区/, '顶部标题')
  assert.match(list, /demo/, '左栏应列出课程')
  assert.match(list, /示例课程/, '画布应渲染课程列表')
  assert.match(list, /课程列表/, '看板标题')

  const detail = await render('#/course/demo')
  assert.match(detail, /知识点（1）/, '课程详情应渲染知识点表')
  assert.match(detail, /demo-node/, '课程详情应列出知识点')

  const learn = await render('#/course/demo/learn')
  assert.match(learn, /chat-surface/, '课堂视图应挂载对话面')
  assert.match(learn, /chat-inputrow/, '课堂视图应有常驻输入区')
  assert.match(learn, /换个讲法/, '课堂视图应带快捷指令')
})
