import { addDays } from './assessment.ts'
import { createHash } from 'node:crypto'
import type { Mastery, MasteryEntry, Question, QuestionBank } from './schema.ts'

// 相同状态与题目对应同一次复习；状态或题库变化后，旧页面的提交必须重新取题。
export function reviewAttemptId(courseId: string, node: string, entry: MasteryEntry, questions: Question[]): string {
  return createHash('sha256').update(JSON.stringify([courseId, node, entry, questions])).digest('hex')
}

export interface DueReview {
  node: string
  stage: number
  review_due: string
}

export function dueReviews(mastery: Mastery, today: string): DueReview[] {
  return Object.entries(mastery)
    .filter(([, entry]) => entry.review_due !== undefined && entry.review_due <= today)
    .map(([node, entry]) => ({ node, stage: entry.review_stage ?? 1, review_due: entry.review_due! }))
    .sort((a, b) => a.review_due.localeCompare(b.review_due))
}

export function pickReviewQuestions(bank: QuestionBank, node: string): Question[] {
  const questions = [...(bank[node] ?? [])].sort((a, b) => a.difficulty - b.difficulty)
  const mid = questions.filter((q) => q.difficulty === 2)
  const hard = questions.filter((q) => q.difficulty === 3)
  const rest = questions.filter((q) => q.difficulty !== 2 && q.difficulty !== 3)
  return [...(mid.slice(0, 1)), ...(hard.slice(0, 1)), ...rest].slice(0, 2)
}

// 题库缺失时的顺延：不改 status/score/stage，仅把 review_due 推迟 1 天——保证"跳过"有痕迹且次日重试
export function postponeReview(mastery: Mastery, node: string, today: string): Mastery {
  const entry = mastery[node]
  if (!entry || entry.review_due === undefined) return mastery
  return { ...mastery, [node]: { ...entry, review_due: addDays(today, 1) } }
}
