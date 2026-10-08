import { it } from 'node:test'
import assert from 'node:assert/strict'
import { judgeAnswer, judgeQuizAnswer } from '../src/core/assessment.ts'
import { gradeObjective, paperValid, type ExamQuestion } from '../src/core/exam.ts'
import { validateLessonDraft } from '../src/core/lesson.ts'
import { validateBank } from '../src/core/knowledge.ts'
import { contentIssues, lessonContent, type ContentReview } from '../src/core/content-quality.ts'
import { matchesRuleAnswer, numericAnswer } from '../src/core/rule-grading.ts'
import type { LessonDraft, QuestionBank } from '../src/core/schema.ts'

// 2026-10-08 真实网页：正确回答“复制了切片头（指针、长度和容量），没有复制底层数组”
// 被整句匹配判错。保留原题及原参考，修复的是出题准入，不向 accept 回填这次作答。
const openQuestion = {
  question: '用一句话说明：a 是 []int 时执行 b := a，这一步到底复制了什么？',
  answer: '只复制了切片头——指向底层数组的指针、长度和容量；底层数组本身没有被复制，a 和 b 共享同一段存储。',
}
const draft: LessonDraft = {
  node: 'sharing', title: '切片共享', hook: '观察元素变化', structure: ['切片赋值'], example: 'b := a',
  practice: [openQuestion], quiz: [openQuestion, { question: 'len([]int{1,2}) 是多少？只填数值。', answer: '2' }],
}

it('解释题不能进入规则小测，课堂开放练习和四选一仍可用', () => {
  const result = validateLessonDraft(draft)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /规则判分题/)
  assert.equal(validateLessonDraft({ ...draft, quiz: [
    { question: '切片赋值复制什么？', choices: ['切片头', '整个数组', '全部元素', '没有复制'], answer: 'A' }, draft.quiz[1],
  ] }).ok, true)
})

it('模型误批或旧回执也不能让解释题通过规则小测准入', () => {
  const input = lessonContent(draft, { goal: '切片赋值与共享' }, { verified: false, nodes: [{ id: 'sharing', title: '切片共享' }], edges: [] })
  const review: ContentReview = { units: input.units.map(unit => ({ id: unit.id, scope: 'pass', correctness: 'pass', explanation: '内容语义正确', arithmetic: [], assertions: [] })) }
  assert.ok(contentIssues(input, [], review).some(issue => issue.startsWith('quiz:0：规则判分题')))
  assert.ok(contentIssues(input, [], review).every(issue => !issue.startsWith('practice:')))
})

it('同一解释题在题库与客观大考中受限，主观大考可按含义评分', () => {
  const bank: QuestionBank = { sharing: [1, 2, 3].map((difficulty, index) => ({ ...openQuestion, id: `q${index}`, type: 'short', difficulty: difficulty as 1 | 2 | 3 })) }
  assert.match(validateBank(bank, ['sharing']) ?? '', /规则判分题/)
  const objective: ExamQuestion = { ...openQuestion, id: 'q0', node: 'sharing', type: 'objective', points: 1 }
  const others: ExamQuestion[] = [1, 2, 3].map(index => ({ id: `q${index}`, node: 'sharing', type: 'objective', question: '1+1？只填数值。', answer: '2', points: 1 }))
  assert.match(paperValid({ milestone: 'm1', questions: [objective, ...others] }, ['sharing']) ?? '', /规则判分题/)
  assert.equal(paperValid({ milestone: 'm1', questions: [{ ...objective, type: 'subjective' }, ...others] }, ['sharing']), null)
})

it('三个规则判分入口均接受等价分数，拒绝小数点丢失与错误值', () => {
  const item = { question: '概率是多少？只填数值。', answer: '1/2' }
  const graders = [
    (raw: string) => judgeQuizAnswer(item, raw),
    (raw: string) => judgeAnswer({ ...item, id: 'q', type: 'short', difficulty: 1 }, raw),
    (raw: string) => gradeObjective({ ...item, id: 'q', node: 'die', type: 'objective', points: 1 }, raw).correct,
  ]
  for (const grade of graders) {
    for (const value of ['1/2', '2/4', '0.5', ' 3 / 6 ']) assert.equal(grade(value), true, value)
    for (const value of ['05', '5', '1/3', '0.05', '', '1/0', '0.5 或 1', '0.5不对']) assert.equal(grade(value), false, value)
  }
  assert.equal(matchesRuleAnswer('05', ['0.5']), false)
  assert.equal(judgeAnswer({ ...item, id: 'q', type: 'choice', difficulty: 1, choices: ['0.5', '5', '1', '0'], answer: 'A' }, '05'), false)
})

it('数值填写不执行表达式或代码，长度与除零有界', () => {
  for (const value of ['1/0', '1+1', 'process.exit()', '1'.repeat(257), '1 2', 'NaN', 'Infinity']) assert.equal(numericAnswer(value), undefined)
  assert.equal(numericAnswer('-2/4'), '-1/2')
})
