#!/usr/bin/env node
// 逐阶段交互验收：使用正式 runner、独立课程与会话日志，保留全部失败尝试（单进程直跑）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { COURSE_ID_PATTERN } from '../src/core/store.ts'
import { estimateCost, loadCostConfig, ratesForModel } from '../src/core/cost.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  live: { type: 'boolean' }, run: { type: 'string' }, node: { type: 'string' }, milestone: { type: 'string' },
  'timeout-ms': { type: 'string', default: '480000' },
} })
const [mode, courseId] = positionals
const modes = { new: ['interview', 'interview'], research: ['research', 'research'], assess: ['assess', 'assess'],
  plan: ['plan', 'plan'], learn: ['learn', 'teach'], 'practice-gen': ['practice-gen', 'practice-gen'], exam: ['exam', 'exam-grade'], 'audit-content': ['audit-content', 'exam-grade'] }
if (!values.live) {
  console.log('用法：node scripts/eval-course.mjs <new|research|assess|plan|learn|practice-gen|exam|practice|review|status|audit-content> <course> --live [--run data/evals/course-...] [--node id] [--milestone m1] [--timeout-ms 480000]')
  console.log('仅 --live 调用模型。每阶段默认 8 分钟（含等待输入，可设 1–20 分钟）、24 次业务请求、单次输出 8192 token；真实账单需另行核对。')
  process.exit(0)
}
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor !== 24 && nodeMajor !== 26 && !(nodeMajor === 22 && nodeMinor >= 19)) throw new Error('真实课程验收请使用 Node 24 LTS（或受支持的 22.19+/26）')
if (!COURSE_ID_PATTERN.test(courseId ?? '') || (!modes[mode] && !['practice', 'review', 'status'].includes(mode))) throw new Error('课程名或阶段非法')
const timeoutMs = Number(values['timeout-ms'])
if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 1_200_000) throw new Error('timeout-ms 必须为 60000–1200000 的整数')
if (values.node && !/^[a-z0-9][a-z0-9-]*$/.test(values.node)) throw new Error('node 非法')
const evalRoot = path.join(root, 'data/evals')
fs.mkdirSync(evalRoot, { recursive: true })
const run = values.run ? fs.realpathSync(path.resolve(values.run)) : fs.mkdtempSync(path.join(evalRoot, 'course-'))
if (!run.startsWith(fs.realpathSync(evalRoot) + path.sep)) throw new Error('验收目录必须在 data/evals 下')
const courseDir = path.join(run, courseId)
const workspace = path.join(courseDir, 'workspace')
const courses = path.join(courseDir, 'courses')
for (const dir of [workspace, courses, path.join(workspace, 'config')]) fs.mkdirSync(dir, { recursive: true })
fs.copyFileSync(path.join(root, 'config/cost.yaml'), path.join(workspace, 'config/cost.yaml'))
const stages = path.join(courseDir, 'stages')
fs.mkdirSync(stages, { recursive: true })
const stageDir = fs.mkdtempSync(path.join(stages, `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}-`))
const env = { ...process.env }
if (fs.existsSync(path.join(root, '.env'))) for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
  if (match && !(match[1] in env)) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
}
let args
if (modes[mode]) {
  for (const key of ['TUTOR_LLM_BASE_URL', 'TUTOR_LLM_API_KEY', 'TUTOR_LLM_MODEL']) if (!env[key]) throw new Error(`缺少 ${key}`)
  if (mode === 'research' && (!env.TUTOR_MCP_SEARCH_URL || !env.TUTOR_MCP_SEARCH_TOKEN)) throw new Error('教研需要配置搜索 MCP')
  const optionsFile = path.join(stageDir, 'options.json')
  fs.writeFileSync(optionsFile, JSON.stringify({ kind: mode, courseId, workspace, observerFile: path.join(stageDir, 'attempts.jsonl'),
    ...(values.node ? { nodeId: values.node } : {}), ...(values.milestone ? { milestoneId: values.milestone } : {}) }, null, 2) + '\n')
  args = [path.join(root, 'scripts/eval-runner.mjs'), 'course', optionsFile]
} else {
  args = [path.join(root, `scripts/${mode === 'status' ? 'view' : mode}.mjs`), mode, courseId, ...(values.node ? ['--node', values.node] : [])]
}
const report = { version: 1, courseId, stage: mode, model: env.TUTOR_LLM_MODEL, startedAt: new Date().toISOString(),
  run, status: 'running', runtime: { node: process.versions.node, platform: process.platform }, limits: { timeoutMs, maxRequests: 24, maxTokens: 8192 },
  settings: { officialRunner: true, titleGeneration: false, thinking: env.TUTOR_LLM_THINKING ?? 'provider-default', tools: mode === 'research' ? 'search-and-fetch' : 'none' } }
report.sourceHashes = Object.fromEntries([
  'scripts/eval-course.mjs', 'scripts/eval-runner.mjs', 'src/runtime/chat.ts', 'src/runtime/llm.ts', 'src/flows/generation.ts', 'config/cost.yaml',
  'src/flows/content-gate.ts',
  ...fs.readdirSync(path.join(root, 'src/core')).filter(file => file.endsWith('.ts')).map(file => `src/core/${file}`),
  ...fs.readdirSync(path.join(root, 'src/runtime')).filter(file => file.endsWith('.ts')).map(file => `src/runtime/${file}`),
  ...(modes[mode] ? [`src/flows/${modes[mode][0] === 'audit-content' ? 'audit-content' : modes[mode][0]}.ts`, `config/persona/${modes[mode][1]}.md`] : []),
  ...(!modes[mode] ? [`scripts/${mode === 'status' ? 'view' : mode}.mjs`] : []),
  ...(mode === 'practice' ? ['src/flows/practice-executor.ts'] : []),
].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
const save = () => fs.writeFileSync(path.join(stageDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
save()
console.log(`验收目录：${run}\n阶段记录：${stageDir}`)
const log = fs.createWriteStream(path.join(stageDir, 'runner.log'))
const inputLog = fs.createWriteStream(path.join(stageDir, 'input.txt'))
const child = spawn(process.execPath, args, { cwd: workspace, detached: true,
  env: { ...env, TUTOR_SESSIONS_ROOT: path.join(courseDir, 'sessions'), TUTOR_WORKSPACE: workspace, TUTOR_COURSES_ROOT: courses }, stdio: ['pipe', 'pipe', 'pipe'] })
process.stdin.on('data', chunk => { inputLog.write(chunk); child.stdin.write(chunk) })
process.stdin.on('end', () => child.stdin.end())
child.stdin.on('error', () => {})
child.stdout.on('data', chunk => { process.stdout.write(chunk); log.write(chunk) })
child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk) })
let forceTimer
const stop = reason => {
  report.error ??= reason
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  forceTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 3000)
}
const timer = setTimeout(() => stop(`阶段超过 ${timeoutMs / 60000} 分钟`), timeoutMs)
process.once('SIGINT', () => stop('收到 SIGINT 中断'))
process.once('SIGTERM', () => stop('进程终止'))
child.once('error', error => { report.error = error.message })
child.once('close', code => {
  clearTimeout(timer); clearTimeout(forceTimer)
  process.stdin.destroy(); log.end(); inputLog.end()
  report.exitCode = code; report.status = code === 0 && !report.error ? 'completed' : 'failed'
  report.elapsedMs = Date.now() - Date.parse(report.startedAt)
  const attemptsFile = path.join(stageDir, 'attempts.jsonl')
  const attempts = fs.existsSync(attemptsFile) ? fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  report.attempts = attempts
  const finished = new Set(attempts.filter(attempt => attempt.type === 'attempt').map(attempt => attempt.attemptId))
  report.unreportedAttempts = attempts.filter(attempt => (attempt.type === 'attempt' && !attempt.usage)
    || (attempt.type === 'attempt-start' && !finished.has(attempt.attemptId))).length
  report.usage = attempts.reduce((sum, attempt) => ({ inputTokens: sum.inputTokens + (attempt.usage?.inputTokens ?? 0), outputTokens: sum.outputTokens + (attempt.usage?.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 })
  const cost = loadCostConfig(fs.readFileSync(path.join(root, 'config/cost.yaml'), 'utf8'))
  const rates = ratesForModel(cost, env.TUTOR_LLM_MODEL)
  report.cost = { currency: cost.currency, rates, estimated: estimateCost(report.usage, rates), actualBill: null,
    basis: '已报告用量，包含失败尝试；未报告用量与实际网关账单未知。首块延迟可能是推理或元数据，不等于用户可见首字。' }
  if (fs.existsSync(path.join(courses, courseId))) fs.cpSync(path.join(courses, courseId), path.join(stageDir, 'course-snapshot'), { recursive: true, filter: source => !source.includes(`${path.sep}sandbox`) })
  save()
  console.log(`\n阶段结束：${report.status}，${report.elapsedMs} ms，估算 ${cost.currency}${report.cost.estimated.toFixed(4)}\n记录：${stageDir}/report.json`)
  process.exitCode = report.status === 'failed' ? (code || 1) : 0
})
