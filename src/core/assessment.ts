import type { AssessmentState, LearnerProfile, LessonPractice, Mastery, Question, QuestionBank } from './schema.ts'

export const MAX_QUESTIONS_PER_NODE = 3

function normalizeAnswer(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s，。,.;；:：!！?？"'“”‘’（）()[\]【】]+/g, '')
}

export function judgeAnswer(q: Question, raw: string): boolean {
  const answer = normalizeAnswer(raw)
  if (!answer) return false
  if (q.type === 'choice') {
    const letter = q.answer.trim().toLowerCase()
    if (/^[a-d]$/.test(answer)) return answer === letter
    const index = 'abcd'.indexOf(letter)
    const choiceText = q.choices?.[index]
    if (choiceText === undefined) return false
    const bareText = choiceText.replace(/^[a-d][.、,，:：\)）]?\s*/i, '')
    return normalizeAnswer(choiceText) === answer || normalizeAnswer(bareText) === answer
  }
  return [q.answer, ...(q.accept ?? [])].some((candidate) => normalizeAnswer(candidate) === answer)
}

function scoreForNode(asked: { difficulty: 1 | 2 | 3; correct: boolean }[]): number {
  let earned = 0
  let possible = 0
  for (const a of asked) {
    possible += a.difficulty
    if (a.correct) earned += a.difficulty
  }
  if (possible === 0) return 0
  return Math.round((earned / possible) * 100) / 100
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export class AssessmentEngine {
  readonly bank: QuestionBank
  readonly state: AssessmentState
  private askedIds = new Map<string, Set<string>>()

  constructor(bank: QuestionBank, state: AssessmentState) {
    this.bank = bank
    this.state = state
    for (const record of state.asked) {
      if (!this.askedIds.has(record.node)) this.askedIds.set(record.node, new Set())
      this.askedIds.get(record.node)!.add(record.qid)
    }
  }

  static create(nodeOrder: string[]): AssessmentState {
    return { node_order: [...nodeOrder], current_node: nodeOrder[0] ?? '', asked: [], scores: {} }
  }

  private nodeQuestions(node: string): Question[] {
    return [...(this.bank[node] ?? [])].sort((a, b) => a.difficulty - b.difficulty)
  }

  private nodeAsked(node: string): { difficulty: 1 | 2 | 3; correct: boolean }[] {
    return this.state.asked.filter((a) => a.node === node).map((a) => ({ difficulty: a.difficulty, correct: a.correct }))
  }

  hasBank(node: string): boolean {
    return (this.bank[node]?.length ?? 0) > 0
  }

  isFinished(): boolean {
    return this.nextUnassessedIndex() === -1
  }

  private nextUnassessedIndex(): number {
    const start = this.state.node_order.indexOf(this.state.current_node)
    const order = start < 0 ? this.state.node_order.map((n, i) => i) : this.state.node_order.map((n, i) => i).filter((i) => i >= start)
    for (const i of order) {
      const node = this.state.node_order[i]
      if (node in this.state.scores) continue
      if (!this.hasBank(node)) continue
      return i
    }
    return -1
  }

  advanceNode(): boolean {
    const next = this.nextUnassessedIndex()
    if (next === -1) return false
    this.state.current_node = this.state.node_order[next]
    return true
  }

  finalizeNode(): void {
    const node = this.state.current_node
    if (node in this.state.scores) return
    const asked = this.nodeAsked(node)
    if (asked.length === 0) return
    this.state.scores[node] = scoreForNode(asked)
  }

  nextQuestion(): { node: string; question: Question; askedCount: number } | null {
    const node = this.state.current_node
    if (node in this.state.scores) return null
    const questions = this.nodeQuestions(node)
    const asked = this.askedIds.get(node) ?? new Set<string>()
    const history = this.nodeAsked(node)
    if (questions.length === 0 || asked.size >= MAX_QUESTIONS_PER_NODE || asked.size >= questions.length) return null
    let target: 1 | 2 | 3 = 2
    if (history.length > 0) {
      const last = history[history.length - 1]
      target = (last.correct ? last.difficulty + 1 : last.difficulty - 1) as 1 | 2 | 3
      target = Math.min(3, Math.max(1, target)) as 1 | 2 | 3
    }
    const unasked = questions.filter((q) => !asked.has(q.id))
    const picked =
      unasked.find((q) => q.difficulty === target) ??
      [...unasked].sort((a, b) => Math.abs(a.difficulty - target) - Math.abs(b.difficulty - target) || a.difficulty - b.difficulty)[0]
    if (!picked) return null
    return { node, question: picked, askedCount: history.length }
  }

  submitAnswer(raw: string): { correct: boolean } {
    const node = this.state.current_node
    const current = this.nextQuestion()
    if (!current) throw new Error('assessment: 当前没有待答题目')
    const correct = judgeAnswer(current.question, raw)
    this.state.asked.push({ node, qid: current.question.id, difficulty: current.question.difficulty, correct })
    if (!this.askedIds.has(node)) this.askedIds.set(node, new Set())
    this.askedIds.get(node)!.add(current.question.id)
    const earlyStop =
      (!correct && current.question.difficulty === 1) ||
      (correct && this.nodeAsked(node).some((a) => !a.correct && a.difficulty > current.question.difficulty))
    const done =
      earlyStop ||
      this.askedIds.get(node)!.size >= MAX_QUESTIONS_PER_NODE ||
      (correct && current.question.difficulty === 3) ||
      this.nextQuestion() === null
    if (done) this.state.scores[node] = scoreForNode(this.nodeAsked(node))
    return { correct }
  }

  buildLearnerProfile(assessedAt: string): LearnerProfile {
    const nodes: LearnerProfile['nodes'] = {}
    for (const record of this.state.asked) {
      const key = record.node
      const score = this.state.scores[key]
      if (score === undefined || key in nodes) continue
      const evidence = this.state.asked
        .filter((a) => a.node === key)
        .map((a) => `d${a.difficulty}${a.correct ? '✓' : '✗'}`)
        .join(' ')
      nodes[key] = { score, evidence }
    }
    return { assessed_at: assessedAt, nodes, summary: buildSummary(nodes) }
  }

  buildMastery(): Mastery {
    const mastery: Mastery = {}
    for (const node of this.state.node_order) {
      const score = this.state.scores[node]
      if (!this.hasBank(node)) {
        mastery[node] = { status: 'unknown' }
      } else if (score === undefined) {
        mastery[node] = { status: 'unknown' }
      } else if (score >= 0.8) {
        mastery[node] = { status: 'mastered', score }
      } else if (score >= 0.5) {
        mastery[node] = { status: 'learning', score }
      } else {
        mastery[node] = { status: 'weak', score }
      }
    }
    return mastery
  }
}

export function buildSummary(nodes: LearnerProfile['nodes']): string {
  const entries = Object.entries(nodes)
  if (entries.length === 0) return '本次未评估任何知识点。'
  const strong = entries.filter(([, v]) => v.score >= 0.7).map(([k]) => k)
  const medium = entries.filter(([, v]) => v.score >= 0.4 && v.score < 0.7).map(([k]) => k)
  const weak = entries.filter(([, v]) => v.score < 0.4).map(([k]) => k)
  const parts: string[] = [`共评估 ${entries.length} 个知识点`]
  if (strong.length > 0) parts.push(`较强：${strong.join('、')}`)
  if (medium.length > 0) parts.push(`一般：${medium.join('、')}`)
  if (weak.length > 0) parts.push(`薄弱：${weak.join('、')}`)
  return parts.join('；') + '。'
}

export function statusForScore(score: number): 'mastered' | 'learning' | 'weak' {
  if (score >= 0.8) return 'mastered'
  if (score >= 0.5) return 'learning'
  return 'weak'
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function judgeQuizAnswer(item: LessonPractice, raw: string): boolean {
  const question: Question =
    (item.choices?.length ?? 0) > 0
      ? { id: 'quiz', difficulty: 2, type: 'choice', question: item.question, choices: item.choices, answer: item.answer }
      : { id: 'quiz', difficulty: 2, type: 'short', question: item.question, answer: item.answer, accept: item.accept }
  return judgeAnswer(question, raw)
}

export function updateMasteryForNode(mastery: Mastery | undefined, node: string, quizScore: number, today: string): Mastery {
  const previous = mastery?.[node]
  const status = statusForScore(quizScore)
  const reviewDue =
    status === 'weak' ? undefined : addDays(today, previous?.review_due !== undefined ? 3 : 1)
  return {
    ...mastery,
    [node]: {
      status,
      score: quizScore,
      ...(reviewDue !== undefined ? { review_due: reviewDue } : {}),
    },
  }
}
