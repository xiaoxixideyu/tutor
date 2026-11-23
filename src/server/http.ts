import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { TutorSystem, type TutorSystemOptions } from '../application/tutor-system.ts'
import { DomainError } from '../domain/model.ts'
import { integer, object, text } from '../domain/validation.ts'
import { openaiTransport } from '../runtime/llm.ts'
import type { LearningIntent } from '../domain/model.ts'

export type TutorServerOptions = TutorSystemOptions
interface StreamClient {
  res: ServerResponse
  courseId: string
  cursor: number
  revision: number
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function local(req: IncomingMessage): boolean {
  try {
    const origin = new URL('http://' + (req.headers.host ?? ''))
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
      !origin.username &&
      !origin.password &&
      (!req.headers.origin || req.headers.origin === origin.origin) &&
      req.headers['sec-fetch-site'] !== 'cross-site'
    )
  } catch {
    return false
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new DomainError('CONTENT_TYPE', '请使用 JSON 请求', 415)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 200000) throw new DomainError('BODY_TOO_LARGE', '请求内容过长', 413)
    chunks.push(Buffer.from(chunk))
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('INVALID_JSON', '请求不是有效 JSON')
  }
}

export function createTutorServer(options: TutorServerOptions) {
  const system = new TutorSystem(options)
  const staticRoot = path.join(path.resolve(options.root), 'static')
  const clients = new Set<StreamClient>()
  const send = (res: ServerResponse, value: unknown) => {
    if (!res.writableEnded) res.write('data: ' + JSON.stringify(value) + '\n\n')
  }
  const snapshot = (courseId: string) => ({
    type: 'snapshot',
    course: system.service.view(courseId),
    job: system.activeJobs().find((job) => job.courseId === courseId) ?? null,
  })
  const publish = (client: StreamClient, operation?: { phase: string; running: boolean }) => {
    for (const event of system.events(client.courseId, client.cursor)) {
      send(client.res, event)
      client.cursor = event.seq
    }
    if (operation) send(client.res, { type: 'operation', data: operation })
    const current = snapshot(client.courseId)
    client.revision = current.course.revision
    send(client.res, current)
  }
  const unsubscribe = system.subscribe((courseId, operation) => {
    for (const client of clients)
      if (client.courseId === courseId && !client.res.writableEnded) {
        try {
          publish(client, operation)
        } catch {
          client.res.end()
          clients.delete(client)
        }
      }
  })
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname.startsWith('/api/')) {
        if (!local(req)) {
          json(res, 403, { ok: false, error: { code: 'LOCAL_ONLY', message: '仅允许本机同源访问' } })
          return
        }
        if (url.pathname === '/api/health' && req.method === 'GET') {
          json(res, 200, { ok: true, version: 2, courses: system.repository.list().length })
          return
        }
        if (url.pathname === '/api/model-config') {
          if (req.method === 'GET') {
            json(res, 200, { ok: true, config: system.models.publicConfig(), flows: system.activeJobs() })
            return
          }
          if (req.method === 'POST') {
            const config = system.models.save(await body(req))
            json(res, 200, { ok: true, config, flows: system.activeJobs() })
            return
          }
        }
        if (url.pathname === '/api/model-test' && req.method === 'POST') {
          const input = await body(req)
          const config = system.models.draft({
            ...input,
            searchMcpUrl: undefined,
            searchToken: undefined,
            judgment: undefined,
          })
          const started = Date.now()
          const result = await openaiTransport(config)(
            { messages: [{ role: 'user', content: '只回复 OK。' }], maxTokens: 1024 },
            AbortSignal.timeout(90000),
            () => {},
          )
          if (result.finish === 'error')
            json(res, 200, { ok: false, error: result.error.message, elapsedMs: Date.now() - started })
          else
            json(res, 200, {
              ok: true,
              model: config.model,
              level: config.thinking,
              finish: result.finish,
              text: result.text.slice(0, 300),
              elapsedMs: Date.now() - started,
            })
          return
        }
        if (url.pathname === '/api/judgment-test' && req.method === 'POST') {
          const input = await body(req)
          const controller = new AbortController()
          res.once('close', () => {
            if (!res.writableEnded) controller.abort(new Error('请求已取消'))
          })
          json(res, 200, { ok: true, ...(await system.testJudgment(input, controller.signal)) })
          return
        }
        if (url.pathname === '/api/today' && req.method === 'GET') {
          json(res, 200, { ok: true, ...system.readToday() })
          return
        }
        if (url.pathname === '/api/today/recommend' && req.method === 'POST') {
          const input = await body(req)
          const controller = new AbortController()
          res.once('close', () => {
            if (!res.writableEnded) controller.abort(new Error('请求已取消'))
          })
          json(res, 200, {
            ok: true,
            ...(await system.recommendToday(
              integer(input.availableMinutes, '可用分钟', 5, 600, 20),
              controller.signal,
            )),
          })
          return
        }
        if (url.pathname === '/api/courses') {
          if (req.method === 'GET') {
            json(res, 200, { ok: true, courses: system.service.list(), jobs: system.activeJobs() })
            return
          }
          if (req.method === 'POST') {
            const created = system.service.create(await body(req))
            json(res, 201, { ok: true, course: system.service.view(created.id) })
            return
          }
        }
        const match = url.pathname.match(/^\/api\/courses\/([a-z0-9-]+)(?:\/(.*))?$/)
        if (match) {
          const courseId = match[1],
            action = match[2] ?? ''
          if (req.method === 'GET' && action === '') {
            json(res, 200, {
              ok: true,
              course: system.service.view(courseId),
              events: system.events(courseId, -1).slice(-150),
              job: system.activeJobs().find((job) => job.courseId === courseId) ?? null,
            })
            return
          }
          if (req.method === 'GET' && action === 'events') {
            const after = Number(url.searchParams.get('after') ?? -1)
            integer(after, '事件位置', -1, Number.MAX_SAFE_INTEGER)
            json(res, 200, { ok: true, events: system.events(courseId, after) })
            return
          }
          if (req.method === 'GET' && action === 'stream') {
            const after = Number(url.searchParams.get('after') ?? -1)
            integer(after, '事件位置', -1, Number.MAX_SAFE_INTEGER)
            const state = system.repository.read(courseId)
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            })
            const client = { res, courseId, cursor: after, revision: state.revision }
            if (after >= 0 && state.events[0] && after < state.events[0].seq - 1)
              send(res, { type: 'history_gap' })
            publish(client)
            clients.add(client)
            const polling = setInterval(() => {
              if (res.writableEnded) return
              try {
                const latest = system.repository.read(courseId)
                if (latest.revision !== client.revision || latest.nextEventSeq - 1 > client.cursor)
                  publish(client)
              } catch {
                res.end()
                clients.delete(client)
              }
            }, 1000)
            const heartbeat = setInterval(() => {
              if (!res.writableEnded) res.write(': alive\n\n')
            }, 15000)
            req.on('close', () => {
              clearInterval(heartbeat)
              clearInterval(polling)
              clients.delete(client)
            })
            return
          }
          if (req.method === 'DELETE' && action === '') {
            await body(req)
            await system.remove(courseId)
            json(res, 200, { ok: true })
            return
          }
          if (req.method === 'POST') {
            const input = await body(req)
            const requestId = text(input.requestId, '请求标识', 220)
            const expectedRevision =
              input.expectedRevision === undefined
                ? undefined
                : integer(input.expectedRevision, '状态版本', 0, Number.MAX_SAFE_INTEGER)
            if (action === 'turn') {
              const result = system.start(courseId, {
                requestId,
                message: typeof input.message === 'string' ? input.message : '',
                intent: input.intent as LearningIntent | undefined,
                expectedRevision,
                activeMs: typeof input.activeMs === 'number' ? input.activeMs : 0,
              })
              json(res, 202, { ok: true, ...result })
              return
            }
            if (action === 'answer') {
              const result = system.answer(courseId, {
                requestId,
                activityId: text(input.activityId, '活动标识', 100),
                questionId: text(input.questionId, '题号', 96),
                contentHash: text(input.contentHash, '内容版本', 64),
                answer: text(input.answer, '作答', 50000),
                expectedRevision,
                activeMs: typeof input.activeMs === 'number' ? input.activeMs : 0,
              })
              json(res, 202, { ok: true, ...result })
              return
            }
            if (action === 'draft') {
              const draft = system.service.saveDraft(courseId, {
                activityId: text(input.activityId, '活动标识', 100),
                questionId: text(input.questionId, '题号', 96),
                answer: text(input.answer, '草稿', 50000, true),
                draftVersion:
                  input.draftVersion === undefined
                    ? undefined
                    : integer(input.draftVersion, '草稿版本', 0, Number.MAX_SAFE_INTEGER),
              })
              json(res, 200, { ok: true, draft })
              return
            }
            if (action === 'pause') {
              system.pause(courseId, requestId)
              json(res, 200, { ok: true, ...snapshot(courseId) })
              return
            }
            if (action === 'resume') {
              json(res, 202, { ok: true, ...system.resume(courseId, requestId) })
              return
            }
            if (action === 'goal') {
              if (typeof input.accept !== 'boolean')
                throw new DomainError('INVALID_INPUT', '需选择是否接受建议')
              if (expectedRevision === undefined) throw new DomainError('INVALID_INPUT', '需提供当前状态版本')
              system.resolveGoal(
                courseId,
                text(input.proposalId, '建议标识', 100),
                input.accept,
                requestId,
                expectedRevision,
              )
              json(res, 200, { ok: true, course: system.service.view(courseId) })
              return
            }
          }
        }
        json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } })
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      const requested =
        url.pathname === '/' ? 'app.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const file = path.resolve(staticRoot, requested)
      if (!file.startsWith(staticRoot + path.sep)) {
        res.writeHead(403).end()
        return
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end('404')
        return
      }
      if (!fs.realpathSync(file).startsWith(staticRoot + path.sep)) {
        res.writeHead(403).end()
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(fs.readFileSync(file))
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      json(res, error instanceof DomainError ? error.status : 400, {
        ok: false,
        error: {
          code: error instanceof DomainError ? error.code : 'REQUEST_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  })
  return {
    server,
    system,
    async close() {
      unsubscribe()
      for (const client of clients) client.res.end()
      await system.close()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
