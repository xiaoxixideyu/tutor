#!/usr/bin/env node
// tutor 只读视图壳：list（课程列表）/ status <课程名>（进度看板），零模型调用，不经 dsh 启动
import { CourseStore } from '../src/core/store.ts'
import { courseProgress, listCourseSummaries } from '../src/core/summary.ts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const store = new CourseStore(process.env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses'))
const out = process.stdout
const colorEnabled = out.isTTY === true

function paint(text, code) {
  return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text
}

const STATUS_STYLE = {
  mastered: { symbol: '✓', code: 32 },
  learning: { symbol: '●', code: 36 },
  weak: { symbol: '▲', code: 33 },
  unknown: { symbol: '·', code: 90 },
}

function renderList() {
  const items = listCourseSummaries(store)
  if (items.length === 0) {
    out.write('暂无课程。运行 npm run agent -- new <课程名> 开始。\n')
    return
  }
  out.write(`共 ${items.length} 门课程：\n`)
  for (const item of items) {
    const pointer = item.current ? `  ${paint('→', 90)} ${item.current}` : ''
    out.write(`${paint('●', 36)} ${item.id}  ${item.goal}${pointer}\n`)
    out.write(`  进度 ${item.mastered}/${item.total} 已掌握\n`)
  }
}

function renderStatus(courseId) {
  if (!courseId) throw new Error('用法：npm run agent -- status <课程名>')
  const progress = courseProgress(store, courseId)
  out.write(`${paint('课程', 1)} ${progress.id}${progress.goal ? ` · ${progress.goal}` : ''}\n`)
  const currentLine = progress.current
    ? progress.current
    : progress.path.length > 0
      ? '（未开始）'
      : '（无计划，先运行 assess + plan）'
  const milestoneForCurrent = progress.milestones.find((m) => m.nodes.includes(progress.current ?? ''))
  out.write(
    `指针: ${currentLine}${milestoneForCurrent ? `  ${paint(`[${milestoneForCurrent.id}]`, 90)} ${milestoneForCurrent.title}` : ''}\n`
  )
  out.write(`\n知识点（${progress.totalNodes}）：\n`)
  const idWidth = Math.max(...progress.nodes.map((n) => n.id.length), 10)
  for (const node of progress.nodes) {
    const style = STATUS_STYLE[node.status]
    const score = node.score !== undefined ? String(node.score) : ''
    const review = node.review_due !== undefined ? `  复习→${node.review_due}` : ''
    out.write(
      `  ${paint(style.symbol, style.code)} ${node.status.padEnd(9)} ${node.id.padEnd(idWidth)} ${node.title ?? ''}${score ? `  ${score}` : ''}${review}\n`
    )
  }
  if (progress.milestones.length > 0) {
    out.write(`\n里程碑：\n`)
    for (const milestone of progress.milestones) {
      out.write(`  ${milestone.id} ${milestone.title}  ${paint(`[${milestone.masteredCount}/${milestone.nodes.length}]`, 90)}\n`)
    }
  }
  const c = progress.counts
  out.write(`\n掌握总览: ${paint(`✓ ${c.mastered}`, 32)} / ${paint(`● ${c.learning}`, 36)} / ${paint(`▲ ${c.weak}`, 33)} / ${paint(`· ${c.unknown}`, 90)}\n`)
}

const [, , command, argument] = process.argv
if (command === 'list') renderList()
else if (command === 'status') renderStatus(argument)
else {
  process.stderr.write('用法：npm run agent -- list ｜ npm run agent -- status <课程名>\n')
  process.exit(1)
}
