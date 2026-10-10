#!/usr/bin/env node
// tutor 薄壳：驱动 Harness headless 档案跑一次性 agent 任务（设计文档 §4.3：壳不承载业务逻辑）
// 用法：
//   npm run agent -- list                课程列表（设计 §6.4 tutor list，零模型）
//   npm run agent -- status <课程名>     进度看板（设计 §6.4 tutor status，零模型）
//   npm run agent -- review <课程名>     复习到期知识点（设计 §6.4 tutor review，零模型）
//   npm run agent -- audit [会话id]      课堂忠实度抽查（零模型，四期评测）
//   npm run agent -- audit-content <课程名>  独立审查已有课程内容（需模型，学习状态不变）
//   npm run agent -- serve               前端壳（默认 8788，TUTOR_SERVER_PORT 可改）
//   npm run agent -- practice <课程名>   实践任务：写代码跑规则化测试（三期，零模型）
//   npm run agent -- practice-gen <课程名>  生成实践任务（三期，需模型）
//   npm run agent -- "任务文本"          一次性任务
//   npm run agent -- new <课程名>        需求澄清访谈（交互式，设计 §6.4 tutor new）
//   npm run agent -- assess <课程名>     摸底测评（交互式，设计 §6.4 tutor assess）
//   npm run agent -- plan <课程名>       生成/更新教学计划（设计 §6.4 tutor plan）
//   npm run agent -- learn <课程名>      开始/继续本节课：备课→讲授（设计 §6.4 tutor learn）
//   npm run agent -- research <课程名>   联网教研：构建带来源的知识地图（二期）
//   npm run agent -- exam <课程名> [里程碑id] 里程碑大考（自动选下一个可考里程碑）
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'yaml'
import { COURSE_ID_PATTERN } from '../src/core/store.ts'
import { renderModelTemplate } from '../src/core/model-settings.ts'
import { ModelConfigStore, readModelEnvironment } from '../src/core/model-config.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const defaultHome = path.join(root, 'data', 'dsh-home')
const requestedHome = path.resolve(process.env.DSH_HOME ?? defaultHome)
// 网页教研也使用独立运行目录，避免覆盖访谈/课堂使用的 Harness 配置。显式 CLI 隔离目录继续沿用。
if (argv[0] === 'research') fs.mkdirSync(path.join(root, 'data'), { recursive: true })
const dshHome = argv[0] === 'research' && requestedHome === defaultHome
  ? fs.mkdtempSync(path.join(root, 'data', 'research-home-')) : requestedHome
const workspace = path.resolve(process.env.TUTOR_WORKSPACE ?? root)
fs.mkdirSync(dshHome, { recursive: true })
fs.mkdirSync(workspace, { recursive: true })

// .env / 环境变量提供初始配置；网页保存的配置在模型流程启动时覆盖这些默认值。
let env = readModelEnvironment(root, { ...process.env, DSH_HOME: dshHome })
if (argv[0] === 'research') env.TUTOR_RESEARCH_PROGRESS = '1'

// 渲染 config/ 下的模板（替换 ${VAR} 占位符）到运行时目录
env.TUTOR_PLUGIN_PATH ??= path.join(root, 'src', 'plugin', 'course-state.ts')
env.TUTOR_COURSES_ROOT ??= path.join(root, 'courses')

function renderTemplate(name, output) {
  const src = path.join(root, 'config', name)
  if (!fs.existsSync(src)) return null
  const template = fs.readFileSync(src, 'utf8')
  const rendered = name === 'settings.yaml' ? renderModelTemplate(template, env) : template
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (raw, varName) => {
      if (!(varName in env)) throw new Error(`scripts/agent.mjs: 模板 ${name} 缺少环境变量 ${varName}（见 .env.example）`)
      const value = env[varName]
      return varName === 'TUTOR_LLM_BASE_URL' ? value.replace(/\/+$/, '') : value
    })
  const dst = path.join(dshHome, output)
  fs.writeFileSync(dst, rendered)
  return dst
}

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

// list/status/review/practice/audit：只读或零模型交互，直接用受支持运行时执行对应脚本（不经 dsh）
if (argv[0] === 'list' || argv[0] === 'status' || argv[0] === 'review' || argv[0] === 'practice' || argv[0] === 'audit' || argv[0] === 'serve') {
  const scriptByMode = { review: 'review.mjs', practice: 'practice.mjs', audit: 'audit.mjs', serve: 'serve.mjs' }
  const script = path.join(root, 'scripts', scriptByMode[argv[0]] ?? 'view.mjs')
  const viewResult = spawnSync(resolveRuntimeNode(), [script, ...argv], {
    env: { ...env, TUTOR_COURSES_ROOT: env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses') },
    stdio: 'inherit',
    cwd: workspace,
  })
  process.exit(viewResult.status ?? 1)
}

// 服务和零模型命令无需先填写模型配置；空白安装也能打开网页设置。
// 网页宿主已冻结本次流程的配置时不再读取保存文件，避免并发保存切换到别的渠道。
if (env.TUTOR_MODEL_CONFIG_RESOLVED !== '1') env = new ModelConfigStore(root, { env }).environment()
if (argv[0] === 'research') {
  env.TUTOR_CHANNEL_TRACE_FILE ??= path.join(dshHome, 'transport.jsonl')
  const observer = new URL('../src/core/model-transport.ts', import.meta.url).href
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${observer}`].filter(Boolean).join(' ')
}
const settingsPath = renderTemplate('settings.yaml', 'settings.yaml')
if (!settingsPath) throw new Error('scripts/agent.mjs: 缺少 config/settings.yaml')
const patchPath = renderTemplate('cordis.patch.yml', 'tutor.patch.yml')
const patchArgs = patchPath ? ['--patch', patchPath] : []
const require = createRequire(import.meta.url)
const bin = require.resolve('@deepseek-ai/dsh/lib/bin.js')

let runnerArgs = []
let runnerMode = null
if (['new', 'assess', 'plan', 'learn', 'research', 'practice-gen', 'exam', 'audit-content'].includes(argv[0])) {
  runnerMode = argv[0]
  const courseId = argv[1] ?? ''
  if (!COURSE_ID_PATTERN.test(courseId)) {
    throw new Error(`课程名 "${courseId}" 非法：仅允许小写字母/数字/连字符（1-64 位）`)
  }
  const nodeIndex = argv.indexOf('--node', 2)
  const nodeId = nodeIndex >= 0 ? argv[nodeIndex + 1] : ''
  if (['practice-gen', 'research'].includes(runnerMode) && nodeIndex >= 0 && (!nodeId || !/^[a-z0-9][a-z0-9-]*$/.test(nodeId))) {
    throw new Error('--node 需要合法的知识点 id')
  }
  const personaByMode = { new: 'interview.md', assess: 'assess.md', plan: 'plan.md', learn: 'teach.md', research: 'research.md', 'practice-gen': 'practice-gen.md', exam: 'exam-grade.md' }
  const runnerByMode = {
    new: 'tutor-interview-runner',
    assess: 'tutor-assess-runner',
    plan: 'tutor-plan-runner',
    learn: 'tutor-learn-runner',
    research: 'tutor-research-runner',
    'practice-gen': 'tutor-practice-gen-runner',
    exam: 'tutor-exam-runner',
    'audit-content': 'tutor-audit-content-runner',
  }
  const moduleByMode = {
    new: 'interview-runner.ts',
    assess: 'assess-runner.ts',
    plan: 'plan-runner.ts',
    learn: 'learn-runner.ts',
    research: 'research-runner.ts',
    'practice-gen': 'practice-gen-runner.ts',
    exam: 'exam-runner.ts',
    'audit-content': 'audit-content-runner.ts',
  }
  const personaFile = personaByMode[runnerMode]
  const runnerId = runnerByMode[runnerMode]
  const runnerModule = moduleByMode[runnerMode]
  const persona = runnerMode === 'audit-content' ? '独立审查已有课程的范围与正确性。' : fs.readFileSync(path.join(root, 'config', 'persona', personaFile), 'utf8').trim()
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
    { id: 'session-title-llm', disabled: true },
    {
      insert: [
        {
          id: runnerId,
          name: path.join(root, 'src', 'plugin', runnerModule),
          inject: ['agentDefaultModel', 'agents', 'sessions', 'courseState'],
          config: runnerMode === 'exam' ? { courseId, milestoneId: argv[2] ?? '' }
            : ['practice-gen', 'research'].includes(runnerMode) ? { courseId, nodeId } : { courseId },
        },
      ],
    },
  ]
  const modePatchPath = path.join(dshHome, `${runnerMode}.patch.yml`)
  fs.writeFileSync(modePatchPath, yaml.stringify(modePatch))
  runnerArgs = ['--patch', modePatchPath]
  if (runnerMode === 'research') {
    if (!env.TUTOR_MCP_SEARCH_URL || !env.TUTOR_MCP_SEARCH_TOKEN) throw new Error('联网教研需要配置搜索 MCP；也可在网页跳过教研')
    runnerArgs.push('--patch', renderTemplate('search.patch.yml', 'search.patch.yml'))
  }
}

const innerArgs = runnerMode ? [] : argv
const result = spawnSync(resolveRuntimeNode(), [bin, '--profile', 'headless', ...patchArgs, ...runnerArgs, ...innerArgs], {
  env,
  stdio: 'inherit',
  cwd: workspace,
})
process.exit(result.status ?? 1)
