// 实践壳：学员在 workdir 写代码、跑规则化测试（零模型，判分在核心；三期实践任务沙箱）。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { judgePracticeTask, buildPracticeIntro, applyPracticeResult, selectPracticeNode, practiceTaskKey, validatePracticeTasks } from '../core/practice.ts'
import type { KnowledgeMap, Mastery, Plan, PracticeTaskFile, PracticeTaskState } from '../core/schema.ts'
import { runTests, ensureStarterFiles } from './practice-executor.ts'
import { requireReviewedPractice } from '../core/quality-store.ts'
import { appendMasteryEvent } from '../core/events.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'
import { requirePlanMapConsistency } from './consistency.ts'

// 从测试命令提取已知工具并探测可用性（学员机器没装就给指引，不产生任务状态）
const KNOWN_TOOLS: Record<string, string> = { go: 'brew install go', node: 'brew install node', python3: 'xcode-select --install', cargo: 'brew install rust' }

function detectMissingTools(task: { tests: { command: string }[] }): string[] {
  const missing: string[] = []
  const seen = new Set<string>()
  for (const test of task.tests) {
    for (const [tool, hint] of Object.entries(KNOWN_TOOLS)) {
      if (seen.has(tool)) continue
      if (!new RegExp(`\\b${tool}\\b`).test(test.command)) continue
      seen.add(tool)
      const probe = spawnSync(tool, ['--version'], { stdio: 'ignore' })
      if (probe.error || probe.status === 127) missing.push(`${tool}（${hint}）`)
    }
  }
  return missing
}

export async function runPractice(deps: FlowDeps, config: { courseId: string; nodeId?: string }): Promise<void> {
  const { store, io } = deps
  const courseId = config.courseId
  const nodeOverride = config.nodeId
  if (!store.exists(courseId)) {
    io.err(`tutor: 课程 "${courseId}" 不存在，请先运行 npm run agent -- new ${courseId}\n`)
    throw new FlowExit(1)
  }
  if (!store.has(courseId, 'plan') || !store.has(courseId, 'practice')) {
    io.err(
      store.has(courseId, 'practice')
        ? `tutor: 课程 "${courseId}" 缺少教学计划，请先运行 npm run agent -- plan ${courseId}\n`
        : `tutor: 课程 "${courseId}" 还没有实践任务，请先运行 npm run agent -- practice-gen ${courseId}\n`
    )
    throw new FlowExit(1)
  }

  const plan = store.read(courseId, 'plan') as Plan
  const map = store.read(courseId, 'knowledge-map') as KnowledgeMap
  const mastery = store.has(courseId, 'mastery') ? store.read(courseId, 'mastery') as Mastery : undefined
  requirePlanMapConsistency(deps, courseId, plan, map)
  const prevState = store.has(courseId, 'practice-state') ? store.read(courseId, 'practice-state') as PracticeTaskState : undefined
  const node = selectPracticeNode(plan, map, mastery, nodeOverride, prevState)
  if (!node) {
    io.out('课程没有可实践的知识点。\n')
    throw new FlowExit(0)
  }

  const practiceFile = store.read(courseId, 'practice') as PracticeTaskFile
  const validPractice = validatePracticeTasks(practiceFile)
  if (!validPractice.ok) throw new Error(validPractice.error)
  const tasks = practiceFile.tasks.filter((t) => t.node === node)
  if (tasks.length === 0) {
    io.out(`知识点 ${node} 还没有实践任务（当前 practice.yaml 只覆盖其他知识点）。请重新运行 practice-gen ${courseId}。\n`)
    throw new FlowExit(0)
  }
  requireReviewedPractice(store, courseId, practiceFile, node)

  // 多任务菜单 / 断点续做检测
  let task = tasks[0]
  if (tasks.length > 1) {
    io.out('本知识点有多个任务：\n')
    for (const [index, t] of tasks.entries()) {
      const marker = prevState && prevState.task_id === t.id ? '（上次进行中）' : ''
      io.out(`  ${index + 1}. ${t.title}${marker}\n`)
    }
    io.out('选择任务序号（回车默认 1）：')
    const pick = await io.readLine()
    const pickIndex = Number.parseInt((pick ?? '').trim(), 10)
    if (pickIndex >= 2 && pickIndex <= tasks.length) task = tasks[pickIndex - 1]
  }

  const missingTools = detectMissingTools(task)
  if (missingTools.length > 0) {
    io.out('\n缺少运行本任务所需的工具，请先安装：\n')
    for (const m of missingTools) io.out(`  - ${m}\n`)
    throw new FlowExit(1)
  }

  const workdir = path.join(store.root, courseId, 'sandbox', task.id)
  const materials = ensureStarterFiles(task, workdir)
  io.out(`\n${buildPracticeIntro(task, workdir)}\n`)
  for (const file of materials.preserved) io.out(`已保留你修改的 ${file.path}；当前任务提供的初始版本见 ${file.currentMaterial}。\n`)
  const taskKey = practiceTaskKey(task)
  const matchingState = prevState?.task_id === task.id && prevState.content_key === taskKey ? prevState : undefined
  if (prevState?.task_id === task.id && !matchingState) io.out('任务内容已更新，本次重新验收；工作目录中的作答保留。\n')
  if (!matchingState) store.write(courseId, 'practice-state', {
    node, task_id: task.id, updated_at: deps.today(), done_tests: [], done: false, attempts: 0, content_key: taskKey,
  })
  if (matchingState && !matchingState.done && matchingState.done_tests.length > 0) {
    io.out(`（续做：上次已通过 ${matchingState.done_tests.join('、')}）\n`)
  }

  let attempts = matchingState?.attempts ?? 0
  while (true) {
    io.out('\n回车运行测试（r 重跑，q 中止保存进度）> ')
    const line = await io.readLine()
    const command = (line ?? '').trim()
    if (line === null || command === 'q') {
      io.out('进度已保存，重新运行 practice 即可续做。\n')
      throw new FlowExit(0)
    }
    if (command !== '' && command !== 'r') continue

    io.out('运行测试…\n')
    const rawResults = await runTests(task, workdir, { signal: deps.io.signal })
    const results: Record<string, { exitCode: number; output: string; timedOut: boolean }> = {}
    for (const [index, test] of task.tests.entries()) {
      results[test.name] = rawResults[index]
    }
    attempts += 1
    const judge = judgePracticeTask(task, results)
    for (const item of judge.perTest) {
      io.out(`  ${item.passed ? '✓' : '✗'} ${item.name}${item.passed ? '' : `（${item.detail}）`}\n`)
    }
    store.write(courseId, 'practice-state', {
      node,
      task_id: task.id,
      updated_at: deps.today(),
      done_tests: judge.perTest.filter((i) => i.passed).map((i) => i.name),
      done: judge.done,
      attempts,
      content_key: taskKey,
    })
    if (!judge.done) {
      io.out(`未全部通过（${judge.perTest.filter((i) => i.passed).length}/${task.tests.length}）。修改代码后再按回车。\n`)
      continue
    }
    const updatedMastery = applyPracticeResult(mastery ?? {}, node, judge.score, deps.today())
    store.write(courseId, 'mastery', updatedMastery)
    try {
      appendMasteryEvent(store.root, courseId, { key: `practice:${task.id}:${taskKey}`, at: deps.today(), node, kind: 'practice', score: judge.score, passed: true })
    } catch { /* 辅助数据写入失败忽略 */ }
    const entry = updatedMastery[node]
    io.out(
      `\n实践完成！掌握度更新：${node} → ${entry.status}${entry.score !== undefined ? `（${entry.score}）` : ''}${entry.review_due !== undefined ? `，复习到期 ${entry.review_due}` : ''}\n`
    )
    io.out('可以回到课堂让导师点评你的实现：npm run agent -- learn ' + courseId + '\n')
    throw new FlowExit(0)
  }
}
