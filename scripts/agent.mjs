#!/usr/bin/env node
// tutor 薄壳：零模型命令直跑脚本；模型流程在进程内执行（单进程，无外部 agent 基座）。
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
//   npm run agent -- assess <课程名> --reset  清理未完成的摸底进度（原文件归档）
//   npm run agent -- plan <课程名>       生成/更新教学计划（设计 §6.4 tutor plan）
//   npm run agent -- learn <课程名>      开始/继续本节课：备课→讲授（设计 §6.4 tutor learn）
//   npm run agent -- research <课程名>   联网教研：构建带来源的知识地图（二期）
//   npm run agent -- exam <课程名> [里程碑id] 里程碑大考（自动选下一个可考里程碑）
//   npm run agent -- exam <课程名> --discard  放弃未完成的考试断点（原文件归档）
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COURSE_ID_PATTERN } from '../src/core/store.ts'
import { createCliIO } from '../src/flows/io.ts'
import { runFlowInProcess, resolveFlowEnv, modelSettingsFromEnv } from '../src/flows/run.ts'
import { searchSettingsFromEnv } from '../src/runtime/tools.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

// serve：单进程网页宿主，直接在当前进程内启动（不派生壳进程）。
if (argv[0] === 'serve') {
  await import('./serve.mjs')
  await new Promise(() => {}) // 保持进程存活；serve.mjs 已注册 SIGINT/SIGTERM 退出处理
} else if (['list', 'status', 'review', 'audit'].includes(argv[0])) {
  // list/status/review/audit：只读或零模型交互，直接执行对应脚本。
  const scriptByMode = { review: 'review.mjs', audit: 'audit.mjs' }
  const script = path.join(root, 'scripts', scriptByMode[argv[0]] ?? 'view.mjs')
  const result = spawnSync(process.execPath, [script, ...argv], {
    env: { ...process.env, TUTOR_COURSES_ROOT: process.env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses') },
    stdio: 'inherit',
    cwd: process.cwd(),
  })
  process.exit(result.status ?? 1)
}

const MODEL_KINDS = ['new', 'assess', 'plan', 'learn', 'research', 'practice-gen', 'exam', 'audit-content']
const kind = argv[0]
const io = createCliIO()

async function main() {
  if (!['practice', ...MODEL_KINDS].includes(kind)) {
    // 一次性任务：无课程上下文，直接问一次模型。
    const task = argv.join(' ').trim()
    if (!task) {
      process.stderr.write('用法：npm run agent -- <new|assess|plan|learn|research|practice-gen|exam|audit-content|practice|list|status|review|audit|serve> …\n')
      process.exit(1)
    }
    const env = resolveFlowEnv(root, process.env)
    const { ChatRuntime } = await import('../src/runtime/chat.ts')
    const { modelSettingsFromEnv } = await import('../src/flows/run.ts')
    const runtime = new ChatRuntime({
      model: modelSettingsFromEnv(env), sessionsRoot: env.TUTOR_SESSIONS_ROOT ?? path.join(root, 'data', 'sessions'),
      workspace: env.TUTOR_WORKSPACE ?? root, env, out: io.out, err: io.err,
    })
    const chat = await runtime.createChat()
    io.out((await chat.ask(task)) + '\n')
    await chat.flush()
    process.exit(0)
  }

  if (kind === 'practice') {
    const courseId = argv[1] ?? ''
    if (!COURSE_ID_PATTERN.test(courseId)) throw new Error(`课程名 "${courseId}" 非法：仅允许小写字母/数字/连字符（1-64 位）`)
    const nodeIndex = argv.indexOf('--node', 2)
    const nodeId = nodeIndex >= 0 ? argv[nodeIndex + 1] : ''
    if (nodeIndex >= 0 && (!nodeId || !/^[a-z0-9][a-z0-9-]*$/.test(nodeId))) throw new Error('--node 需要合法的知识点 id')
    const code = await runFlowInProcess({ kind, courseId, ...(nodeId ? { nodeId } : {}) }, io, { root, env: process.env })
    process.exit(code)
  }

  const courseId = argv[1] ?? ''
  if (!COURSE_ID_PATTERN.test(courseId)) throw new Error(`课程名 "${courseId}" 非法：仅允许小写字母/数字/连字符（1-64 位）`)
  const nodeIndex = argv.indexOf('--node', 2)
  const nodeId = nodeIndex >= 0 ? argv[nodeIndex + 1] : ''
  if (['practice-gen', 'research'].includes(kind) && nodeIndex >= 0 && (!nodeId || !/^[a-z0-9][a-z0-9-]*$/.test(nodeId))) {
    throw new Error('--node 需要合法的知识点 id')
  }
  const milestoneId = kind === 'exam' ? (argv[2] && !argv[2].startsWith('--') ? argv[2] : '') : ''
  const reset = kind === 'assess' && argv.includes('--reset')
  const discard = kind === 'exam' && argv.includes('--discard')
  // 仅清理断点的操作不需要模型配置；服务和零模型命令也无需先填写模型配置。
  const env = reset || discard ? { ...process.env } : resolveFlowEnv(root, process.env)
  if (kind === 'research') {
    if (!env.TUTOR_MCP_SEARCH_URL || !env.TUTOR_MCP_SEARCH_TOKEN) throw new Error('联网教研需要配置搜索 MCP；也可在网页跳过教研')
    env.TUTOR_CHANNEL_TRACE_FILE ??= path.join(root, 'data', 'transport.jsonl')
  }
  const code = await runFlowInProcess({ kind, courseId, ...(milestoneId ? { milestoneId } : {}), ...(nodeId ? { nodeId } : {}),
    ...(reset ? { reset: true } : {}), ...(discard ? { discard: true } : {}) }, io, {
    root, env,
    // 与网页宿主一致：保存的模型/搜索设置对进行中的流程在下一回合生效（CLI 每次重新解析 .env/网页配置）。
    resolveModel: () => modelSettingsFromEnv(resolveFlowEnv(root, process.env)),
    resolveSearch: () => { try { return searchSettingsFromEnv(resolveFlowEnv(root, process.env)) } catch { return undefined } },
  })
  process.exit(code)
}

main().catch((error) => {
  process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
