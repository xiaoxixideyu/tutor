// 判分一致性评测：固定样本、独立会话、保留全部失败尝试与用量（单进程直跑，不依赖外部基座）。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { addUsage, estimateCost, loadCostConfig, ratesForModel, type UsageSample } from '../core/cost.ts'
import { validateSubjectiveGradings } from '../core/exam.ts'
import { ChatRuntime, type AgentChat } from '../runtime/chat.ts'
import { modelSettingsFromEnv } from '../flows/run.ts'
import { buildExamGradingPrompt } from '../flows/exam.ts'
import { generateTurn, parseJsonBlock } from '../flows/generation.ts'
import { gradingInputs, summarizeGrading, validateGradingFixtures, type GradingRun } from './grading.ts'

export interface GradingEvalOptions {
  root: string
  env: NodeJS.ProcessEnv
  fixtureFile: string
  outputFile: string
  personaFile: string
  costFile: string
  repeats: number
  maxTokens: number
  out?: (text: string) => void
  err?: (text: string) => void
}

interface RecordedRun extends GradingRun {
  sessionId?: string
  model?: string
  elapsedMs: number
  usage: UsageSample
  attempts: { prompt: string; reply?: string; validationError?: string; error?: string }[]
}

export async function runGradingEval(options: GradingEvalOptions): Promise<number> {
  const out = options.out ?? ((text: string) => process.stdout.write(text))
  const errOut = options.err ?? ((text: string) => process.stderr.write(text))
  const fixtureText = fs.readFileSync(options.fixtureFile, 'utf8')
  const fixtures = validateGradingFixtures(JSON.parse(fixtureText))
  const persona = fs.readFileSync(options.personaFile, 'utf8').trim()
  const cost = loadCostConfig(fs.readFileSync(options.costFile, 'utf8'))
  const runtime = new ChatRuntime({
    model: modelSettingsFromEnv(options.env),
    sessionsRoot: options.env.TUTOR_SESSIONS_ROOT ?? path.join(path.dirname(options.outputFile), 'sessions'),
    workspace: options.env.TUTOR_WORKSPACE ?? options.root,
    persona,
    env: options.env,
    out, err: errOut,
  })
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const startedAt = new Date().toISOString()
  const runs: RecordedRun[] = []
  let status = 'running'
  function save() {
    const usage = runs.reduce((sum, item) => addUsage(sum, item.usage), { inputTokens: 0, outputTokens: 0 })
    const models = [...new Set(runs.flatMap(item => item.model ? [item.model] : []))]
    const estimated = models.reduce((sum, model) => {
      const modelUsage = runs.filter(item => item.model === model).reduce((total, item) => addUsage(total, item.usage), { inputTokens: 0, outputTokens: 0 })
      return sum + estimateCost(modelUsage, ratesForModel(cost, model))
    }, 0)
    const report = {
      version: 1, status, startedAt, updatedAt: new Date().toISOString(),
      fixtureHash: hash(fixtureText), personaHash: hash(persona), fixtures,
      settings: { repeats: options.repeats, maxTokens: options.maxTokens, independentSessions: true,
        tools: false, model: models, temperature: 'provider-default', titleGeneration: false },
      usage, cost: { currency: cost.currency, estimated,
        rates: Object.fromEntries(models.map(model => [model, ratesForModel(cost, model)])),
        actualBill: null, basis: 'config/cost.yaml 估算，缓存按普通输入单价；不是实际账单。含已报告的失败尝试，异常请求可能有未报告用量。' },
      summary: summarizeGrading(fixtures, runs, options.repeats), runs,
    }
    fs.writeFileSync(`${options.outputFile}.tmp`, JSON.stringify(report, null, 2) + '\n')
    fs.renameSync(`${options.outputFile}.tmp`, options.outputFile)
    return report
  }
  save()
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    for (const suite of fixtures.suites) {
      out(`评测 ${suite.title}，独立会话 ${repeat + 1}/${options.repeats}…\n`)
      const recorded: RecordedRun = { suiteId: suite.id, repeat, elapsedMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 }, attempts: [] }
      runs.push(recorded)
      save()
      const start = Date.now()
      let chat: AgentChat | null = null
      try {
        chat = await runtime.createChat({ maxTokens: options.maxTokens })
        if (!chat) throw new Error('无法创建阅卷会话')
        recorded.sessionId = chat.sessionId
        recorded.model = chat.model
        const { questions, answers } = gradingInputs(suite, repeat)
        recorded.gradings = await generateTurn({ ask: async (prompt) => {
          const attempt: RecordedRun['attempts'][number] = { prompt }
          recorded.attempts.push(attempt)
          save()
          try { const reply = await chat!.ask(prompt); attempt.reply = reply; return reply }
          catch (error) { attempt.error = error instanceof Error ? error.message : String(error); throw error }
          finally { recorded.usage = chat!.totalUsage(); recorded.elapsedMs = Date.now() - start; save() }
        } }, buildExamGradingPrompt(questions, answers), (reply) => {
          const parsed = parseJsonBlock(reply)
          const result = parsed.ok ? validateSubjectiveGradings(parsed.value, questions) : parsed
          if (!result.ok) recorded.attempts.at(-1)!.validationError = result.error
          return result
        }) as NonNullable<GradingRun['gradings']>
      } catch (error) {
        recorded.error = error instanceof Error ? error.message : String(error)
      } finally {
        if (chat) {
          recorded.usage = chat.totalUsage()
          try { await chat.flush() } catch (error) { recorded.error ??= `会话日志保存失败：${String(error)}` }
        }
        recorded.elapsedMs = Date.now() - start
        save()
      }
      if (recorded.error) {
        status = 'failed'; save()
        errOut(`评测中止：${recorded.error}\n`)
        return 1
      }
      out(`完成：${recorded.gradings!.length} 个样本，${recorded.attempts.length} 次生成，${recorded.elapsedMs} ms\n`)
    }
  }
  status = 'completed'
  const report = save()
  out(`\n区间命中 ${report.summary.inRangeSamples}/${report.summary.expectedSamples}；稳定样本 ${report.summary.stableCases}/${report.summary.cases.length}\n`)
  out(`token：输入 ${report.usage.inputTokens}，输出 ${report.usage.outputTokens}；估算 ${cost.currency}${report.cost.estimated.toFixed(4)}（非账单）\n`)
  return report.summary.passed ? 0 : 2
}
