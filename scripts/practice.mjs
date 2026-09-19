#!/usr/bin/env node
// tutor 实践壳：学员在 workdir 写代码、跑规则化测试（零模型，判分在核心；三期实践任务沙箱）
// 用法：npm run agent -- practice <课程名> [--node <知识点>]
import readline from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CourseStore } from '../src/core/store.ts'
import { currentNode } from '../src/core/lesson.ts'
import { judgePracticeTask, buildPracticeIntro } from '../src/core/practice.ts'
import { applyPracticeResult } from '../src/core/assessment.ts'
import { runTests, ensureStarterFiles } from '../src/plugin/practice-executor.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const store = new CourseStore(process.env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses'))
const out = process.stdout

function today() {
  return new Date().toISOString().slice(0, 10)
}

// 从测试命令提取已知工具并探测可用性（学员机器没装就给指引，不产生任务状态）
const KNOWN_TOOLS = { go: 'brew install go', node: 'brew install node', python3: 'xcode-select --install', cargo: 'brew install rust' }

function detectMissingTools(task) {
  const missing = []
  for (const test of task.tests) {
    for (const [tool, hint] of Object.entries(KNOWN_TOOLS)) {
      if (new RegExp(`\\b${tool}\\b`).test(test.command) && !missing.includes(tool)) {
        const probe = (() => {
          try {
            return require('node:child_process').spawnSync(tool, ['--version'], { stdio: 'ignore' })
          } catch {
            return { status: 127 }
          }
        })()
        if ((probe.error ?? probe.status === 127) || probe.error) missing.push(`${tool}（${hint}）`)
      }
    }
  }
  return missing
}

const [, , , courseId, ...rest] = process.argv
const nodeFlagIndex = rest.indexOf('--node')
const nodeOverride = nodeFlagIndex >= 0 ? rest[nodeFlagIndex + 1] : undefined
if (!courseId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(courseId)) {
  process.stderr.write('用法：npm run agent -- practice <课程名> [--node <知识点>]\n')
  process.exit(1)
}
if (!store.exists(courseId)) {
  process.stderr.write(`tutor: 课程 "${courseId}" 不存在，请先运行 npm run agent -- new ${courseId}\n`)
  process.exit(1)
}
if (!store.has(courseId, 'plan') || !store.has(courseId, 'practice')) {
  process.stderr.write(
    store.has(courseId, 'practice')
      ? `tutor: 课程 "${courseId}" 缺少教学计划，请先运行 npm run agent -- plan ${courseId}\n`
      : `tutor: 课程 "${courseId}" 还没有实践任务，请先运行 npm run agent -- practice-gen ${courseId}\n`
  )
  process.exit(1)
}

const plan = store.read(courseId, 'plan')
const mastery = store.has(courseId, 'mastery') ? store.read(courseId, 'mastery') : undefined
const node = nodeOverride ?? currentNode(plan, mastery)
if (!node) {
  out.write('计划内知识点均已掌握，无实践任务可做。\n')
  process.exit(0)
}

const practiceFile = store.read(courseId, 'practice')
const tasks = practiceFile.tasks.filter((t) => t.node === node)
if (tasks.length === 0) {
  out.write(`知识点 ${node} 还没有实践任务（当前 practice.yaml 只覆盖其他知识点）。请重新运行 practice-gen ${courseId}。\n`)
  process.exit(0)
}

// 多任务菜单 / 断点续做检测
const prevState = store.has(courseId, 'practice-state') ? store.read(courseId, 'practice-state') : null
let task = tasks[0]
if (tasks.length > 1) {
  out.write('本知识点有多个任务：\n')
  for (const [index, t] of tasks.entries()) {
    const marker = prevState && prevState.task_id === t.id ? '（上次进行中）' : ''
    out.write(`  ${index + 1}. ${t.title}${marker}\n`)
  }
  process.stdout.write('选择任务序号（回车默认 1）：')
  const rl0 = readline.createInterface({ input: process.stdin, terminal: false })
  const pick = await new Promise((resolve) => rl0.once('line', resolve))
  rl0.close()
  const pickIndex = Number.parseInt((pick ?? '').trim(), 10)
  if (pickIndex >= 2 && pickIndex <= tasks.length) task = tasks[pickIndex - 1]
}

if (detectMissingTools(task).length > 0) {
  out.write(`\n缺少运行本任务所需的工具，请先安装：\n`)
  for (const m of detectMissingTools(task)) out.write(`  - ${m}\n`)
  process.exit(1)
}

const workdir = path.join(store.root, courseId, 'sandbox', task.id)
ensureStarterFiles(task, workdir)
out.write(`\n${buildPracticeIntro(task, workdir)}\n`)
if (prevState && prevState.task_id === task.id && !prevState.done && prevState.done_tests.length > 0) {
  out.write(`（续做：上次已通过 ${prevState.done_tests.join('、')}）\n`)
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
const readLine = () => new Promise((resolve) => rl.once('line', resolve))

let attempts = prevState?.task_id === task.id ? prevState.attempts : 0
while (true) {
  out.write('\n回车运行测试（r 重跑，q 中止保存进度）> ')
  const line = await readLine()
  const command = (line ?? '').trim()
  if (command === 'q') {
    out.write('进度已保存，重新运行 practice 即可续做。\n')
    process.exit(0)
  }
  if (command !== '' && command !== 'r') continue

  out.write('运行测试…\n')
  const rawResults = await runTests(task, workdir)
  const results = {}
  for (const [index, test] of task.tests.entries()) {
    results[test.name] = rawResults[index]
  }
  attempts += 1
  const judge = judgePracticeTask(task, results)
  for (const item of judge.perTest) {
    out.write(`  ${item.passed ? '✓' : '✗'} ${item.name}${item.passed ? '' : `（${item.detail}）`}\n`)
  }
  store.write(courseId, 'practice-state', {
    node,
    task_id: task.id,
    updated_at: today(),
    done_tests: judge.perTest.filter((i) => i.passed).map((i) => i.name),
    done: judge.done,
    attempts,
  })
  if (!judge.done) {
    out.write(`未全部通过（${judge.perTest.filter((i) => i.passed).length}/${task.tests.length}）。修改代码后再按回车。\n`)
    continue
  }
  const updatedMastery = applyPracticeResult(mastery ?? {}, node, judge.score, today())
  store.write(courseId, 'mastery', updatedMastery)
  const entry = updatedMastery[node]
  out.write(
    `\n实践完成！掌握度更新：${node} → ${entry.status}${entry.score !== undefined ? `（${entry.score}）` : ''}${entry.review_due !== undefined ? `，复习到期 ${entry.review_due}` : ''}\n`
  )
  out.write('可以回到课堂让导师点评你的实现：npm run agent -- learn ' + courseId + '\n')
  process.exit(0)
}
