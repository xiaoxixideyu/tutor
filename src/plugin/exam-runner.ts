import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { applyExamMastery, computeExamResult, EXAM_PASS_SCORE, gradeObjective, nextMilestone, paperTotalPoints, paperValid, updatePlanExamRecord, validateSubjectiveGradings, type ExamGrading, type ExamPaper, type ExamQuestion } from '../core/exam.ts'
import type { KnowledgeMap, Mastery, Plan, Profile } from '../core/schema.ts'
import { currentNode } from '../core/lesson.ts'
import { formatChoice } from '../core/assessment.ts'
import { createAgentChat } from './agent-chat.ts'
import { printSessionTotal } from './cost-line.ts'
import { createLineReader } from './line-reader.ts'
import { generateTurn, parseJsonBlock, trySchema } from './generation.ts'
import { examContent, mapContent, planContent } from '../core/content-quality.ts'
import { createContentGate, generateApproved } from './content-gate.ts'
import { profileScope } from '../core/interview.ts'

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

function buildExamPrompt(milestone: { id: string; title: string; nodes: string[] }, map: KnowledgeMap, profile: Profile): string {
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
    `全课程目标与排除项（可能含后续课，不能据此扩大本里程碑考查范围）：${profileScope(profile)}`,
    `现有基础：${profile.background || '未填写'}`,
    '',
    '要求：',
    '- 全卷共 4-10 题，覆盖全部里程碑知识点；按范围分配客观题（选择题 4 项、或唯一简短答案），全部围绕核心事实与应用',
    '- 只考上面列出的里程碑知识点及其验收目标；全课程目标中的后续课内容不属于本次考查范围',
    '- 学员明确的范围与排除项优先于知识点摘要和常见扩展；不得为凑题数引入未学或已排除的内容',
    '- 最后 1 道综合性主观题，直接对应里程碑标题的验收目标（如"能写出并发安全的 worker pool"就要求写出/描述完整方案）；主观题给参考答案与 keywords（判分关键词）',
    '- 题目难度对齐里程碑验收（偏向综合与应用，不是背概念）',
    '- 输出前逐题独立求解并核对参考答案；所有数值、边界与检查条件都要在本题成立，不能机械套用公式（例如事件有重叠时，概率之和未必等于 1）',
    '- points：客观题 1 分/题，主观题 2 分',
    '',
    '输出 JSON（```json 代码块）：',
    '{"milestone": "' + milestone.id + '", "questions": [{"id": "q1", "node": "知识点id", "type": "objective", "question": "…", "choices": ["A. …","B. …","C. …","D. …"], "answer": "B", "points": 1}, {"id": "qN", "node": "…", "type": "subjective", "question": "…", "answer": "参考答案", "keywords": ["关键词"], "points": 2}]}',
    '除该 JSON 外不要输出其他内容。',
  ].join('\n')
}

export function buildExamGradingPrompt(questions: ExamQuestion[], answers: Map<string, string>): string {
  const lines: string[] = ['任务：判分以下主观题作答。', '评分只覆盖题干明确要求；不因遗漏参考答案中的额外细节扣分。独立核对计算与逻辑，发现参考答案错误时按正确内容评分并说明。', '']
  for (const q of questions) {
    lines.push(`题目 ${q.id}（满分 ${q.points}）：${q.question}`)
    lines.push(`参考答案：${q.answer}`)
    lines.push(`关键词：${(q.keywords ?? []).join('、') || '（无，按参考答案判）'}`)
    lines.push(`学员作答：${answers.get(q.id) ?? ''}`)
    lines.push('')
  }
  lines.push('输出判分 JSON（```json 代码块）。每题 score 必须是 0–1 的得分比例，不乘题目分值；必须逐题返回且不得重复或遗漏题号。')
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
  const profile = store.read(config.courseId, 'profile') as Profile
  const gate = createContentGate(ctx, store, config.courseId)
  await gate.require(mapContent(map, profile))
  await gate.require(planContent(plan, profile, map))
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
  const paper = await generateApproved<ExamPaper>(chat, buildExamPrompt(milestone, map, profile), (text) => {
    const data = parseJsonBlock(text)
    if (!data.ok) return data
    const schemaResult = trySchema(ExamPaperSchema, data.value)
    if (!schemaResult.ok) return schemaResult
    if ((schemaResult.value as ExamPaper).milestone !== milestone.id) return { ok: false, error: '试卷里程碑不匹配' }
    const invalid = paperValid(schemaResult.value as ExamPaper, milestone.nodes)
    if (invalid) return { ok: false as const, error: invalid }
    return schemaResult
  }, gate, value => examContent(value, profile, map, milestone))

  const totalPoints = paperTotalPoints(paper)
  out.write(`试卷就绪：${paper.questions.length} 题，满分 ${totalPoints}（客观题规则判分，主观题模型判分）。\n\n`)
  const gradings: ExamGrading[] = []
  const subjectiveAnswers = new Map<string, string>()
  let index = 0
  for (const question of paper.questions) {
    index++
    out.write(`【第 ${index}/${paper.questions.length} 题 · ${question.node} · ${question.points} 分】\n${question.question}\n`)
    for (const [i, choice] of (question.choices ?? []).entries()) out.write(`  ${formatChoice(choice, i)}\n`)
    // 与 learn-runner 对齐：读取前吐出独立一行 `>` 哨兵，让 Web 端（exam.html）据此退出 busy、
    // 把选项渲染成可点 chips、放开输入。CLI 端只多一行提示，无害。
    out.write('\n> ')
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
    try {
      const validated = await generateTurn(chat, buildExamGradingPrompt(subjectiveQuestions, subjectiveAnswers), (text) => {
        const parsed = parseJsonBlock(text)
        return parsed.ok ? validateSubjectiveGradings(parsed.value, subjectiveQuestions) : parsed
      }) as ExamGrading[]
      gradings.push(...validated)
    } catch (error) {
      await chat.flush()
      throw new Error(`主观题判分失败，成绩与掌握度未修改：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await chat.flush()

  const { score, passed } = computeExamResult(paper, gradings)
  out.write(`\n大考成绩：${score}（${passed ? '通过' : `未过，需 ≥ ${EXAM_PASS_SCORE}`}）\n`)
  for (const grading of gradings) {
    const note = grading.note ? `（${grading.note}）` : ''
    const points = paper.questions.find((q) => q.id === grading.questionId)!.points
    out.write(`  ${grading.score > 0 ? '✓' : '✗'} ${grading.questionId}：${Math.round(grading.score * points * 100) / 100}/${points}${note}\n`)
  }

  const updatedMastery = applyExamMastery(paper, gradings, mastery ?? {}, today())
  store.write(config.courseId, 'mastery', updatedMastery)

  const updatedPlan = updatePlanExamRecord(plan, milestone.id, { date: today(), score, passed })
  updatedPlan.current = currentNode(updatedPlan, updatedMastery, map) ?? undefined
  store.write(config.courseId, 'plan', updatedPlan)

  out.write(`里程碑 ${milestone.id}：${passed ? '通过，已记录' : '未通过，指针回退到薄弱节点（补救课）'}\n`)
  out.write(updatedPlan.current ? `计划指针：${updatedPlan.current}\n` : '课程完成。\n')
  printSessionTotal(chat, out)
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
