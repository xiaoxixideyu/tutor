#!/usr/bin/env node
// 评测子进程入口：在进程内运行判分/内容/课程阶段评测（保留父进程的超时与日志监督）。
// 用法：node scripts/eval-runner.mjs <grading|content|course> <options.json>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCliIO } from '../src/flows/io.ts'
import { runFlowInProcess } from '../src/flows/run.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [mode, optionsFile] = process.argv.slice(2)
if (!mode || !optionsFile) throw new Error('用法：eval-runner.mjs <grading|content|course> <options.json>')
const options = JSON.parse(fs.readFileSync(optionsFile, 'utf8'))
const io = createCliIO()

let code = 1
if (mode === 'grading') {
  const { runGradingEval } = await import('../src/eval/grading-runner.ts')
  code = await runGradingEval({ ...options, root, env: process.env, out: io.out, err: io.err })
} else if (mode === 'content') {
  const { runContentEval } = await import('../src/eval/content-runner.ts')
  code = await runContentEval({ ...options, root, env: process.env, out: io.out, err: io.err })
} else if (mode === 'course') {
  const observe = (event) => fs.appendFileSync(options.observerFile, JSON.stringify(event) + '\n')
  code = await runFlowInProcess(
    { kind: options.kind, courseId: options.courseId, ...(options.nodeId ? { nodeId: options.nodeId } : {}), ...(options.milestoneId ? { milestoneId: options.milestoneId } : {}) },
    io, { root, env: process.env, workspace: options.workspace, observe, maxModelRequests: 24 })
} else {
  throw new Error(`未知评测模式 "${mode}"`)
}
process.exit(code)
