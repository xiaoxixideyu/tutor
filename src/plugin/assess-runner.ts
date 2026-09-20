import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AssessmentEngine } from '../core/assessment.ts'
import { topoOrder, validateBank } from '../core/knowledge.ts'
import { KnowledgeMapSchema, QuestionBankSchema, type AssessmentState, type KnowledgeMap, type Profile, type Question, type QuestionBank } from '../core/schema.ts'
import { createAgentChat } from './agent-chat.ts'
import { createLineReader } from './line-reader.ts'
import { generateTurn, parseJsonBlock, trySchema } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'

const name = 'tutor-assess-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({ courseId: z.string().required() })

interface StoreView {
  root: string
  exists(id: string): boolean
  has(id: string, kind: string): boolean
  read(id: string, kind: string): unknown
  write(id: string, kind: string, data: unknown): void
  remove(id: string, kind: string): void
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function mapPrompt(profile: Profile): string {
  return [
    '任务 1/2：生成知识地图。',
    '',
    '学员档案：',
    `- 学习目的：${profile.goal}`,
    `- 现有基础：${profile.background || '未填写'}`,
    `- 讲解偏好：${profile.style || '未填写'}`,
    `- 每日投入：${profile.daily_minutes ? `${profile.daily_minutes} 分钟` : '未填写'}`,
    '',
    '请输出知识地图 JSON（```json 代码块）：',
    '- verified: false（未联网验证）',
    '- nodes: 6-10 个知识点对象 {id, title, summary}，id 用小写英文连字符（如 goroutines、channels），按学习进阶排列',
    '- edges: 依赖对数组，格式 [知识点, 前置知识点]',
    '- resources: 空数组',
  ].join('\n')
}

function bankPrompt(map: KnowledgeMap): string {
  const nodes = topoOrder(map)
    .map((id) => {
      const node = map.nodes.find((n) => n.id === id)
      return `${id}（${node?.title ?? id}）`
    })
    .join('、')
  return [
    '任务 2/2：生成摸底题库。需覆盖以下知识点：',
    nodes,
    '',
    '对每个知识点出恰好 3 道题，难度 1（基础概念）/ 2（简单应用）/ 3（综合分析）各一道，客观题为主：约三分之二选择题、其余简答题。',
    '输出 JSON（```json 代码块）：以知识点 id 为键，值为题目数组，每题字段：',
    '- id: 唯一题号（如 "goroutines-d2"）',
    '- difficulty: 1 或 2 或 3',
    '- type: "choice" 或 "short"',
    '- question: 题干（中文，自然表述，不出现编号，不泄露答案）',
    '- choices: 仅选择题，恰好 4 个选项字符串',
    '- answer: 选择题为 A-D 字母；简答题为唯一简短答案',
    '- accept: 仅简答题，可接受的等价答案列表',
    '所有知识点都必须出现在 JSON 中。',
  ].join('\n')
}

function answerText(q: Question): string {
  return q.type === 'choice' ? q.answer.trim().toUpperCase() : q.answer
}

async function runQuiz(store: StoreView, courseId: string, engine: AssessmentEngine, map: KnowledgeMap): Promise<void> {
  const out = process.stdout
  const readAnswer = createLineReader(process.stdin)
  const titles = new Map(map.nodes.map((n) => [n.id, n.title]))
  while (true) {
    if (!engine.advanceNode()) break
    const node = engine.state.current_node
    out.write(`\n【知识点：${node} · ${titles.get(node) ?? ''}】\n`)
    while (true) {
      const current = engine.nextQuestion()
      if (!current) break
      const q = current.question
      out.write(`\n（难度 ${q.difficulty}，第 ${current.askedCount + 1} 题）${q.question}\n`)
      if (q.type === 'choice') {
        for (const choice of q.choices ?? []) out.write(`  ${choice}\n`)
        out.write('（回答选项字母）\n')
      }
      const answer = await readAnswer()
      if (!answer || !answer.trim()) {
        store.write(courseId, 'assessment', engine.state)
        throw new Error('未收到作答——进度已保存，重新运行 assess 即可继续')
      }
      const { correct } = engine.submitAnswer(answer)
      out.write(correct ? '✓ 正确\n' : `✗ 错误（正确答案：${answerText(q)}）\n`)
      store.write(courseId, 'assessment', engine.state)
    }
    engine.finalizeNode()
  }
}

async function run(ctx: Context, config: { courseId: string }): Promise<void> {
  const courseState = ctx.get('courseState') as { store: StoreView } | undefined
  if (!courseState) throw new Error('tutor: 核心服务未就绪')
  const store = courseState.store
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  const out = process.stdout
  if (!store.exists(config.courseId)) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    process.stdin.destroy()
  exit(1)
    return
  }
  const profile = store.read(config.courseId, 'profile') as Profile
  const chat = await createAgentChat(ctx)
  if (!chat) throw new Error('tutor: 模型会话创建失败')

  if (!store.has(config.courseId, 'knowledge-map')) {
    out.write('正在生成知识地图（可稍后用 research 联网升级为带来源版本）…\n')
    const mapValue = await generateTurn(chat, mapPrompt(profile), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      return trySchema(KnowledgeMapSchema, data.value)
    })
    store.write(config.courseId, 'knowledge-map', mapValue)
  }
  const map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
  out.write(`知识地图就绪：${map.nodes.length} 个知识点。\n`)

  if (!store.has(config.courseId, 'question-bank')) {
    out.write('正在生成摸底题库…\n')
    const bankValue = await generateTurn(chat, bankPrompt(map), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      const schemaResult = trySchema(QuestionBankSchema, data.value)
      if (!schemaResult.ok) return schemaResult
      const bankError = validateBank(schemaResult.value as QuestionBank, map.nodes.map((n) => n.id))
      if (bankError) return { ok: false as const, error: bankError }
      return schemaResult
    })
    store.write(config.courseId, 'question-bank', bankValue)
  }
  const bank = store.read(config.courseId, 'question-bank') as QuestionBank

  const resumed = store.has(config.courseId, 'assessment')
  const state = resumed ? (store.read(config.courseId, 'assessment') as AssessmentState) : AssessmentEngine.create(topoOrder(map))
  const engine = new AssessmentEngine(bank, state)
  out.write(resumed ? '检测到未完成的摸底，从上次进度继续。\n' : '摸底测评开始（每知识点最多 3 题，答对加深、答错收窄；随时 Ctrl-C 中断，进度已保存）。\n')
  await runQuiz(store, config.courseId, engine, map)

  const learner = engine.buildLearnerProfile(today())
  store.write(config.courseId, 'learner-profile', learner)
  store.write(config.courseId, 'mastery', engine.buildMastery())
  store.remove(config.courseId, 'assessment')
  out.write(`\n摸底完成。${learner.summary}\n能力画像已写入 ${store.root}/${config.courseId}/learner-profile.yaml\n`)
  await chat.flush()
  printSessionTotal(chat, out)
  process.stdin.destroy()
  exit(0)
}

export function apply(ctx: Context, config: { courseId: string }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-assess-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy()
  exit(1)
  })
}

export { name, inject, Config }
