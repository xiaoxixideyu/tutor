import { updateMasteryForNode } from './assessment.ts'
import { PracticeTaskFileSchema, type Mastery, type PracticeTask, type PracticeTaskFile, type PracticeTest } from './schema.ts'

// 实践任务（三期）：学员在 workdir 写代码 → 跑规则化测试 → 判分联动掌握度。
// 判分与 prompt 构建是纯核心；执行在壳/执行器（见 src/plugin/practice-executor.ts）。

export interface PracticeGenInput {
  courseId: string
  node: string
  title?: string
  summary?: string
  goal: string
  background?: string
  style?: string
}

export function validatePracticeTasks(file: unknown, expectedNode?: string): { ok: true; value: PracticeTaskFile } | { ok: false; error: string } {
  let value: PracticeTaskFile
  try {
    value = PracticeTaskFileSchema(file) as PracticeTaskFile
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.replace(/\n+/g, ' ') : String(error) }
  }
  if (value.tasks.length < 1) return { ok: false, error: 'tasks 不能为空' }
  const nodeCounts = new Map<string, number>()
  for (const [index, task] of value.tasks.entries()) {
    if (expectedNode && task.node !== expectedNode) {
      return { ok: false, error: `任务 "${task.id}" 的 node 为 "${task.node}"，应为 "${expectedNode}"` }
    }
    nodeCounts.set(task.node, (nodeCounts.get(task.node) ?? 0) + 1)
    if (nodeCounts.get(task.node)! > 2) {
      return { ok: false, error: `知识点 ${task.node} 的任务数量超过 2` }
    }
    if (task.tests.length < 1 || task.tests.length > 5) {
      return { ok: false, error: `任务 "${task.id}" 的 tests 需 1-5 条，当前 ${task.tests.length}` }
    }
    for (const test of task.tests) {
      if (test.command.trim() === '') return { ok: false, error: `任务 "${task.id}" 存在空测试命令` }
    }
  }
  return { ok: true, value }
}

export interface TestResult {
  exitCode: number
  output: string
  timedOut: boolean
}

export function judgeTest(result: TestResult, test: PracticeTest): boolean {
  if (result.timedOut) return false
  if (result.exitCode !== (test.expect_exit ?? 0)) return false
  return (test.expect_output_contains ?? []).every((needle) => result.output.includes(needle))
}

export interface PracticeJudgeItem {
  name: string
  passed: boolean
  detail: string
}

export function judgePracticeTask(
  task: PracticeTask,
  results: Record<string, TestResult>
): { done: boolean; score: number; perTest: PracticeJudgeItem[] } {
  const perTest: PracticeJudgeItem[] = task.tests.map((test) => {
    const result = results[test.name]
    if (!result) return { name: test.name, passed: false, detail: '未执行' }
    const passed = judgeTest(result, test)
    const parts: string[] = [`exit=${result.exitCode}`]
    if (result.timedOut) parts.push('超时')
    if (!passed && test.expect_exit !== undefined && result.exitCode !== test.expect_exit) parts.push(`期望 exit=${test.expect_exit}`)
    if (!passed && (test.expect_output_contains ?? []).some((needle) => !result.output.includes(needle))) {
      const missing = (test.expect_output_contains ?? []).filter((needle) => !result.output.includes(needle))
      parts.push(`输出缺少：${missing.join('、')}`)
    }
    return { name: test.name, passed, detail: parts.join('，') }
  })
  const passedCount = perTest.filter((item) => item.passed).length
  return {
    done: passedCount === task.tests.length,
    score: Math.round((passedCount / task.tests.length) * 100) / 100,
    perTest,
  }
}

// 实践结果合并掌握度：全通过才更新（不降级）。
// 已 mastered：仅把 score 保底到 max(现值, 0.8)，review 阶梯不动（practice 不推复习阶梯）。
// 未 mastered：走 updateMasteryForNode（score 取 max 保底 0.8，建立/推进复习阶梯）。
export function applyPracticeResult(mastery: Mastery, node: string, practiceScore: number, today: string): Mastery {
  if (practiceScore < 1) return mastery
  const previous = mastery[node]
  const floorScore = Math.max(previous?.score ?? 0, 0.8)
  if (previous?.status === 'mastered') {
    return { ...mastery, [node]: { ...previous, score: floorScore } }
  }
  return updateMasteryForNode(mastery, node, floorScore, today)
}

export function buildPracticeGenPrompt(input: PracticeGenInput): string {
  const lines = [
    `任务：为课程《${input.courseId}》的知识点设计 1 个动手实践任务（学员在终端写代码、跑规则化测试）。`,
    '',
    '【知识点】',
    `- ${input.node}${input.title ? `（${input.title}）` : ''}${input.summary ? `：${input.summary}` : ''}`,
    '',
    '【学员档案】',
    `- 学习目的：${input.goal}`,
    `- 现有基础：${input.background || '未填写'}`,
    `- 讲解偏好：${input.style || '未填写'}`,
    '',
    '【要求】',
    '- 单个任务：学员 10-20 分钟能完成；贴合学员基础与讲解偏好',
    '- starter_files 提供必要初始文件（如 README 说明）；不要提供答案文件',
    '- tests 为规则自动执行的 shell 命令（在工作目录逐条执行）：1-3 条，命令必须确定性、无网络依赖、无交互（不等待 stdin）；首条验证文件/模块存在，末条验证行为正确',
    '- expect_output_contains 只选稳定子串（如程序打印的固定文案），不要依赖编译器本地化提示或时间戳',
    '- 除 go 标准库外不引入第三方依赖（测试在 GOPROXY=off 下运行）',
    '- hints 给 1-2 条渐进提示（不直接给完整答案）',
    '',
    '请输出任务 JSON（```json 代码块）：',
    '{"tasks": [{"id": "' + input.node + '-<短slug>", "node": "' + input.node + '", "title": "…", "prompt": "给学员的任务描述（含步骤）", "starter_files": [{"path": "README.md", "content": "…"}], "tests": [{"name": "<短名>", "command": "…", "expect_exit": 0, "expect_output_contains": ["…"]}], "hints": ["…"]}]}',
    '除该 JSON 外不要输出其他内容。',
  ]
  return lines.join('\n')
}

export function buildPracticeIntro(task: PracticeTask, workdir: string): string {
  const lines = [
    `【实践任务】${task.title}`,
    ``,
    `工作目录：${workdir}`,
    `任务描述：`,
    task.prompt,
    '',
  ]
  if ((task.starter_files?.length ?? 0) > 0) {
    lines.push('已为你准备初始文件：')
    for (const file of task.starter_files ?? []) lines.push(`  - ${file.path}`)
    lines.push('')
  }
  lines.push('测试项（按回车执行）：')
  for (const [index, test] of task.tests.entries()) {
    const expectation =
      test.expect_output_contains && test.expect_output_contains.length > 0
        ? `输出须含 ${test.expect_output_contains.map((s) => `"${s}"`).join('、')}`
        : `退出码须为 ${test.expect_exit ?? 0}`
    lines.push(`  ${index + 1}. ${test.name}：${test.command}（${expectation}）`)
  }
  if ((task.hints?.length ?? 0) > 0) {
    lines.push('', '提示（卡住再看）：')
    for (const [index, hint] of (task.hints ?? []).entries()) {
      lines.push(`  ${index + 1}. ${hint}`)
    }
  }
  lines.push('', '操作：直接回车或输入 r 运行测试；输入 q 中止（进度已保存）。')
  return lines.join('\n')
}
