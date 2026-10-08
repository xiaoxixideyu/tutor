#!/usr/bin/env node
// 每个冻结样本独立启动有界评测，避免整套样本共用十分钟而误伤后半段。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { validateContentFixtures } from '../src/eval/content.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { live: { type: 'boolean' }, fixtures: { type: 'string' }, repeats: { type: 'string', default: '2' }, cases: { type: 'string' } } })
const file = path.resolve(values.fixtures ?? path.join(root, 'evals/content-regressions.json'))
const source = fs.readFileSync(file, 'utf8')
const fixtures = validateContentFixtures(JSON.parse(source))
const selected = values.cases?.split(',').map(id => id.trim())
if (selected?.some(id => !fixtures.cases.some(item => item.id === id))) throw new Error('未知样本 id')
const cases = selected ? fixtures.cases.filter(item => selected.includes(item.id)) : fixtures.cases
const repeats = Number(values.repeats)
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('repeats 必须为 1–3')
if (!values.live) {
  console.log(`${cases.length} 个样本校验通过。加 --live 后逐例运行，每例 ${repeats} 轮，独立遵守十分钟/72 次请求上限。`)
  process.exit(0)
}
const runsRoot = path.join(root, 'data/evals')
fs.mkdirSync(runsRoot, { recursive: true })
const directory = fs.mkdtempSync(path.join(runsRoot, `content-suite-${new Date().toISOString().replace(/[:.]/g, '-')}-`))
const reportFile = path.join(directory, 'report.json')
const report = { status: 'running', startedAt: new Date().toISOString(), fixtureFile: file,
  fixtureHash: createHash('sha256').update(source).digest('hex'), repeats, selectedCases: cases.map(item => item.id), cases: [],
  summary: { correct: 0, expected: cases.length * repeats, passed: false },
  cost: { estimated: 0, actualBill: null, basis: '各子评测已报告用量的估算合计，包含失败；不是网关账单。' } }
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
let active
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; active?.kill('SIGTERM') })
console.log(`整套评测记录：${reportFile}`)
save()
for (const item of cases) {
  if (interrupted) break
  const entry = { id: item.id, status: 'running' }
  report.cases.push(entry); save()
  let output = ''
  const exitCode = await new Promise(resolve => {
    active = spawn(process.execPath, [path.join(root, 'scripts/eval-content.mjs'), '--live', '--fixtures', file,
      '--repeats', String(repeats), '--cases', item.id], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    active.stdout.on('data', chunk => { output += chunk.toString(); process.stdout.write(chunk) })
    active.stderr.on('data', chunk => process.stderr.write(chunk))
    active.once('error', error => { entry.error = error.message })
    active.once('close', code => resolve(code ?? 1))
  })
  active = undefined
  entry.status = exitCode === 0 ? 'passed' : 'failed'
  const childDirectory = output.match(/评测目录：([^\r\n]+)/)?.[1]
  if (childDirectory) {
    entry.reportFile = path.join(childDirectory, 'report.json')
    const child = JSON.parse(fs.readFileSync(entry.reportFile, 'utf8'))
    entry.summary = child.summary
    entry.cost = child.cost
    report.summary.correct += child.summary?.correct ?? 0
    report.cost.estimated += child.cost?.estimated ?? 0
  }
  save()
}
report.status = interrupted ? 'interrupted' : 'completed'
report.completedAt = new Date().toISOString()
report.summary.passed = report.cases.length === cases.length && report.cases.every(item => item.status === 'passed')
report.cost.estimated = Math.round(report.cost.estimated * 10000) / 10000
save()
console.log(`整套判断命中 ${report.summary.correct}/${report.summary.expected}；报告：${reportFile}`)
process.exitCode = report.summary.passed ? 0 : 2
