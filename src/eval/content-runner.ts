import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ContentGate } from '../plugin/content-gate.ts'
import { createAgentChat } from '../plugin/agent-chat.ts'
import { QualityStore, type QualityRecord } from '../core/quality-store.ts'
import { FACT_PERSONA, REVIEWER_PERSONA, SOLVER_PERSONA } from '../core/content-quality.ts'
import { addUsage, estimateCost, loadCostConfig, ratesForModel } from '../core/cost.ts'
import { summarizeContent, validateContentFixtures, type ContentRun } from './content.ts'

export const name = 'tutor-content-eval'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'systemPrompt', 'tools']
export const Config = z.object({ fixtureFile: z.string().required(), outputDir: z.string().required(), costFile: z.string().required(),
  repeats: z.number().min(1).max(3).required(), maxTokens: z.number().min(1024).max(8192).required(), cases: z.array(z.string()).default([]) })
interface Options { fixtureFile: string; outputDir: string; costFile: string; repeats: number; maxTokens: number; cases: string[] }

async function run(ctx: Context, config: Options): Promise<number> {
  const fixtureText = fs.readFileSync(config.fixtureFile, 'utf8')
  const fixtures = validateContentFixtures(JSON.parse(fixtureText))
  if (config.cases.length) {
    if (config.cases.some(id => !fixtures.cases.some(item => item.id === id))) throw new Error('未知样本 id')
    fixtures.cases = fixtures.cases.filter(item => config.cases.includes(item.id))
  }
  const costs = loadCostConfig(fs.readFileSync(config.costFile, 'utf8'))
  const runs: (ContentRun & { elapsedMs: number; evidenceFile?: string })[] = []
  const records: QualityRecord[] = []
  const assemblies: { isolated: boolean; sections: string[]; tools: number; contexts: number }[] = []
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const isolated = assembled.sections.length === 1 && [SOLVER_PERSONA, REVIEWER_PERSONA, FACT_PERSONA].includes(assembled.sections[0].text)
      && assembled.tools.length === 0 && assembled.contexts.length === 0
    assemblies.push({ isolated, sections: assembled.sections.map(s => s.name), tools: assembled.tools.length, contexts: assembled.contexts.length })
    if (!isolated) throw new Error('审查请求未隔离角色、工具或动态上下文')
    return assembled
  })
  let requests = 0
  ctx.on('agent/request', async (_payload, next) => {
    if (++requests > 72) throw new Error('内容评测超过 72 次请求上限')
    return { ...await next(), maxTokens: config.maxTokens }
  })
  let status = 'running'
  const startedAt = new Date().toISOString()
  const sourceHashes = Object.fromEntries(['../core/content-quality.ts', '../core/quality-store.ts', '../core/rational.ts', '../plugin/content-gate.ts', '../plugin/agent-chat.ts', './content.ts', './content-runner.ts']
    .map(file => [file, createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')]))
  function save() {
    const calls = records.flatMap(record => record.calls)
    const usage = calls.reduce((sum, call) => addUsage(sum, call.usage), { inputTokens: 0, outputTokens: 0 })
    const models = [...new Set(calls.flatMap(call => call.model ? [call.model] : []))]
    const estimated = models.reduce((sum, model) => sum + estimateCost(calls.filter(call => call.model === model)
      .reduce((total, call) => addUsage(total, call.usage), { inputTokens: 0, outputTokens: 0 }), ratesForModel(costs, model)), 0)
    const report = { version: 1, status, startedAt, updatedAt: new Date().toISOString(), fixtures,
      fixtureHash: createHash('sha256').update(fixtureText).digest('hex'), sourceHashes,
      settings: { repeats: config.repeats, maxTokens: config.maxTokens, independentSessions: true, tools: false, cached: false },
      summary: summarizeContent(fixtures, runs, config.repeats), models, assemblies, usage,
      cost: { currency: costs.currency, estimated, actualBill: null, basis: '含失败尝试的 Harness 已报告用量，按配置估算；非账单。运行中未落盘的请求用量可能缺失。' }, runs }
    const file = path.join(config.outputDir, 'report.json')
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2) + '\n'); fs.renameSync(`${file}.tmp`, file)
    return report
  }
  save()
  for (let repeat = 0; repeat < config.repeats; repeat++) {
    const cases = repeat % 2 ? [...fixtures.cases].reverse() : fixtures.cases
    for (const [index, item] of cases.entries()) {
      const entry: typeof runs[number] = { caseId: item.id, repeat, elapsedMs: 0 }
      runs.push(entry); save()
      process.stdout.write(`内容样本 ${item.id}，轮次 ${repeat + 1}/${config.repeats}…\n`)
      const start = Date.now()
      // 每轮每样本使用不同目录；不能通过上轮准入缓存冒充独立重复验证。
      const store = new QualityStore(path.join(config.outputDir, 'cases'), `case-${repeat}-${index}`)
      const gate = new ContentGate(store, async (_role, isolatedSystemPrompt) => {
        const chat = await createAgentChat(ctx, { isolatedSystemPrompt })
        if (!chat) throw new Error('不能创建审查会话')
        return chat
      }, record => { records.push(record); entry.review = record.review; entry.evidenceFile = store.evidenceFile(record.id); save() })
      try { const result = await gate.review(item.input); entry.approved = result.approved; entry.cached = result.cached }
      catch (error) { entry.error = error instanceof Error ? error.message : String(error) }
      entry.elapsedMs = Date.now() - start; save()
      process.stdout.write(`结果：${entry.error ? '运行失败' : entry.approved ? '批准' : '拒绝'}，${entry.elapsedMs} ms\n`)
    }
  }
  status = 'completed'
  const report = save()
  process.stdout.write(`判断命中 ${report.summary.correct}/${report.summary.expected}；误放行 ${report.summary.falseApprovals}，误拦截 ${report.summary.falseRejections}，运行错误 ${report.summary.errors}。\n`)
  process.stdout.write(`估算 ${costs.currency}${report.cost.estimated.toFixed(4)}（非账单）。\n`)
  return report.summary.passed ? 0 : 2
}

export function apply(ctx: Context, config: Options): void {
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  run(ctx, config).then(code => { process.stdin.destroy(); exit(code) }).catch(error => {
    process.stderr.write(`内容评测失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy(); exit(1)
  })
}
