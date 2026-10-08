import fs from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { normalizeUsage } from '../core/cost.ts'

export const name = 'tutor-course-observer'
export const inject = ['tools']
export const Config = z.object({ outputFile: z.string().required(), research: z.boolean().default(false) })

// 验收专用：正式 runner 不变，关闭写文件/执行命令等模型工具；教研仅放行搜索与抓取。
export function apply(ctx: Context, config: { outputFile: string; research: boolean }): void {
  const allowed = (name: string) => config.research && (name.startsWith('mcp__searchix__') || name === 'web_fetch')
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    return { ...result, tools: result.tools.filter(tool => allowed(tool.name)), contexts: [] }
  })
  ;(ctx.get('tools') as { guard: (fn: (execution: { name: string }) => string | undefined) => unknown })
    .guard(execution => allowed(execution.name) ? undefined : '课程验收仅允许教研搜索与抓取')
  const write = (event: unknown) => fs.appendFileSync(config.outputFile, JSON.stringify(event) + '\n')
  let requests = 0
  ctx.on('agent/request', async (_payload, next) => {
    if (++requests > 24) throw new Error('单阶段超过 24 次模型请求，停止验收并检查原因')
    const request = await next()
    return { ...request, maxTokens: Math.min(request.maxTokens ?? 8192, 8192) }
  })
  const pending = new Map<string, { startedAt: number; firstChunkMs?: number; firstTextMs?: number }>()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const key = String(frame.attemptId)
    if (frame.type === 'start') {
      pending.set(key, { startedAt: Date.now() })
      write({ type: 'attempt-start', sessionId: String(agent.session.id), attemptId: key, time: new Date().toISOString() })
      return
    }
    const timing = pending.get(key)
    if (frame.type === 'chunk') {
      if (timing) timing.firstChunkMs ??= Date.now() - timing.startedAt
      if (timing && frame.chunk.type === 'text-delta' && frame.chunk.text) timing.firstTextMs ??= Date.now() - timing.startedAt
      return
    }
    const event = frame.outcome.kind === 'committed' ? agent.session.eventAt(frame.outcome.seq) : undefined
    const data = event?.data as { usage?: Parameters<typeof normalizeUsage>[0]; message?: { usage?: Parameters<typeof normalizeUsage>[0] } } | undefined
    write({ type: 'attempt', sessionId: String(agent.session.id), model: agent.options.model,
      attemptId: key, outcome: frame.outcome, ...timing,
      elapsedMs: timing ? Date.now() - timing.startedAt : null,
      usage: normalizeUsage(data?.usage ?? data?.message?.usage) })
    pending.delete(key)
  })
  ctx.on('agent/request-error', async ({ agent, failure }, next) => {
    write({ type: 'request-error', sessionId: String(agent.session.id), time: new Date().toISOString(), failure })
    return next()
  })
}
