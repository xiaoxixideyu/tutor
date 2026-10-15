#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { validateGradingFixtures } from '../src/eval/grading.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { live: { type: 'boolean' }, help: { type: 'boolean' },
  repeats: { type: 'string', default: '3' }, 'max-tokens': { type: 'string', default: '2048' }, fixtures: { type: 'string' } } })
if (values.help) {
  console.log('npm run eval:grading -- [--live] [--repeats 3] [--max-tokens 2048] [--fixtures path]\n默认只校验固定样本；--live 才调用模型。输出 data/evals/<run>/report.json，退出码 0=通过，1=运行失败，2=质量未达标。')
  process.exit(0)
}
const repeats = Number(values.repeats)
const maxTokens = Number(values['max-tokens'])
if (!Number.isInteger(repeats) || repeats < 2 || repeats > 5) throw new Error('repeats 必须为 2–5 的整数')
if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 4096) throw new Error('max-tokens 必须为 256–4096 的整数')
const fixtureFile = path.resolve(values.fixtures ?? path.join(root, 'evals/grading.json'))
const fixtures = validateGradingFixtures(JSON.parse(fs.readFileSync(fixtureFile, 'utf8')))
const samples = fixtures.suites.reduce((sum, suite) => sum + suite.cases.length, 0)
console.log(`固定样本 ${samples} 个，领域 ${fixtures.suites.length} 个；${repeats} 轮共 ${samples * repeats} 次判分、${fixtures.suites.length * repeats} 个独立会话。`)
if (!values.live) { console.log('样本校验通过，未调用模型。'); process.exit(0) }
const major = Number(process.versions.node.split('.')[0])
if (major !== 24 && major !== 26 && !(major === 22 && Number(process.versions.node.split('.')[1]) >= 19)) throw new Error('真实评测请使用 Node 24 LTS（或受支持的 22.19+/26）')

const env = { ...process.env }
const envFile = path.join(root, '.env')
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
  if (match && !(match[1] in env)) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
}
for (const key of ['TUTOR_LLM_BASE_URL', 'TUTOR_LLM_API_KEY', 'TUTOR_LLM_MODEL']) if (!env[key]) throw new Error(`缺少 ${key}，见 .env.example`)
const runsRoot = path.join(root, 'data/evals')
fs.mkdirSync(runsRoot, { recursive: true })
const dir = fs.mkdtempSync(path.join(runsRoot, `grading-${new Date().toISOString().replace(/[:.]/g, '-')}-`))
const workspace = path.join(dir, 'workspace')
fs.mkdirSync(workspace)
const outputFile = path.join(dir, 'report.json')
const optionsFile = path.join(dir, 'options.json')
fs.writeFileSync(optionsFile, JSON.stringify({ fixtureFile, outputFile, repeats, maxTokens,
  personaFile: path.join(root, 'config/persona/exam-grade.md'), costFile: path.join(root, 'config/cost.yaml') }, null, 2) + '\n')
fs.writeFileSync(outputFile, JSON.stringify({ status: 'starting', startedAt: new Date().toISOString() }, null, 2) + '\n')
console.log(`评测目录：${dir}`)
const child = spawn(process.execPath, [path.join(root, 'scripts/eval-runner.mjs'), 'grading', optionsFile], {
  cwd: workspace, env: { ...env, TUTOR_SESSIONS_ROOT: path.join(dir, 'sessions'), TUTOR_WORKSPACE: workspace },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
const log = fs.createWriteStream(path.join(dir, 'runner.log'))
child.stdout.on('data', chunk => { process.stdout.write(chunk); log.write(chunk) })
child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk) })
let stopReason
let forceTimer
const stop = (reason) => {
  if (stopReason) return
  stopReason = reason
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* 已退出 */ }
    forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ } }, 5000)
  }
}
const timer = setTimeout(() => stop('评测超过 10 分钟上限'), 600_000)
process.once('SIGINT', () => stop('用户中断'))
process.once('SIGTERM', () => stop('进程终止'))
child.once('error', error => { stopReason = error.message })
child.once('close', code => {
  clearTimeout(timer)
  clearTimeout(forceTimer)
  log.end()
  const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
  if (stopReason || report.status === 'starting' || report.status === 'running') {
    report.status = 'failed'; report.error = stopReason ?? `评测进程退出（${code}）`
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(`报告：${outputFile}`)
  process.exitCode = stopReason || report.status === 'failed' ? 1 : (code ?? 1)
})
