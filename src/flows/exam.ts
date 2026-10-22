import { EXAM_PASS_SCORE, ExamPaperSchema, examAdmission, gradeObjective, nextMilestone, paperTotalPoints, paperValid, validateSubjectiveGradings, type ExamGrading, type ExamPaper, type ExamQuestion } from '../core/exam.ts'
import { applyExamAttempt, ExamAttemptStore, newExamAttempt } from '../core/exam-attempt.ts'
import type { KnowledgeMap, Mastery, Plan, Profile } from '../core/schema.ts'
import { formatChoice } from '../core/assessment.ts'
import { printSessionTotal } from './cost-line.ts'
import { recordChatTotal } from './cost-ledger.ts'
import { generateTurn, parseJsonBlock, trySchema } from './generation.ts'
import { contentKey, examContent, mapContent, planContent } from '../core/content-quality.ts'
import { createContentGate, generateApproved } from './content-gate.ts'
import { profileScope } from '../core/interview.ts'
import { LearnerNotesStore } from '../core/learner-notes.ts'
import { appendMasteryEvent } from '../core/events.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'
import { requirePlanMapConsistency } from './consistency.ts'

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
    '- 全卷共 4-10 题，覆盖全部里程碑知识点；客观题只能四选一或单一数值填空（answer 仅整数、小数或分数，题干明确只填数值）。概念解释、代码和多个输出请改为选择题或主观题，不能要求自然语言解释再精确匹配整句。全部围绕核心事实与应用',
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

export async function runExam(deps: FlowDeps, config: { courseId: string; milestoneId?: string; discard?: boolean }): Promise<void> {
  const { store, io } = deps
  const milestoneIdInput = config.milestoneId ?? ''
  if (!store.exists(config.courseId)) {
    io.err(`tutor: 课程 "${config.courseId}" 不存在\n`)
    io.closeInput()
    throw new FlowExit(1)
  }
  if (config.discard) {
    const archived = new ExamAttemptStore(store.root, config.courseId).discard()
    io.out(archived ? `已放弃未完成的考试（原断点归档到 ${archived}）。\n` : '没有未完成的考试断点。\n')
    io.closeInput()
    throw new FlowExit(0)
  }
  const plan = store.read(config.courseId, 'plan') as Plan
  const map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
  const profile = store.read(config.courseId, 'profile') as Profile
  requirePlanMapConsistency(deps, config.courseId, plan, map)
  const gate = createContentGate(deps, config.courseId)
  await gate.require(mapContent(map, profile))
  await gate.require(planContent(plan, profile, map))
  const mastery = store.has(config.courseId, 'mastery') ? (store.read(config.courseId, 'mastery') as Mastery) : undefined
  const attempts = new ExamAttemptStore(store.root, config.courseId)
  const saved = attempts.read()
  let attempt = saved?.status !== 'completed' ? saved : undefined
  const milestoneId = milestoneIdInput || attempt?.paper.milestone
  // 显式指定里程碑也必须过准入闸（全掌握+未通过）；只有断点续考沿用原试卷的里程碑不做重复判定。
  let milestone: { id: string; title: string; nodes: string[] } | null = null
  if (milestoneId && !(attempt && attempt.paper.milestone === milestoneId)) {
    const admission = examAdmission(plan, mastery ?? {}, milestoneId)
    if ('error' in admission) {
      io.err(`tutor: ${admission.error}\n`)
      io.closeInput()
      throw new FlowExit(1)
    }
    milestone = admission.milestone
  } else {
    milestone = milestoneId
      ? (plan.milestones.find((m) => m.id === milestoneId) ?? null)
      : nextMilestone(plan, mastery ?? {})
  }
  if (!milestone) {
    io.err('tutor: 没有可考的里程碑（需全部节点已掌握且未通过过大考）。先完成学习与单元小测。\n')
    io.closeInput()
    throw new FlowExit(1)
  }
  io.out(`里程碑大考：${milestone.id}「${milestone.title}」\n覆盖 ${milestone.nodes.length} 个知识点。\n`)

  const chat = await deps.createChat({ retryOnLength: false })
  if (attempt) {
    if (attempt.paper.milestone !== milestone.id) throw new Error(`已有未完成的 ${attempt.paper.milestone} 考试，请先继续该考试`)
    const invalid = paperValid(attempt.paper, milestone.nodes)
    if (invalid) throw new Error(`已保存试卷不再适用，原作答已保留：${invalid}`)
    const input = examContent(attempt.paper, profile, map, milestone)
    if (!(await gate.review(input)).approved) throw new Error('已保存试卷未通过当前审查，作答保留，成绩与掌握度未修改')
    attempt.contentKey = contentKey(input); attempts.save(attempt)
    io.out(`恢复考试：已保存 ${Object.keys(attempt.answers).length}/${attempt.paper.questions.length} 题作答，继续未完成的作答或阅卷。\n`)
  } else {
    io.out('正在生成试卷…\n')
    const paper = await generateApproved<ExamPaper>(chat, buildExamPrompt(milestone, map, profile), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      const schemaResult = trySchema(ExamPaperSchema, data.value)
      if (!schemaResult.ok) return schemaResult
      if ((schemaResult.value as ExamPaper).milestone !== milestone.id) return { ok: false, error: '试卷里程碑不匹配' }
      const invalid = paperValid(schemaResult.value as ExamPaper, milestone.nodes)
      if (invalid) return { ok: false as const, error: invalid }
      return schemaResult
    }, gate, value => examContent(value, profile, map, milestone), { out: io.out })
    attempt = newExamAttempt(paper, contentKey(examContent(paper, profile, map, milestone)))
    attempts.save(attempt)
  }
  const paper = attempt.paper

  const totalPoints = paperTotalPoints(paper)
  io.out(`试卷就绪：${paper.questions.length} 题，满分 ${totalPoints}（客观题规则判分，主观题模型判分）。\n\n`)
  const gradings: ExamGrading[] = attempt.status === 'graded' ? attempt.gradings! : []
  const subjectiveAnswers = new Map<string, string>()
  let index = 0
  for (const question of paper.questions) {
    index++
    // pending 是上次暂停时保存的主观题草稿：它不算已完成作答，恢复后继续多行录入。
    const pending = attempt.pending?.questionId === question.id ? attempt.pending.answer : undefined
    if (Object.hasOwn(attempt.answers, question.id) && pending === undefined) {
      if (attempt.status !== 'graded') {
        if (question.type === 'objective') gradings.push(gradeObjective(question, attempt.answers[question.id]))
        else subjectiveAnswers.set(question.id, attempt.answers[question.id])
      }
      continue
    }
    io.out(`【第 ${index}/${paper.questions.length} 题 · ${question.node} · ${question.points} 分】\n${question.question}\n`)
    for (const [i, choice] of (question.choices ?? []).entries()) io.out(`  ${formatChoice(choice, i)}\n`)
    if (question.type === 'objective') {
      // 与 learn 对齐：读取前吐出独立一行 `>` 哨兵，让 Web 端（exam.html）据此退出 busy、
      // 把选项渲染成可点 chips、放开输入。CLI 端只多一行提示，无害。
      io.out('\n> ')
      const answer = await io.readLine()
      if (!answer || !answer.trim() || answer.trim() === '/exit') {
        io.out('考试暂停，试卷与已作答均已保存；重新运行 exam 继续。本次尚未产生成绩。\n')
        recordChatTotal(deps.costs, chat, 'exam-paused')
        io.closeInput()
        throw new FlowExit(0)
      }
      attempt.answers[question.id] = answer.trim()
      attempts.save(attempt)
      const grading = gradeObjective(question, answer)
      gradings.push(grading)
      io.out(grading.correct ? '✓ 正确\n' : `✗ 错误（正确答案：${(question.choices?.length ?? 0) > 0 ? question.answer.toUpperCase() : question.answer}）\n`)
      continue
    }
    // 主观题答案（如完整程序）天然多行：持续读取直到出现单独一行 `.`（提交）或 `/exit`（暂停）。
    // 暂停只写 pending 草稿，不能写进 answers；否则再次运行会把半截答案当成最终答案。
    let lines: string[]
    if (pending !== undefined) {
      lines = pending.split('\n')
      io.out('（继续上次未提交的主观题作答；输入单独一行 . 提交，/exit 暂停）\n')
    } else {
      io.out('\n> ')
      const answer = await io.readLine()
      if (!answer || !answer.trim() || answer.trim() === '/exit') {
        io.out('考试暂停，试卷与已作答均已保存；重新运行 exam 继续。本次尚未产生成绩。\n')
        recordChatTotal(deps.costs, chat, 'exam-paused')
        io.closeInput()
        throw new FlowExit(0)
      }
      lines = [answer.trim()]
      io.out('（可逐行输入多行；输入单独一行 . 提交，/exit 暂停）\n')
    }
    for (;;) {
      io.out('\n> ')
      const extra = await io.readLine()
      if (extra === null || extra.trim() === '/exit') {
        attempt.pending = { questionId: question.id, answer: lines.join('\n') }
        attempts.save(attempt)
        io.out('考试暂停，试卷与主观题草稿均已保存；重新运行 exam 从本题继续。本次尚未产生成绩。\n')
        recordChatTotal(deps.costs, chat, 'exam-paused')
        io.closeInput()
        throw new FlowExit(0)
      }
      if (extra?.trim() === '.') break
      if (extra !== undefined && extra !== '') lines.push(extra)
    }
    const merged = lines.join('\n')
    attempt.answers[question.id] = merged
    delete attempt.pending
    attempts.save(attempt)
    subjectiveAnswers.set(question.id, merged)
    io.out('已记录，稍后统一判分。\n')
  }

  if (subjectiveAnswers.size > 0) {
    io.out('\n主观题判分中…\n')
    const subjectiveQuestions = paper.questions.filter((q) => q.type === 'subjective')
    try {
      const validated = await generateTurn(chat, buildExamGradingPrompt(subjectiveQuestions, subjectiveAnswers), (text) => {
        const parsed = parseJsonBlock(text)
        return parsed.ok ? validateSubjectiveGradings(parsed.value, subjectiveQuestions) : parsed
      }) as ExamGrading[]
      gradings.push(...validated)
    } catch (error) {
      await chat.flush()
      throw new Error(`主观题判分失败，作答已保存，成绩与掌握度未修改：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await chat.flush()

  attempt.gradings = gradings
  const { score, passed, date, after } = applyExamAttempt(attempt, attempts, store, config.courseId, map, deps.today())
  // 事件流与错因档案：按节点记录成绩、客观题错答留档；辅助数据失败不影响成绩展示（事件按 key 去重）。
  try {
    const notes = new LearnerNotesStore(store.root, config.courseId)
    const byNode = new Map<string, { earned: number; possible: number }>()
    for (const question of paper.questions) {
      const grading = gradings.find((item) => item.questionId === question.id)
      if (!grading) continue
      const total = byNode.get(question.node) ?? { earned: 0, possible: 0 }
      total.earned += grading.score * question.points
      total.possible += question.points
      byNode.set(question.node, total)
    }
    for (const [nodeId, total] of byNode) {
      appendMasteryEvent(store.root, config.courseId, { key: `exam:${attempt.id}:${nodeId}`, at: date, node: nodeId, kind: 'exam', score: Math.round(total.earned / total.possible * 100) / 100, passed })
    }
    const wrongByNode = new Map<string, { question: string; your: string; answer: string }[]>()
    for (const question of paper.questions) {
      const grading = gradings.find((item) => item.questionId === question.id)
      if (!grading || grading.correct || question.type !== 'objective') continue
      const list = wrongByNode.get(question.node) ?? []
      const correctAnswer = (question.choices?.length ?? 0) > 0 ? question.answer.toUpperCase() : question.answer
      list.push({ question: question.question, your: attempt.answers[question.id] ?? '', answer: correctAnswer })
      wrongByNode.set(question.node, list)
    }
    for (const [nodeId, items] of wrongByNode) notes.recordErrors(nodeId, items, date, 'exam')
  } catch { /* 辅助数据写入失败忽略 */ }
  io.out(`\n大考成绩：${score}（${passed ? '通过' : `未过，需 ≥ ${EXAM_PASS_SCORE}`}）\n`)
  for (const grading of gradings) {
    const note = grading.note ? `（${grading.note}）` : ''
    const points = paper.questions.find((q) => q.id === grading.questionId)!.points
    io.out(`  ${grading.correct ? '✓' : '✗'} ${grading.questionId}：${Math.round(grading.score * points * 100) / 100}/${points}${note}\n`)
  }

  io.out(`里程碑 ${milestone.id}：${passed ? '通过，已记录' : '未通过，指针回退到薄弱节点（补救课）'}\n`)
  io.out(after.plan.current ? `计划指针：${after.plan.current}\n` : '课程完成。\n')
  recordChatTotal(deps.costs, chat, 'exam')
  printSessionTotal(chat, deps)
  io.closeInput()
  throw new FlowExit(passed ? 0 : 1)
}
