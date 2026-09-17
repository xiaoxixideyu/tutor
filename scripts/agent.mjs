#!/usr/bin/env node
// tutor 薄壳：驱动 Harness headless 档案跑一次性 agent 任务（设计文档 §4.3：壳不承载业务逻辑）
// 用法：npm run agent -- "任务文本" ｜ echo 任务 | npm run agent
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
// 当前机器默认 node 可能不满足，这里解析一个受支持运行时：TUTOR_NODE_BIN > homebrew node@24 > 当前进程。
function resolveRuntimeNode() {
  if (process.env.TUTOR_NODE_BIN) return process.env.TUTOR_NODE_BIN
  const [major, minor] = process.versions.node.split('.').map(Number)
  const supported = major === 24 || major === 26 || (major === 22 && minor >= 19)
  if (supported) return process.execPath
  const brewNode24 = '/opt/homebrew/opt/node@24/bin/node'
  if (fs.existsSync(brewNode24)) return brewNode24
  return process.execPath
}

const patchArgs = patchPath ? ['--patch', patchPath] : []
const result = spawnSync(resolveRuntimeNode(), [bin, '--profile', 'headless', ...patchArgs, ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  cwd: root,
})
process.exit(result.status ?? 1)
