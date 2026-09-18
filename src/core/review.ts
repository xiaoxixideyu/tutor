import type { Mastery, Question, QuestionBank } from './schema.ts'

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
