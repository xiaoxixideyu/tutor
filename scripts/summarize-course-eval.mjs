#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeCourseCosts } from '../src/eval/course-cost.ts'
import { loadCostConfig } from '../src/core/cost.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!process.argv[2]) throw new Error('用法：node scripts/summarize-course-eval.mjs data/evals/course-...')
const run = fs.realpathSync(path.resolve(process.argv[2]))
if (!run.startsWith(fs.realpathSync(path.join(root, 'data/evals')) + path.sep)) throw new Error('仅汇总 data/evals 下的验收记录')
const stages = []
for (const course of fs.readdirSync(run, { withFileTypes: true }).filter(item => item.isDirectory())) {
  const dir = path.join(run, course.name, 'stages')
  if (!fs.existsSync(dir)) continue
  for (const stage of fs.readdirSync(dir)) {
    const file = path.join(dir, stage, 'report.json')
    if (fs.existsSync(file)) {
      const report = JSON.parse(fs.readFileSync(file, 'utf8'))
      const attemptsFile = path.join(dir, stage, 'attempts.jsonl')
      const attempts = report.attempts ?? (fs.existsSync(attemptsFile)
        ? fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
      stages.push({ ...report, attempts, stageId: `${course.name}/${stage}` })
    }
  }
}
const report = summarizeCourseCosts(stages, loadCostConfig(fs.readFileSync(path.join(root, 'config/cost.yaml'), 'utf8')))
report.generatedAt = new Date().toISOString()
report.basis = '只汇总各阶段已报告用量；诊断探测另计，未知用量不当作免费，实际网关账单未提供。执行完成不等于内容验收通过。'
fs.writeFileSync(path.join(run, 'cost-summary.json'), JSON.stringify(report, null, 2) + '\n')
console.table(report.rows.map(({ courseId, stage, status, attempts, unreportedAttempts, usage, estimated }) => ({ courseId, stage, status, attempts, unreportedAttempts, ...usage, estimated })))
console.log(JSON.stringify({ usage: report.usage, estimated: report.estimated, currency: report.currency, unreportedAttempts: report.unreportedAttempts, actualBill: report.actualBill }))
