#!/usr/bin/env node
// 本地网页入口：HTTP/SSE 宿主可独立启动测试，领域规则仍在 src/core。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTutorServer } from '../src/server/http.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.TUTOR_SERVER_PORT ?? 8788)
const app = createTutorServer({ root, coursesRoot: process.env.TUTOR_COURSES_ROOT })
app.server.listen(port, '127.0.0.1', () => {
  const address = app.server.address()
  process.stdout.write(`tutor 前端壳已启动：http://127.0.0.1:${address.port}（仅本机访问）\n`)
})
let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    app.close().then(() => process.exit(0), () => process.exit(1))
  })
}
app.server.on('error', (error) => {
  process.stderr.write(`tutor: ${error.message}\n`)
  process.exitCode = 1
})
