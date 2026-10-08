#!/usr/bin/env node
// 每名试学者使用独立的课程、工作目录和会话库；重复启动继续原进度。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { learner: { type: 'string', default: 'pilot-1' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('npm run trial -- [--learner pilot-1]\n每人一个小写英文/数字/连字符标识。重复使用同一标识会继续原学习记录。')
  process.exit(0)
}
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(values.learner)) throw new Error('learner 只允许小写英文、数字和连字符（1–64 位）')
const directory = path.join(root, 'data', 'trials', values.learner)
const workspace = path.join(directory, 'workspace')
fs.mkdirSync(path.join(workspace, 'config'), { recursive: true })
fs.copyFileSync(path.join(root, 'config/cost.yaml'), path.join(workspace, 'config/cost.yaml'))
const manifest = path.join(directory, 'trial.json')
if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ learner: values.learner, createdAt: new Date().toISOString(),
  purpose: '真人试学记录；未复制任何验收课程、作答或掌握度。' }, null, 2) + '\n')
console.log(`试学者：${values.learner}\n学习记录：${directory}\n关闭后用同一条命令继续；新试学者请使用不同的 --learner 标识。`)
const child = spawn(process.execPath, [path.join(root, 'scripts/agent.mjs'), 'serve'], { cwd: root, stdio: 'inherit', detached: true,
  env: { ...process.env, DSH_HOME: path.join(directory, 'dsh-home'), TUTOR_WORKSPACE: workspace,
    TUTOR_COURSES_ROOT: path.join(directory, 'courses'), TUTOR_AUDITS_ROOT: path.join(directory, 'audits') } })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  try { process.kill(-child.pid, signal) } catch { /* 子进程已经退出 */ }
})
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('close', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1) })
