#!/usr/bin/env node
// tutor 忠实度抽查壳：对课堂会话日志生成忠实度报告（零模型；四期评测第一块）
// 用法：npm run agent -- audit [session-id 或 latest] [--json]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  assembleReport,
  parseLessonIntro,
  parseSessionLog,
} from '../src/core/fidelity.ts'
import { CourseStore } from '../src/core/store.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = process.stdout
const sessionsRoot = path.join(root, 'data', 'dsh-home', 'sessions')
const WORKSPACE_DIR = `-${root.replaceAll('/', '-')}--`
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeZstdMultiFrame(buf) {
  let offset = 0
  let text = ''
  while (offset < buf.length) {
    const idx = buf.indexOf(MAGIC, offset)
    if (idx < 0) break
    let end = buf.indexOf(MAGIC, idx + 4)
    if (end < 0) end = buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(idx, end)).toString('utf8')
    } catch {
      // 尾部不完整帧忽略
    }
    offset = end
  }
  return text
}

function findSessions(filter) {
  const dir = path.join(sessionsRoot, WORKSPACE_DIR)
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('session-'))
  let sessions = entries.map((e) => {
    const dirPath = path.join(dir, e.name)
    return {
      id: e.name.slice('session-'.length),
      mtime: fs.statSync(dirPath).mtimeMs,
      file: path.join(dirPath, 'session.v3.jsonl.zstd'),
    }
  })
  if (filter && filter !== 'latest') sessions = sessions.filter((s) => s.id.includes(filter))
  return sessions.sort((a, b) => b.mtime - a.mtime)
}

function loadEvents(file) {
  if (!fs.existsSync(file)) throw new Error(`会话日志不存在：${file}`)
  const lines = decodeZstdMultiFrame(fs.readFileSync(file))
    .split('\n')
    .filter((l) => l.trim())
  return lines.map((l) => JSON.parse(l))
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const positional = args.filter((a) => a !== '--json')
const target = positional[1] ?? 'latest'

const sessions = findSessions(target)
if (sessions.length === 0) {
  process.stderr.write(`tutor: 未找到会话（${target === 'latest' ? '无任何课堂会话' : `无匹配 "${target}"`}）\n`)
  process.exit(1)
}
// 挑最近的一节真正的课堂会话：教研/摸底/备课/事实核对等会话没有【本课计划】首消息，
// audit latest 需跳过它们（否则可能选中一个非课堂会话而报"无法审计"）。sessions 已按 mtime 倒序。
let session = null
let log = null
for (const candidate of sessions) {
  let parsed
  try {
    parsed = parseSessionLog(loadEvents(candidate.file))
  } catch {
    continue
  }
  if (parsed.intro) {
    session = candidate
    log = parsed
    break
  }
}
if (!session || !log) {
  process.stderr.write(
    `tutor: 未找到含课堂首消息（【本课计划】）的会话（${target === 'latest' ? '尚无课堂会话' : `"${target}" 不是课堂会话`}）。请对 learn 会话运行。\n`
  )
  process.exit(1)
}
const introView = parseLessonIntro(log.intro)
if (!introView) {
  process.stderr.write('tutor: 课堂首消息解析失败。\n')
  process.exit(1)
}

const store = new CourseStore(process.env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses'))
let otherNodes = []
const courseId = store.list()[0]
if (courseId && store.has(courseId, 'knowledge-map')) {
  const knowledgeMap = store.read(courseId, 'knowledge-map')
  otherNodes = knowledgeMap.nodes.map((n) => ({ id: n.id, title: n.title }))
}

const report = assembleReport({
  sessionId: session.id,
  introView,
  assistantTexts: log.assistantTexts,
  usage: log.usage,
  otherNodes,
  generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
})

if (asJson) {
  out.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  out.write(`课堂忠实度报告  会话 ${report.sessionId.slice(0, 8)}  ${report.generatedAt}\n`)
  out.write(`知识点：${report.node}（${report.title}）  回合 ${report.cost.turns}  成本 输入 ${report.cost.inputTokens} / 输出 ${report.cost.outputTokens} tokens\n`)
  if (report.reachedPoints === 0) {
    out.write(`\n忠实度 — 本课几乎未展开（讲到 0/${report.plannedPoints} 个计划要点）\n`)
  } else {
    const mark = report.coverageRate >= 0.99 ? '✓' : report.coverageRate >= 0.5 ? '△' : '✗'
    const reachNote = report.partial ? '，本课暂停，未讲到的点不计入' : '，已讲完'
    out.write(`\n忠实度 ${mark} ${Math.round(report.coverageRate * 100)}%（讲到 ${report.reachedPoints}/${report.plannedPoints} 个计划要点${reachNote}）\n`)
  }
  for (const [index, item] of report.structure.entries()) {
    const bar = '█'.repeat(Math.round(item.coverage * 10)) + '░'.repeat(10 - Math.round(item.coverage * 10))
    const unreached = index >= report.reachedPoints ? ' ·未讲到' : ''
    out.write(`  ${bar} ${Math.round(item.coverage * 100)}%  ${item.point.slice(0, 40)}${unreached}\n`)
  }
  const c = report.citations
  out.write(`\n引用纪律：标记 ${c.totalCitations} 次${c.invalidCitations.length > 0 ? `（无效 ${c.invalidCitations.join('、')}）` : ''}；断言句 ${c.assertionSentences}，无引用 ${c.uncitedAssertions}\n`)
  out.write(report.drift.length > 0 ? `\n超纲嫌疑：${report.drift.map((d) => `${d.id}(${Math.round(d.overlap * 100)}%)`).join('、')}\n` : '\n超纲嫌疑：无\n')
}

const auditsDir = path.join(root, 'audits')
fs.mkdirSync(auditsDir, { recursive: true })
fs.writeFileSync(path.join(auditsDir, `${report.sessionId}.json`), `${JSON.stringify(report, null, 2)}\n`)
process.exit(0)
