import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { TutorSystem } from '../src/application/tutor-system.ts'
import { readModelEnvironment } from '../src/core/model-config.ts'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index < 0 ? fallback : args[index + 1]
}
if (!args.includes('--live')) {
  process.stdout.write(
    '真实模型工程验收（独立数据，不代表真人学习效果）：\n' +
      'npm run eval:agent -- --live --goal "学习目标" [--background "已有基础"] [--minutes 10] [--deadline YYYY-MM-DD]\n' +
      '恢复：--work <验收目录> --resume\n作答：--work <验收目录> --answer "独立作答"\n反馈：--work <验收目录> --message "反馈内容"\n',
  )
} else {
  const work = path.resolve(
    value('--work', path.join(root, 'data/evals/agent-' + new Date().toISOString().replace(/[:.]/g, '-'))),
  )
  fs.mkdirSync(work, { recursive: true, mode: 0o700 })
  const env = {
    ...readModelEnvironment(root),
    TUTOR_MODEL_RATE_LIMIT_FILE: path.join(root, 'data/model-rate-limits.sqlite'),
  }
  const system = new TutorSystem({
    root,
    env,
    coursesRoot: path.join(work, 'courses'),
    dataRoot: path.join(work, 'runtime'),
    modelConfigFile: path.join(root, 'data/model-config.json'),
  })
  let courseId
  try {
    const ids = system.repository.list()
    if (ids.length) courseId = ids[0]
    else {
      const created = system.service.create({
        id: 'evaluation',
        goal: value('--goal', '只学习 0 到 10 的整数加法，能独立求和，不学习乘法。'),
        background: value('--background', ''),
        dailyMinutes: Number(value('--minutes', 10)),
        deadline: value('--deadline', undefined),
      })
      courseId = created.id
    }
    const answerFile = value('--answer-file', undefined)
    const answer = answerFile ? fs.readFileSync(path.resolve(answerFile), 'utf8') : value('--answer', undefined),
      message = value('--message', undefined)
    if (answer !== undefined) {
      const view = system.service.view(courseId)
      if (!view.active?.question) throw new Error('当前没有可作答题目')
      system.answer(courseId, {
        requestId: randomUUID(),
        activityId: view.active.id,
        questionId: view.active.question.id,
        contentHash: view.active.contentHash,
        answer,
        expectedRevision: view.revision,
      })
    } else if (args.includes('--resume')) system.resume(courseId, randomUUID())
    else system.start(courseId, { requestId: randomUUID(), message: message ?? '', intent: 'learn' })
    process.stdout.write('验收目录：' + work + '\n')
    await system.wait(courseId)
    const view = system.service.view(courseId)
    const report = {
      kind: 'synthetic-engineering-evaluation',
      at: new Date().toISOString(),
      work,
      model: system.models.publicConfig().model,
      goal: view.goal,
      status: view.tutorStatus,
      error: view.tutorError,
      active: view.active,
      decisions: view.decisions,
      hypotheses: view.hypotheses,
      proposals: view.proposals,
      usage: system.usageLedger.read(),
      events: system.events(courseId, -1),
    }
    const file = path.join(work, 'report-' + Date.now() + '.json')
    fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 })
    process.stdout.write(
      JSON.stringify(
        {
          report: file,
          status: report.status,
          error: report.error,
          activity: view.active?.title,
          kind: view.active?.kind,
          question: view.active?.question,
          proposals: view.proposals,
          actions: view.decisions.map((decision) => ({
            action: decision.action,
            status: decision.status,
            reason: decision.reason,
          })),
          requests: report.usage.length,
          estimatedCost: report.usage.reduce((sum, item) => sum + item.estimatedCost, 0),
        },
        null,
        2,
      ) + '\n',
    )
    if (report.status === 'failed') process.exitCode = 1
  } finally {
    await system.close()
  }
}
