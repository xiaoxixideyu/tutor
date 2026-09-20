#!/usr/bin/env node
// tutor 薄壳：驱动 Harness headless 档案跑一次性 agent 任务（设计文档 §4.3：壳不承载业务逻辑）
// 用法：
//   npm run agent -- list                课程列表（设计 §6.4 tutor list，零模型）
//   npm run agent -- status <课程名>     进度看板（设计 §6.4 tutor status，零模型）
//   npm run agent -- review <课程名>     复习到期知识点（设计 §6.4 tutor review，零模型）
//   npm run agent -- audit [会话id]      课堂忠实度抽查（零模型，四期评测）
//   npm run agent -- practice <课程名>   实践任务：写代码跑规则化测试（三期，零模型）
//   npm run agent -- practice-gen <课程名>  生成实践任务（三期，需模型）
//   npm run agent -- "任务文本"          一次性任务
//   npm run agent -- new <课程名>        需求澄清访谈（交互式，设计 §6.4 tutor new）
//   npm run agent -- assess <课程名>     摸底测评（交互式，设计 §6.4 tutor assess）
//   npm run agent -- plan <课程名>       生成/更新教学计划（设计 §6.4 tutor plan）
//   npm run agent -- learn <课程名>      开始/继续本节课：备课→讲授（设计 §6.4 tutor learn）
//   npm run agent -- research <课程名>   联网教研：构建带来源的知识地图（二期）
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'yaml'
import { COURSE_ID_PATTERN } from '../src/core/store.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = path.join(root, 'data', 'dsh-home')
fs.mkdirSync(dshHome, { recursive: true })

// .env：模型接入三要素（base_url/api_key/model）的单一来源；不覆盖已有环境变量
const env = { ...process.env, DSH_HOME: dshHome }
const envFile = path.join(root, '.env')
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

// 渲染 config/ 下的模板（替换 ${VAR} 占位符）到运行时目录
env.TUTOR_PLUGIN_PATH ??= path.join(root, 'src', 'plugin', 'course-state.ts')
env.TUTOR_COURSES_ROOT ??= path.join(root, 'courses')

function renderTemplate(name, output) {
  const src = path.join(root, 'config', name)
  if (!fs.existsSync(src)) return null
  const rendered = fs
    .readFileSync(src, 'utf8')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (raw, varName) => {
      if (!(varName in env)) throw new Error(`scripts/agent.mjs: 模板 ${name} 缺少环境变量 ${varName}（见 .env.example）`)
      const value = env[varName]
      return varName === 'TUTOR_LLM_BASE_URL' ? value.replace(/\/+$/, '') : value
    })
  const dst = path.join(dshHome, output)
  fs.writeFileSync(dst, rendered)
  return dst
}

const settingsPath = renderTemplate('settings.yaml', 'settings.yaml')
if (!settingsPath) throw new Error('scripts/agent.mjs: 缺少 config/settings.yaml')
const patchPath = renderTemplate('cordis.patch.yml', 'tutor.patch.yml')

const require = createRequire(import.meta.url)
const bin = require.resolve('@deepseek-ai/dsh/lib/bin.js')

// Harness 依赖 import.meta.main（Node 22.19+/24+ 才有），且官方仅在 22.19/24/26 上测试。
// 当前机器默认 node 可能不满足，这里解析一个受支持运行时：
// TUTOR_NODE_BIN > 当前进程 > homebrew node@24 > nvm 已装版本（取最高）> 当前进程兜底。
function isSupportedNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  return major === 24 || major === 26 || (major === 22 && minor >= 19)
}

function versionParts(version) {
  return version.replace(/^v/, '').split('.').map(Number)
}

function resolveRuntimeNode() {
  if (process.env.TUTOR_NODE_BIN) return process.env.TUTOR_NODE_BIN
  if (isSupportedNode(process.versions.node)) return process.execPath
  const candidates = []
  const brewNode24 = '/opt/homebrew/opt/node@24/bin/node'
  if (fs.existsSync(brewNode24)) candidates.push({ bin: brewNode24, version: '24' })
  const nvmVersionsDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
  try {
    for (const entry of fs.readdirSync(nvmVersionsDir)) {
      const bin = path.join(nvmVersionsDir, entry, 'bin', 'node')
      if (fs.existsSync(bin) && isSupportedNode(entry)) candidates.push({ bin, version: entry })
    }
  } catch {
    // 无 nvm 目录：跳过
  }
  candidates.sort((a, b) => {
    const av = versionParts(a.version)
    const bv = versionParts(b.version)
    for (let i = 0; i < 3; i++) {
      if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (bv[i] ?? 0) - (av[i] ?? 0)
    }
    return 0
  })
  if (candidates.length > 0) return candidates[0].bin
  return process.execPath
}

const patchArgs = patchPath ? ['--patch', patchPath] : []
const argv = process.argv.slice(2)

// list/status/review/practice/audit：只读或零模型交互，直接用受支持运行时执行对应脚本（不经 dsh）
if (argv[0] === 'list' || argv[0] === 'status' || argv[0] === 'review' || argv[0] === 'practice' || argv[0] === 'audit') {
  const scriptByMode = { review: 'review.mjs', practice: 'practice.mjs', audit: 'audit.mjs' }
  const script = path.join(root, 'scripts', scriptByMode[argv[0]] ?? 'view.mjs')
  const viewResult = spawnSync(resolveRuntimeNode(), [script, ...argv], {
    env: { ...env, TUTOR_COURSES_ROOT: env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses') },
    stdio: 'inherit',
    cwd: root,
  })
  process.exit(viewResult.status ?? 1)
}

let runnerArgs = []
let runnerMode = null
if (argv[0] === 'new' || argv[0] === 'assess' || argv[0] === 'plan' || argv[0] === 'learn' || argv[0] === 'research' || argv[0] === 'practice-gen') {
  runnerMode = argv[0]
  const courseId = argv[1] ?? ''
  if (!COURSE_ID_PATTERN.test(courseId)) {
    throw new Error(`课程名 "${courseId}" 非法：仅允许小写字母/数字/连字符（1-64 位）`)
  }
  const personaByMode = { new: 'interview.md', assess: 'assess.md', plan: 'plan.md', learn: 'teach.md', research: 'research.md', 'practice-gen': 'practice-gen.md' }
  const runnerByMode = {
    new: 'tutor-interview-runner',
    assess: 'tutor-assess-runner',
    plan: 'tutor-plan-runner',
    learn: 'tutor-learn-runner',
    research: 'tutor-research-runner',
    'practice-gen': 'tutor-practice-gen-runner',
  }
  const moduleByMode = {
    new: 'interview-runner.ts',
    assess: 'assess-runner.ts',
    plan: 'plan-runner.ts',
    learn: 'learn-runner.ts',
    research: 'research-runner.ts',
    'practice-gen': 'practice-gen-runner.ts',
  }
  const personaFile = personaByMode[runnerMode]
  const runnerId = runnerByMode[runnerMode]
  const runnerModule = moduleByMode[runnerMode]
  const persona = fs.readFileSync(path.join(root, 'config', 'persona', personaFile), 'utf8').trim()
  const modePatch = [
    {
      id: 'system-prompt',
      config: {
        personaPrefix: persona,
        personaSuffix: '',
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
      },
    },
    { id: 'headless-runner', disabled: true },
    { id: 'headless-startup', disabled: true },
    {
      insert: [
        {
          id: runnerId,
          name: path.join(root, 'src', 'plugin', runnerModule),
          inject: ['agentDefaultModel', 'agents', 'sessions', 'courseState'],
          config: { courseId },
        },
      ],
    },
  ]
  const modePatchPath = path.join(dshHome, `${runnerMode}.patch.yml`)
  fs.writeFileSync(modePatchPath, yaml.stringify(modePatch))
  runnerArgs = ['--patch', modePatchPath]
}

const innerArgs = runnerMode ? [] : argv
const result = spawnSync(resolveRuntimeNode(), [bin, '--profile', 'headless', ...patchArgs, ...runnerArgs, ...innerArgs], {
  env,
  stdio: 'inherit',
  cwd: root,
})
process.exit(result.status ?? 1)
