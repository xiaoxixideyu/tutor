// 内容质量评测：固定样本、独立审查会话、保留证据与用量（单进程直跑，不依赖外部基座）。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { CONTENT_REVIEW_LIMITS, ContentGate } from '../flows/content-gate.ts'
import { ChatRuntime } from '../runtime/chat.ts'
import { modelSettingsFromEnv } from '../flows/run.ts'
import { QualityStore, type QualityRecord } from '../core/quality-store.ts'
import { addUsage, estimateCost, loadCostConfig, ratesForModel } from '../core/cost.ts'
import { summarizeContent, validateContentFixtures, type ContentRun } from './content.ts'

export interface ContentEvalOptions {
  root: string
  env: NodeJS.ProcessEnv
  fixtureFile: string
  outputDir: string
  costFile: string
  repeats: number
  maxTokens: number
  cases: string[]
  out?: (text: string) => void
  err?: (text: string) => void
}

export async function runContentEval(options: ContentEvalOptions): Promise<number> {
  const out = options.out ?? ((text: string) => process.stdout.write(text))
  const errOut = options.err ?? ((text: string) => process.stderr.write(text))
  const fixtureText = fs.readFileSync(options.fixtureFile, 'utf8')
  const fixtures = validateContentFixtures(JSON.parse(fixtureText))
  if (options.cases.length) {
    if (options.cases.some(id => !fixtures.cases.some(item => item.id === id))) throw new Error('未知样本 id')
    fixtures.cases = fixtures.cases.filter(item => options.cases.includes(item.id))
  }
  const costs = loadCostConfig(fs.readFileSync(options.costFile, 'utf8'))
  const runtime = new ChatRuntime({
    model: modelSettingsFromEnv(options.env),
    sessionsRoot: options.env.TUTOR_SESSIONS_ROOT ?? path.join(options.outputDir, 'sessions'),
    workspace: options.env.TUTOR_WORKSPACE ?? options.root,
    env: options.env,
    out, err: errOut,
    maxModelRequests: 72,
  })
  const runs: (ContentRun & { elapsedMs: number; evidenceFile?: string })[] = []
  const records: QualityRecord[] = []
  // 审查会话一律以隔离系统提示词创建、不携带任何工具与动态上下文；这里记录每次组装供报告核对。
  const assemblies: { isolated: boolean; sections: string[]; tools: number; contexts: number }[] = []
  let status = 'running'
  const startedAt = new Date().toISOString()
  const sourceHashes = Object.fromEntries(['../core/content-quality.ts', '../core/quality-store.ts', '../core/rational.ts', '../flows/content-gate.ts', '../runtime/chat.ts', './content.ts', './content-runner.ts']
    .map(file => [file, createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')]))
  function save() {
    const calls = records.flatMap(record => record.calls)
    const usage = calls.reduce((sum, call) => addUsage(sum, call.usage), { inputTokens: 0, outputTokens: 0 })
    const models = [...new Set(calls.flatMap(call => call.model ? [call.model] : []))]
    const estimated = models.reduce((sum, model) => sum + estimateCost(calls.filter(call => call.model === model)
      .reduce((total, call) => addUsage(total, call.usage), { inputTokens: 0, outputTokens: 0 }), ratesForModel(costs, model)), 0)
    const report = { version: 1, status, startedAt, updatedAt: new Date().toISOString(), fixtures,
      fixtureHash: createHash('sha256').update(fixtureText).digest('hex'), sourceHashes,
      settings: { repeats: options.repeats, maxTokens: options.maxTokens, reviewLimits: CONTENT_REVIEW_LIMITS, thinking: options.env.TUTOR_LLM_THINKING ?? 'provider-default', independentSessions: true, tools: false, cached: false },
      summary: summarizeContent(fixtures, runs, options.repeats), models, assemblies, usage,
      cost: { currency: costs.currency, estimated, actualBill: null, basis: '含失败尝试的已报告用量，按配置估算；非账单。运行中未落盘的请求用量可能缺失。' }, runs }
    const file = path.join(options.outputDir, 'report.json')
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2) + '\n'); fs.renameSync(`${file}.tmp`, file)
    return report
  }
  save()
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    const cases = repeat % 2 ? [...fixtures.cases].reverse() : fixtures.cases
    for (const [index, item] of cases.entries()) {
      const entry: typeof runs[number] = { caseId: item.id, repeat, elapsedMs: 0 }
      runs.push(entry); save()
      out(`内容样本 ${item.id}，轮次 ${repeat + 1}/${options.repeats}…\n`)
      const start = Date.now()
      // 每轮每样本使用不同目录；不能通过上轮准入缓存冒充独立重复验证。
      const store = new QualityStore(path.join(options.outputDir, 'cases'), `case-${repeat}-${index}`)
      const recordProgress = (record: QualityRecord) => {
        if (!records.some(previous => previous.id === record.id)) records.push(record)
        entry.review = record.review; entry.evidenceFile = store.evidenceFile(record.id); save()
      }
      const gate = new ContentGate(store, async (_role, isolatedSystemPrompt) => {
        assemblies.push({ isolated: true, sections: ['tutor:isolated-review'], tools: 0, contexts: 0 })
        const chat = await runtime.createChat({ isolatedSystemPrompt, ...CONTENT_REVIEW_LIMITS })
        if (!chat) throw new Error('不能创建审查会话')
        return chat
      }, recordProgress, { onProgress: recordProgress })
      try { const result = await gate.review(item.input); entry.approved = result.approved; entry.cached = result.cached }
      catch (error) { entry.error = error instanceof Error ? error.message : String(error) }
      entry.elapsedMs = Date.now() - start; save()
      out(`结果：${entry.error ? '运行失败' : entry.approved ? '批准' : '拒绝'}，${entry.elapsedMs} ms\n`)
    }
  }
  status = 'completed'
  const report = save()
  out(`判断命中 ${report.summary.correct}/${report.summary.expected}；误放行 ${report.summary.falseApprovals}，误拦截 ${report.summary.falseRejections}，运行错误 ${report.summary.errors}。\n`)
  out(`估算 ${costs.currency}${report.cost.estimated.toFixed(4)}（非账单）。\n`)
  return report.summary.passed ? 0 : 2
}
