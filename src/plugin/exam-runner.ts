import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { computeExamResult, EXAM_PASS_SCORE, gradeObjective, nextMilestone, paperTotalPoints, paperValid, updatePlanExamRecord, type ExamGrading, type ExamPaper, type ExamQuestion } from '../core/exam.ts'
import { extractProfileJson } from '../core/interview.ts'
import type { KnowledgeMap, Mastery, Plan } from '../core/schema.ts'
import { updateMasteryForNode } from '../core/assessment.ts'
import { createAgentChat, type AgentChat } from './agent-chat.ts'
import { createLineReader } from './line-reader.ts'
import { generateTurn, parseJsonBlock, trySchema } from './generation.ts'

const name = 'tutor-exam-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({ courseId: z.string().required(), milestoneId: z.string() })

interface StoreView {
  root: string
  exists(id: string): boolean
  has(id: string, kind: string): boolean
  read(id: string, kind: string): unknown
  write(id: string, kind: string, data: unknown): void
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

const ExamPaperSchema = z.object({
  milestone: z.string().required(),
  questions: z
    .array(
      z.object({
        id: z.string().required(),
        node: z.string().required(),
        type: z.union([z.const('objective'), z.const('subjective')]).required(),
        question: z.string().required(),
        choices: z.array(z.string()),
        answer: z.string().required(),
        accept: z.array(z.string()),
        keywords: z.array(z.string()),
        points: z.number().required(),
      })
    )
    .required(),
}) as unknown as Schema<unknown, ExamPaper>

function buildExamPrompt(milestone: { id: string; title: string; nodes: string[] }, map: KnowledgeMap): string {
  const nodeLines = milestone.nodes.map((id) => {
    const node = map.nodes.find((n) => n.id === id)
    return `- ${id}（${node?.title ?? id}）：${node?.summary ?? ''}`
  })
  return [
    `任务：为里程碑「${milestone.title}」出一份大考试卷（里程碑验收考）。`,
    '',
    '覆盖知识点：',
    ...nodeLines,
    '',
    '要求：',
    '- 每个知识点 1-2 道客观题（选择题 4 项、或唯一简短答案），全部围绕该知识点的核心事实与应用',
    '- 最后 1 道综合性主观题，直接对应里程碑标题的验收目标（如"能写出并发安全的 worker pool"就要求写出/描述完整方案）；主观题给参考答案与 keywords（判分关键词）',
    '- 题目难度对齐里程碑验收（偏向综合与应用，不是背概念）',
    '- points：客观题 1 分/题，主观题 2 分',
    '',
    '输出 JSON（```json 代码块）：',
    '{"milestone": "' + milestone.id + '", "questions": [{"id": "q1", "node": "知识点id", "type": "objective", "question": "…", "choices": ["A. …","B. …","C. …","D. …"], "answer": "B", "points": 1}, {"id": "qN", "node": "…", "type": "subjective", "question": "…", "answer": "参考答案", "keywords": ["关键词"], "points": 2}]}',
    '除该 JSON 外不要输出其他内容。',
  ].join('\n')
}

function gradePrompt(questions: ExamQuestion[], answers: Map<string, string>): string {
  const lines: string[] = ['任务：判分以下主观题作答。', '']
  for (const q of questions) {
    lines.push(`题目 ${q.id}（满分 ${q.points}）：${q.question}`)
    lines.push(`参考答案：${q.answer}`)
    lines.push(`关键词：${(q.keywords ?? []).join('、') || '（无，按参考答案判）'}`)
    lines.push(`学员作答：${answers.get(q.id) ?? ''}`)
    lines.push('')
  }
  lines.push('输出判分 JSON（```json 代码块）。')
  return lines.join('\n')
}

async function run(ctx: Context, config: { courseId: string; milestoneId: string }): Promise<void> {
  const courseState = ctx.get('courseState') as { store: StoreView } | undefined
  if (!courseState) throw new Error('tutor: 核心服务未就绪')
  const store = courseState.store
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  const out = process.stdout
  const readAnswer = createLineReader(process.stdin)
  if (!store.exists(config.courseId)) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 不存在\n`)
    process.stdin.destroy()
    exit(1)
    return
  }
  const plan = store.read(config.courseId, 'plan') as Plan
  const map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
  const mastery = store.has(config.courseId, 'mastery') ? (store.read(config.courseId, 'mastery') as Mastery) : undefined
  const milestone = config.milestoneId
    ? (plan.milestones.find((m) => m.id === config.milestoneId) ?? null)
    : nextMilestone(plan, mastery ?? {})
  if (!milestone) {
    process.stderr.write('tutor: 没有可考的里程碑（需全部节点已掌握且未通过过大考）。先完成学习与单元小测。\n')
    process.stdin.destroy()
    exit(1)
    return
  }
  out.write(`里程碑大考：${milestone.id}「${milestone.title}」\n覆盖 ${milestone.nodes.length} 个知识点。\n`)

  const chat = await createAgentChat(ctx)
  if (!chat) throw new Error('tutor: 模型会话创建失败')
  out.write('正在生成试卷…\n')
  const paper = (await generateTurn(chat, buildExamPrompt(milestone, map), (text) => {
    const data = parseJsonBlock(text)
    if (!data.ok) return data
    const schemaResult = trySchema(ExamPaperSchema, data.value)
    if (!schemaResult.ok) return schemaResult
    const invalid = paperValid(schemaResult.value as ExamPaper, milestone.nodes)
    if (invalid) return { ok: false as const, error: invalid }
    return schemaResult
  })) as ExamPaper

  const totalPoints = paperTotalPoints(paper)
  out.write(`试卷就绪：${paper.questions.length} 题，满分 ${totalPoints}（客观题规则判分，主观题模型判分）。\n\n`)
  const gradings: ExamGrading[] = []
  const subjectiveAnswers = new Map<string, string>()
  let index = 0
  for (const question of paper.questions) {
    index++
    out.write(`【第 ${index}/${paper.questions.length} 题 · ${question.node} · ${question.points} 分】\n${question.question}\n`)
    for (const choice of question.choices ?? []) out.write(`  ${choice}\n`)
    const answer = await readAnswer()
    if (!answer || !answer.trim()) {
      out.write('考试中止，未产生成绩（题卷不保存）。\n')
      process.stdin.destroy()
      exit(1)
      return
    }
    if (question.type === 'objective') {
      const grading = gradeObjective(question, answer)
      gradings.push(grading)
      out.write(grading.correct ? '✓ 正确\n' : `✗ 错误（正确答案：${(question.choices?.length ?? 0) > 0 ? question.answer.toUpperCase() : question.answer}）\n`)
    } else {
      subjectiveAnswers.set(question.id, answer.trim())
      out.write('已记录，稍后统一判分。\n')
    }
  }

  if (subjectiveAnswers.size > 0) {
    out.write('\n主观题判分中…\n')
    const subjectiveQuestions = paper.questions.filter((q) => q.type === 'subjective')
    const reply = await chat.ask(gradePrompt(subjectiveQuestions, subjectiveAnswers))
    const data = extractProfileJson(reply)
    const gradingsRaw = (data && typeof data === 'object' ? (data as { gradings?: unknown }).gradings : null) as
      | { questionId: string; score: number; note?: string }[]
      | null
    if (Array.isArray(gradingsRaw)) {
      for (const g of gradingsRaw) {
        if (typeof g.score === 'number') gradings.push({ questionId: g.questionId, correct: g.score >= EXAM_PASS_SCORE, score: g.score, ...(g.note ? { note: g.note } : {}) })
      }
    } else {
      for (const q of subjectiveQuestions) gradings.push({ questionId: q.id, correct: false, score: 0, note: '判分失败，计 0 分' })
    }
  }
  await chat.flush()

  const { score, passed } = computeExamResult(gradings, totalPoints)
  out.write(`\n大考成绩：${score}（${passed ? '通过' : `未过，需 ≥ ${EXAM_PASS_SCORE}`}）\n`)
  for (const grading of gradings) {
    const note = grading.note ? `（${grading.note}）` : ''
    out.write(`  ${grading.score > 0 ? '✓' : '✗'} ${grading.questionId}：${grading.score}${note}\n`)
  }

  const updatedMastery = mastery ? { ...mastery } : {}
  for (const question of paper.questions) {
    const grading = gradings.find((g) => g.questionId === question.id)
    if (!grading) continue
    const perNodeScore = Math.round(grading.score * 100) / 100
    const merged = updateMasteryForNode(updatedMastery, question.node, perNodeScore, today())
    updatedMastery[question.node] = merged[question.node]
  }
  store.write(config.courseId, 'mastery', updatedMastery)

  const updatedPlan = updatePlanExamRecord(plan, milestone.id, { date: today(), score, passed })
  if (!passed) {
    const weak = milestone.nodes.find((node) => updatedMastery[node]?.status !== 'mastered')
    if (weak) updatedPlan.current = weak
  }
  store.write(config.courseId, 'plan', updatedPlan)

  out.write(`里程碑 ${milestone.id}：${passed ? '通过，已记录' : '未通过，指针回退到薄弱节点（补救课）'}\n`)
  out.write(updatedPlan.current ? `计划指针：${updatedPlan.current}\n` : '课程完成。\n')
  process.stdin.destroy()
  exit(passed ? 0 : 1)
}

export function apply(ctx: Context, config: { courseId: string; milestoneId: string }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-exam-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy()
    exit(1)
  })
}

export { name, inject, Config }
