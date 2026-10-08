import type { Mastery, Plan } from './schema.ts'
import { updateMasteryForNode } from './assessment.ts'

export const EXAM_PASS_SCORE = 0.7

export interface ExamQuestion {
  id: string
  node: string
  type: 'objective' | 'subjective'
  question: string
  choices?: string[]
  answer: string
  accept?: string[]
  keywords?: string[]
  points: number
}

export interface ExamPaper {
  milestone: string
  questions: ExamQuestion[]
}

export interface ExamGrading {
  questionId: string
  correct: boolean
  score: number // 统一为 0–1；题目权重仅在汇总时乘 points
  note?: string
}

export function paperValid(paper: ExamPaper, milestoneNodes: string[]): string | null {
  if (!Array.isArray(paper.questions) || paper.questions.length < 4 || paper.questions.length > 10) {
    return `题目数需 4-10，当前 ${paper.questions?.length ?? 0}`
  }
  const ids = new Set<string>()
  for (const q of paper.questions) {
    if (!q.id.trim() || ids.has(q.id)) return `题号 ${q.id} 为空或重复`
    ids.add(q.id)
    if (!milestoneNodes.includes(q.node)) return `题目 ${q.id} 的知识点 ${q.node} 不在里程碑内`
    if (!Number.isFinite(q.points) || q.points <= 0) return `题目 ${q.id} 的 points 非法`
    if (q.type === 'objective') {
      if ((q.choices?.length ?? 0) > 0 && q.choices!.length !== 4) return `题目 ${q.id} 的选项数不是 4`
      if (!q.answer.trim()) return `题目 ${q.id} 缺参考答案`
      if (q.choices?.length && !/^[a-d]$/i.test(q.answer.trim())) return `题目 ${q.id} 的答案不是 A-D 字母`
    } else if (!q.answer.trim() && (q.keywords?.length ?? 0) === 0) {
      return `主观题 ${q.id} 缺参考答案与关键词`
    }
  }
  if (milestoneNodes.some((node) => !paper.questions.some((q) => q.node === node))) return '试卷未覆盖全部里程碑知识点'
  return null
}

export function paperTotalPoints(paper: ExamPaper): number {
  return paper.questions.reduce((sum, q) => sum + q.points, 0)
}

export function gradeObjective(q: ExamQuestion, raw: string): ExamGrading {
  if ((q.choices?.length ?? 0) > 0) {
    const letter = q.answer.trim().toLowerCase()
    const normalized = raw.trim().toLowerCase()
    const correct = /^[a-d]$/.test(normalized) ? normalized === letter : false
    return { questionId: q.id, correct, score: correct ? 1 : 0 }
  }
  const normalize = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[\s，。,.;；:：!！?？"'“”‘’（）()[\]【】]+/g, '')
  const answer = normalize(raw)
  const candidates = [q.answer, ...(q.accept ?? [])].map(normalize)
  const correct = answer !== '' && candidates.includes(answer)
  return { questionId: q.id, correct, score: correct ? 1 : 0 }
}

export function validateSubjectiveGradings(data: unknown, questions: ExamQuestion[]):
  { ok: true; value: ExamGrading[] } | { ok: false; error: string } {
  const raw = data && typeof data === 'object' ? (data as { gradings?: unknown }).gradings : undefined
  if (!Array.isArray(raw)) return { ok: false, error: 'gradings 必须是数组' }
  const expected = new Set(questions.map((q) => q.id))
  const seen = new Set<string>()
  const value: ExamGrading[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !expected.has(item.questionId) || seen.has(item.questionId)) {
      return { ok: false, error: '判分包含未知或重复题号' }
    }
    if (typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) {
      return { ok: false, error: `题目 ${item.questionId} 的 score 必须是 0–1 的有限数值` }
    }
    seen.add(item.questionId)
    value.push({ questionId: item.questionId, score: item.score, correct: item.score >= EXAM_PASS_SCORE,
      ...(typeof item.note === 'string' ? { note: item.note } : {}) })
  }
  if (seen.size !== expected.size) return { ok: false, error: '判分遗漏了主观题' }
  return { ok: true, value }
}

function gradingById(paper: ExamPaper, grading: ExamGrading[]): Map<string, ExamGrading> {
  const checked = validateSubjectiveGradings({ gradings: grading }, paper.questions)
  if (!checked.ok) throw new Error(checked.error)
  return new Map(checked.value.map((g) => [g.questionId, g]))
}

export function computeExamResult(paper: ExamPaper, grading: ExamGrading[]): { score: number; passed: boolean } {
  const byId = gradingById(paper, grading)
  const totalPoints = paperTotalPoints(paper)
  const earned = paper.questions.reduce((sum, q) => sum + byId.get(q.id)!.score * q.points, 0)
  const score = totalPoints > 0 ? Math.round((earned / totalPoints) * 100) / 100 : 0
  return { score, passed: score >= EXAM_PASS_SCORE }
}

// 每个知识点先按题目分值汇总，再更新一次，避免题序覆盖结果或一场考试连升多阶。
export function applyExamMastery(paper: ExamPaper, grading: ExamGrading[], mastery: Mastery, today: string): Mastery {
  const byId = gradingById(paper, grading)
  const totals = new Map<string, { earned: number; possible: number }>()
  for (const q of paper.questions) {
    const total = totals.get(q.node) ?? { earned: 0, possible: 0 }
    total.earned += byId.get(q.id)!.score * q.points
    total.possible += q.points
    totals.set(q.node, total)
  }
  let updated = { ...mastery }
  for (const [node, total] of totals) {
    updated = updateMasteryForNode(updated, node, Math.round(total.earned / total.possible * 100) / 100, today)
  }
  return updated
}

export function updatePlanExamRecord(plan: Plan, milestoneId: string, record: { date: string; score: number; passed: boolean }): Plan {
  const milestones = plan.milestones.map((m) =>
    m.id === milestoneId ? { ...m, exam_date: record.date, exam_score: record.score, exam_passed: record.passed } : m
  )
  return { ...plan, milestones }
}

export function nextMilestone(plan: Plan, mastery: Mastery): { id: string; title: string; nodes: string[] } | null {
  for (const milestone of plan.milestones) {
    if (milestone.exam_passed) continue
    const allMastered = milestone.nodes.length > 0 && milestone.nodes.every((node) => mastery[node]?.status === 'mastered')
    if (allMastered) return milestone
  }
  return null
}
