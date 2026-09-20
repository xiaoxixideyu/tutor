import type { Mastery, Plan } from './schema.ts'

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
  score: number
  note?: string
}

export function paperValid(paper: ExamPaper, milestoneNodes: string[]): string | null {
  if (!Array.isArray(paper.questions) || paper.questions.length < 4 || paper.questions.length > 10) {
    return `题目数需 4-10，当前 ${paper.questions?.length ?? 0}`
  }
  for (const q of paper.questions) {
    if (!milestoneNodes.includes(q.node)) return `题目 ${q.id} 的知识点 ${q.node} 不在里程碑内`
    if (q.points <= 0) return `题目 ${q.id} 的 points 非法`
    if (q.type === 'objective') {
      if ((q.choices?.length ?? 0) > 0 && q.choices!.length !== 4) return `题目 ${q.id} 的选项数不是 4`
    } else if (!q.answer.trim() && (q.keywords?.length ?? 0) === 0) {
      return `主观题 ${q.id} 缺参考答案与关键词`
    }
  }
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

export function computeExamResult(grading: ExamGrading[], totalPoints: number): { score: number; passed: boolean } {
  const earned = grading.reduce((sum, g) => sum + g.score, 0)
  const score = totalPoints > 0 ? Math.round((earned / totalPoints) * 100) / 100 : 0
  return { score, passed: score >= EXAM_PASS_SCORE }
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
    const allMastered = milestone.nodes.every((node) => mastery[node]?.status === 'mastered')
    if (allMastered) return milestone
  }
  return null
}
