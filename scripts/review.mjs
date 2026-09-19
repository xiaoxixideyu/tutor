#!/usr/bin/env node
// tutor 复习壳：到期知识点的复习小测（零模型调用，规则判分；设计 §3 环节6 一期简化算法）
// 用法：npm run agent -- review <课程名>
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CourseStore } from '../src/core/store.ts'
import { dueReviews, pickReviewQuestions } from '../src/core/review.ts'
import { applyReviewResult, judgeQuizAnswer } from '../src/core/assessment.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const store = new CourseStore(process.env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses'))
const out = process.stdout

function today() {
  return new Date().toISOString().slice(0, 10)
}

function answerText(q) {
  return (q.choices?.length ?? 0) > 0 ? q.answer.trim().toUpperCase() : q.answer
}

const [, , , courseId] = process.argv
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(courseId)) {
  process.stderr.write('用法：npm run agent -- review <课程名>\n')
  process.exit(1)
}
if (!store.exists(courseId) || !store.has(courseId, 'mastery')) {
  process.stderr.write(`tutor: 课程 "${courseId}" 不存在或尚未产生掌握度记录\n`)
  process.exit(1)
}

const mastery = store.read(courseId, 'mastery')
const due = dueReviews(mastery, today())
if (due.length === 0) {
  out.write('没有到期的复习。到期后会在这里出现（间隔 1/3/7/14 天阶梯）。\n')
  process.exit(0)
}

const hasBank = store.has(courseId, 'question-bank')
const bank = hasBank ? store.read(courseId, 'question-bank') : {}
out.write(`今日复习 ${due.length} 个知识点（${due.map((d) => d.node).join('、')}）。每点 2 题，规则判分。\n`)

const rl = readline.createInterface({ input: process.stdin, terminal: false })
const lineQueue = []
let lineWaiter = null
let stdinClosed = false
rl.on('line', (line) => {
  if (lineWaiter) {
    const resolve = lineWaiter
    lineWaiter = null
    resolve(line)
  } else {
    lineQueue.push(line)
  }
})
rl.on('close', () => {
  stdinClosed = true
  if (lineWaiter) {
    const resolve = lineWaiter
    lineWaiter = null
    resolve(null)
  }
})
const readAnswer = () =>
  new Promise((resolve) => {
    if (lineQueue.length > 0) return resolve(lineQueue.shift())
    if (stdinClosed) return resolve(null)
    lineWaiter = resolve
  })

let done = 0
for (const review of due) {
  const questions = pickReviewQuestions(bank, review.node)
  if (questions.length === 0) {
    out.write(`\n【${review.node}】题库缺失，跳过（可重跑 assess 重建题库）。\n`)
    continue
  }
  out.write(`\n【${review.node}】\n`)
  let correct = 0
  for (const [index, question] of questions.entries()) {
    out.write(`\n复习题 ${index + 1}/${questions.length}：${question.question}\n`)
    for (const choice of question.choices ?? []) out.write(`  ${choice}\n`)
    const answer = await readAnswer()
    if (!answer || !answer.trim()) {
      out.write('复习中止，进度未变。\n')
      rl.close()
      process.exit(0)
    }
    const ok = judgeQuizAnswer(question, answer)
    correct += ok ? 1 : 0
    out.write(ok ? '✓ 正确\n' : `✗ 错误（正确答案：${answerText(question)}）\n`)
  }
  const score = Math.round((correct / questions.length) * 100) / 100
  const updated = applyReviewResult(mastery, review.node, score, today())
  mastery[review.node] = updated[review.node]
  const entry = mastery[review.node]
  out.write(
    `→ ${review.node}：${entry.status}${entry.score !== undefined ? `（${entry.score}）` : ''}${entry.review_due !== undefined ? `，下次复习 ${entry.review_due}` : ''}\n`
  )
  store.write(courseId, 'mastery', mastery)
  done += 1
}
rl.close()
out.write(`\n复习完成（${done}/${due.length}）。\n`)
process.exit(0)
