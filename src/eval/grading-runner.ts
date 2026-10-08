import fs from 'node:fs'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { addUsage, estimateCost, loadCostConfig, ratesForModel, type UsageSample } from '../core/cost.ts'
import { validateSubjectiveGradings } from '../core/exam.ts'
import { createAgentChat, type AgentChat } from '../plugin/agent-chat.ts'
import { buildExamGradingPrompt } from '../plugin/exam-runner.ts'
import { generateTurn, parseJsonBlock } from '../plugin/generation.ts'
import { gradingInputs, summarizeGrading, validateGradingFixtures, type GradingRun } from './grading.ts'

export const name = 'tutor-grading-eval'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'systemPrompt', 'tools']
export const Config = z.object({
  fixtureFile: z.string().required(), outputFile: z.string().required(),
  personaFile: z.string().required(), costFile: z.string().required(),
  repeats: z.number().min(2).max(5).required(), maxTokens: z.number().min(256).max(4096).required(),
})

interface Options {
  fixtureFile: string; outputFile: string; personaFile: string; costFile: string
  repeats: number; maxTokens: number
}

interface RecordedRun extends GradingRun {
  sessionId?: string
  model?: string
  elapsedMs: number
  usage: UsageSample
  attempts: { prompt: string; reply?: string; validationError?: string; error?: string }[]
}

async function run(ctx: Context, config: Options): Promise<number> {
  const fixtureText = fs.readFileSync(config.fixtureFile, 'utf8')
  const fixtures = validateGradingFixtures(JSON.parse(fixtureText))
  const persona = fs.readFileSync(config.personaFile, 'utf8').trim()
  const cost = loadCostConfig(fs.readFileSync(config.costFile, 'utf8'))
  // 固定阅卷角色，不挂载课程插件；评测作答不能调用工具或读取期望分数。
  ;(ctx.get('systemPrompt') as SystemPrompt).section({ name: 'tutor-eval:persona', order: 0, text: persona, complete: true })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), tools: [], contexts: [] }))
  ;(ctx.get('tools') as { guard: (fn: () => string) => unknown }).guard(() => '固定样本判分评测禁止工具调用')
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: config.maxTokens }))
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
      settings: { repeats: config.repeats, maxTokens: config.maxTokens, independentSessions: true,
        tools: false, model: models, temperature: 'provider-default', titleGeneration: false },
      usage, cost: { currency: cost.currency, estimated,
        rates: Object.fromEntries(models.map(model => [model, ratesForModel(cost, model)])),
        actualBill: null, basis: 'config/cost.yaml 估算，缓存按普通输入单价；不是实际账单。含 Harness 已报告的失败尝试，异常请求可能有未报告用量。' },
      summary: summarizeGrading(fixtures, runs, config.repeats), runs,
    }
    fs.writeFileSync(`${config.outputFile}.tmp`, JSON.stringify(report, null, 2) + '\n')
    fs.renameSync(`${config.outputFile}.tmp`, config.outputFile)
    return report
  }
  save()
  for (let repeat = 0; repeat < config.repeats; repeat++) {
    for (const suite of fixtures.suites) {
      process.stdout.write(`评测 ${suite.title}，独立会话 ${repeat + 1}/${config.repeats}…\n`)
      const recorded: RecordedRun = { suiteId: suite.id, repeat, elapsedMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 }, attempts: [] }
      runs.push(recorded)
      save()
      const start = Date.now()
      let chat: AgentChat | null = null
      try {
        chat = await createAgentChat(ctx)
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
        process.stderr.write(`评测中止：${recorded.error}\n`)
        return 1
      }
      process.stdout.write(`完成：${recorded.gradings!.length} 个样本，${recorded.attempts.length} 次生成，${recorded.elapsedMs} ms\n`)
    }
  }
  status = 'completed'
  const report = save()
  process.stdout.write(`\n区间命中 ${report.summary.inRangeSamples}/${report.summary.expectedSamples}；稳定样本 ${report.summary.stableCases}/${report.summary.cases.length}\n`)
  process.stdout.write(`token：输入 ${report.usage.inputTokens}，输出 ${report.usage.outputTokens}；估算 ${cost.currency}${report.cost.estimated.toFixed(4)}（非账单）\n`)
  return report.summary.passed ? 0 : 2
}

export function apply(ctx: Context, config: Options): void {
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  run(ctx, config).then(code => { process.stdin.destroy(); exit(code) }).catch(error => {
    process.stderr.write(`评测失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy(); exit(1)
  })
}
