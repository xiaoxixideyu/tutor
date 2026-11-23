#!/usr/bin/env node
// 本地网页入口：HTTP/SSE 可独立启动测试，业务约束由 domain / application 处理。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTutorServer } from '../src/server/http.ts'
import { readModelEnvironment } from '../src/core/model-config.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = readModelEnvironment(root, process.env)
const port = Number(env.TUTOR_SERVER_PORT ?? 8788)
const app = createTutorServer({
  root,
  env,
  coursesRoot: env.TUTOR_COURSES_ROOT,
  dataRoot: env.TUTOR_DATA_ROOT,
})
app.server.listen(port, '127.0.0.1', () => {
  const address = app.server.address()
  process.stdout.write(`tutor 前端壳已启动：http://127.0.0.1:${address.port}（仅本机访问）\n`)
})
let closing = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return
    closing = true
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}
app.server.on('error', (error) => {
  process.stderr.write(`tutor: ${error.message}\n`)
  process.exitCode = 1
})
