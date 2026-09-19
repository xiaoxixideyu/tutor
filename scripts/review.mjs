#!/usr/bin/env node
// tutor 复习壳：到期知识点的复习小测（零模型调用，规则判分；设计 §3 环节6 强化复习 SM-2 简化版）
// 用法：npm run agent -- review <课程名> ｜ npm run agent -- review --all（跨课程到期汇总）
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CourseStore, COURSE_ID_PATTERN } from '../src/core/store.ts'
import { dueReviews, pickReviewQuestions, postponeReview } from '../src/core/review.ts'
import { listDueReviews } from '../src/core/summary.ts'
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

const [, , command, argument] = process.argv
if (command !== 'review' || (argument !== '--all' && !COURSE_ID_PATTERN.test(argument ?? ''))) {
  process.stderr.write('用法：npm run agent -- review <课程名> ｜ npm run agent -- review --all\n')
  process.exit(1)
}

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

// 单课程复习：返回完成的题目组数（知识点数）
async function reviewCourse(courseId) {
  if (!store.exists(courseId) || !store.has(courseId, 'mastery')) {
    process.stderr.write(`tutor: 课程 "${courseId}" 不存在或尚未产生掌握度记录\n`)
    process.exit(1)
  }
  const mastery = store.read(courseId, 'mastery')
  const due = dueReviews(mastery, today())
  if (due.length === 0) {
    out.write('没有到期的复习。到期后会在这里出现（间隔 1/3/7/14 天阶梯）。\n')
    return 0
  }
  const hasBank = store.has(courseId, 'question-bank')
  const bank = hasBank ? store.read(courseId, 'question-bank') : {}
  out.write(`今日复习 ${due.length} 个知识点（${due.map((d) => d.node).join('、')}）。每点 2 题，规则判分。\n`)

  let done = 0
  for (const review of due) {
    const questions = pickReviewQuestions(bank, review.node)
    if (questions.length === 0) {
      // 题库缺失：顺延 1 天并落盘——不改掌握状态，保证"跳过"有痕迹且次日重试（可重跑 assess 重建题库）
      const postponed = postponeReview(mastery, review.node, today())
      mastery[review.node] = postponed[review.node]
      store.write(courseId, 'mastery', mastery)
      out.write(`\n【${review.node}】题库缺失，顺延至明天（可重跑 assess 重建题库）。\n`)
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
  return done
}

const courseIds = argument === '--all' ? listDueReviews(store, today()).map((c) => c.id) : [argument]
if (courseIds.length === 0) {
  out.write('所有课程都没有到期的复习。\n')
  process.exit(0)
}
let total = 0
for (const courseId of courseIds) {
  if (argument === '--all') out.write(`\n== ${courseId} ==\n`)
  total += await reviewCourse(courseId)
}
rl.close()
out.write(`\n复习完成（${total} 个知识点）。\n`)
