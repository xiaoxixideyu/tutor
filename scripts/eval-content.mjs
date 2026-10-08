#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import yaml from 'yaml'
import { validateContentFixtures } from '../src/eval/content.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { live: { type: 'boolean' }, help: { type: 'boolean' }, fixtures: { type: 'string' },
  repeats: { type: 'string', default: '2' }, 'max-tokens': { type: 'string', default: '8192' }, cases: { type: 'string' } } })
if (values.help) {
  console.log('npm run eval:content -- [--live] [--repeats 2] [--cases id1,id2] [--fixtures path] [--max-tokens 8192]\n默认只校验固定样本；--live 才调用模型。每次上限 10 分钟/72 个模型请求。退出码 0=通过，1=运行失败，2=质量未达标。')
  process.exit(0)
}
const repeats = Number(values.repeats)
const maxTokens = Number(values['max-tokens'])
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('repeats 必须为 1–3 的整数')
if (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 8192) throw new Error('max-tokens 必须为 1024–8192 的整数')
const fixtureFile = path.resolve(values.fixtures ?? path.join(root, 'evals/content-regressions.json'))
const fixtures = validateContentFixtures(JSON.parse(fs.readFileSync(fixtureFile, 'utf8')))
const cases = values.cases?.split(',') ?? []
if (cases.some(id => !fixtures.cases.some(item => item.id === id)) || new Set(cases).size !== cases.length) throw new Error('cases 包含未知或重复 id')
console.log(`固定内容样本 ${cases.length || fixtures.cases.length} 个，${repeats} 轮；预期标签不会进入模型请求。`)
if (!values.live) { console.log('样本校验通过，未调用模型。'); process.exit(0) }
const [major, minor] = process.versions.node.split('.').map(Number)
if (major !== 24 && major !== 26 && !(major === 22 && minor >= 19)) throw new Error('真实评测请使用 Node 24 LTS（或受支持的 22.19+/26）')
const env = { ...process.env }
if (fs.existsSync(path.join(root, '.env'))) for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
  if (match && !(match[1] in env)) env[match[1]] = match[2].replace(/^["']|["']$/g, '')
}
for (const key of ['TUTOR_LLM_BASE_URL', 'TUTOR_LLM_API_KEY', 'TUTOR_LLM_MODEL']) if (!env[key]) throw new Error(`缺少 ${key}`)
const runsRoot = path.join(root, 'data/evals')
fs.mkdirSync(runsRoot, { recursive: true })
const outputDir = fs.mkdtempSync(path.join(runsRoot, `content-${new Date().toISOString().replace(/[:.]/g, '-')}-`))
const dshHome = path.join(outputDir, 'dsh-home')
const workspace = path.join(outputDir, 'workspace')
fs.mkdirSync(dshHome); fs.mkdirSync(workspace)
const settings = fs.readFileSync(path.join(root, 'config/settings.yaml'), 'utf8').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_raw, key) => {
  if (!env[key]) throw new Error(`缺少配置变量 ${key}`)
  return key === 'TUTOR_LLM_BASE_URL' ? env[key].replace(/\/+$/, '') : env[key]
})
fs.writeFileSync(path.join(dshHome, 'settings.yaml'), settings)
const patch = [
  ...['headless-runner', 'headless-startup', 'session-title-llm', 'agent-instructions', 'skill-filesystem'].map(id => ({ id, disabled: true })),
  { id: 'system-prompt', config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' } },
  { id: 'tools', config: { mode: 'native' } },
  { insert: [{ id: 'tutor-content-eval', name: path.join(root, 'src/eval/content-runner.ts'),
    config: { fixtureFile, outputDir, repeats, maxTokens, cases, costFile: path.join(root, 'config/cost.yaml') } }] },
]
const patchFile = path.join(outputDir, 'eval.patch.yml')
fs.writeFileSync(patchFile, yaml.stringify(patch))
const outputFile = path.join(outputDir, 'report.json')
fs.writeFileSync(outputFile, JSON.stringify({ status: 'starting', startedAt: new Date().toISOString() }, null, 2) + '\n')
console.log(`评测目录：${outputDir}`)
const require = createRequire(import.meta.url)
const child = spawn(process.execPath, [require.resolve('@deepseek-ai/dsh/lib/bin.js'), '--profile', 'headless', '--patch', patchFile], {
  cwd: workspace, env: { ...env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1', TUTOR_LLM_TIMEOUT_MS: '90000' },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
const log = fs.createWriteStream(path.join(outputDir, 'runner.log'))
child.stdout.on('data', chunk => { process.stdout.write(chunk); log.write(chunk) })
child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk) })
let stopReason
let forceTimer
const stop = reason => {
  if (stopReason) return
  stopReason = reason
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000)
  }
}
const timer = setTimeout(() => stop('评测超过 10 分钟上限'), 600_000)
process.once('SIGINT', () => stop('用户中断')); process.once('SIGTERM', () => stop('进程终止'))
child.once('error', error => { stopReason = error.message })
child.once('close', code => {
  clearTimeout(timer); clearTimeout(forceTimer); log.end()
  const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
  if (stopReason || ['starting', 'running'].includes(report.status)) {
    report.status = 'failed'; report.error = stopReason ?? `评测进程退出（${code}）`
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(`报告：${outputFile}`)
  process.exitCode = stopReason || report.status === 'failed' ? 1 : (code ?? 1)
})
