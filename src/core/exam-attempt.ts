import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { COURSE_ID_PATTERN } from './store.ts'
import { applyExamMastery, computeExamResult, ExamPaperSchema, paperValid, updatePlanExamRecord, validateSubjectiveGradings, type ExamGrading, type ExamPaper } from './exam.ts'
import { currentNode } from './lesson.ts'
import { MasterySchema, PlanSchema, type KnowledgeMap, type Mastery, type Plan } from './schema.ts'

export interface ExamAttempt {
  id: string
  startedAt: string
  status: 'answering' | 'graded' | 'completed'
  contentKey: string
  paper: ExamPaper
  answers: Record<string, string>
  gradings?: ExamGrading[]
  result?: {
    date: string
    score: number
    passed: boolean
    before: { mastery: Mastery; plan: Plan }
    after: { mastery: Mastery; plan: Plan }
  }
}

export function newExamAttempt(paper: ExamPaper, contentKey: string): ExamAttempt {
  return { id: randomUUID(), startedAt: new Date().toISOString(), status: 'answering', contentKey, paper, answers: {} }
}

export class ExamAttemptStore {
  readonly file: string
  constructor(root: string, courseId: string) {
    if (!COURSE_ID_PATTERN.test(courseId)) throw new Error('非法课程 id')
    this.file = path.join(path.resolve(root), courseId, 'exam-attempt.json')
  }
  read(): ExamAttempt | undefined {
    if (!fs.existsSync(this.file)) return undefined
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ExamAttempt
      if (!value || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.startedAt !== 'string'
        || !['answering', 'graded', 'completed'].includes(value.status) || !/^[a-f0-9]{64}$/.test(value.contentKey)) throw new Error('考试断点元数据非法')
      value.paper = ExamPaperSchema(value.paper)
      const problem = paperValid(value.paper, [...new Set(value.paper.questions.map(q => q.node))])
      if (problem) throw new Error(problem)
      if (!value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers)
        || Object.entries(value.answers).some(([id, answer]) => !value.paper.questions.some(q => q.id === id) || typeof answer !== 'string' || !answer.trim())) throw new Error('考试作答记录非法')
      if (value.status === 'answering' && value.result) throw new Error('作答中的考试不能含提交记录')
      if (value.status !== 'answering') {
        if (value.paper.questions.some(q => !Object.hasOwn(value.answers, q.id))) throw new Error('考试作答不完整')
        const grades = validateSubjectiveGradings({ gradings: value.gradings }, value.paper.questions)
        if (!grades.ok) throw new Error(grades.error)
        value.gradings = grades.value
        if (!value.result || !/^\d{4}-\d{2}-\d{2}$/.test(value.result.date)
          || !Number.isFinite(value.result.score) || typeof value.result.passed !== 'boolean') throw new Error('考试提交记录缺失或非法')
        for (const state of [value.result.before, value.result.after]) {
          state.mastery = MasterySchema(state.mastery)
          state.plan = PlanSchema(state.plan)
        }
      }
      return value
    } catch (error) { throw new Error(`考试断点无法读取，原文件已保留：${error instanceof Error ? error.message : String(error)}`) }
  }
  save(attempt: ExamAttempt): void {
    const write = (file: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.${randomUUID()}.tmp`
      try { fs.writeFileSync(temp, JSON.stringify(attempt, null, 2) + '\n'); fs.renameSync(temp, file) }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
    }
    // 先归档再标记当前断点完成；归档失败仍可从 graded 恢复。
    if (attempt.status === 'completed') write(path.join(path.dirname(this.file), 'exams', `${attempt.id}.json`))
    write(this.file)
  }
}

interface LearningStore {
  has(id: string, kind: 'mastery'): boolean
  read(id: string, kind: 'mastery' | 'plan'): unknown
  write(id: string, kind: 'mastery' | 'plan', value: unknown): void
}

// 先保存目标状态，再写两份 YAML。任一写入中断后按同一目标补齐，不再次推进复习阶梯。
export function applyExamAttempt(attempt: ExamAttempt, attempts: ExamAttemptStore, store: LearningStore, courseId: string, map: KnowledgeMap, date: string): NonNullable<ExamAttempt['result']> {
  if (attempt.paper.questions.some(q => !Object.hasOwn(attempt.answers, q.id))) throw new Error('考试作答不完整，不能提交')
  const grades = validateSubjectiveGradings({ gradings: attempt.gradings }, attempt.paper.questions)
  if (!grades.ok) throw new Error(grades.error)
  const before = attempt.result?.before ?? {
    mastery: store.has(courseId, 'mastery') ? store.read(courseId, 'mastery') as Mastery : {},
    plan: store.read(courseId, 'plan') as Plan,
  }
  const result = computeExamResult(attempt.paper, grades.value)
  const completedOn = attempt.result?.date ?? date
  const mastery = applyExamMastery(attempt.paper, grades.value, before.mastery, completedOn)
  const plan = updatePlanExamRecord(before.plan, attempt.paper.milestone, { date: completedOn, ...result })
  plan.current = currentNode(plan, mastery, map) ?? undefined
  const expected = { date: completedOn, ...result, before, after: { mastery, plan } }
  // JSON/YAML 会省略 undefined；保存比较时使用同样的可序列化形态。
  const normalized = JSON.parse(JSON.stringify(expected)) as typeof expected
  if (attempt.result && !isDeepStrictEqual(attempt.result, normalized)) throw new Error('考试提交记录与试卷判分不一致，原断点已保留')
  if (attempt.status === 'completed') return normalized
  for (const kind of ['mastery', 'plan'] as const) {
    const current = kind === 'mastery' && !store.has(courseId, 'mastery') ? {} : store.read(courseId, kind)
    if (!isDeepStrictEqual(current, normalized.before[kind]) && !isDeepStrictEqual(current, normalized.after[kind])) throw new Error('考试提交期间课程状态发生变化，已保存成绩，请检查断点后继续')
  }
  attempt.gradings = grades.value; attempt.result = normalized; attempt.status = 'graded'; attempts.save(attempt)
  store.write(courseId, 'mastery', normalized.after.mastery)
  store.write(courseId, 'plan', normalized.after.plan)
  attempts.save({ ...attempt, status: 'completed' }); attempt.status = 'completed'
  return normalized
}
