#!/usr/bin/env node
// tutor 实践壳（薄壳）：学员在 workdir 写代码、跑规则化测试（零模型，判分在核心）。
// 用法：npm run agent -- practice <课程名> [--node <知识点>]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCliIO } from '../src/flows/io.ts'
import { runFlowInProcess } from '../src/flows/run.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
// 兼容 agent.mjs 旧转发格式：practice.mjs practice <课程名> --node <知识点>
const args = argv[0] === 'practice' ? argv.slice(1) : argv
const courseId = args[0] ?? ''
const rest = args.slice(1)
const nodeIndex = rest.indexOf('--node')
const nodeId = nodeIndex >= 0 ? rest[nodeIndex + 1] : undefined
if (nodeIndex >= 0 && !nodeId) {
  process.stderr.write('--node 需要知识点 id\n')
  process.exit(1)
}
const code = await runFlowInProcess({ kind: 'practice', courseId, ...(nodeId ? { nodeId } : {}) }, createCliIO(), { root, env: process.env })
process.exit(code)
