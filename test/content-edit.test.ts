import { it } from 'node:test'
import assert from 'node:assert/strict'
import { applyPracticeEdits, practiceRepairPrompt } from '../src/core/content-edit.ts'
import type { PracticeTaskFile } from '../src/core/schema.ts'

const tasks = [{ id: 'dice-task', node: 'dice', title: '练习', prompt: '只掷一次骰子',
  starter_files: [{ path: 'README.md', content: '基础要求\n可选：再掷 30 次并记录频率\n结束' }], tests: [{ name: 'answer', command: 'test -f answer.txt', expect_output_contains: [] }] }]

it('局部修复精确替换被拒片段，保留任务身份、题干与测试且不改变原对象', () => {
  const result = applyPracticeEdits(tasks, { edits: [{ path: '/0/starter_files/0/content', before: '可选：再掷 30 次并记录频率\n', after: '' }] }, 'dice', '2026-10-08')
  assert.equal(result.ok, true)
  if (!result.ok) return
  const repaired = (result.value as PracticeTaskFile).tasks[0]
  assert.equal(repaired.starter_files?.[0].content, '基础要求\n结束')
  assert.deepEqual(repaired.tests, tasks[0].tests)
  assert.equal(repaired.id, tasks[0].id)
  assert.match(tasks[0].starter_files[0].content, /30 次/)
  assert.match(practiceRepairPrompt(tasks, { goal: '骰子', requests: ['只上一节，不做重复实验'] }, ['删除扩展活动']), /只上一节/)
})

it('拒绝不存在、不唯一、无变化或修改任务身份的编辑，不执行路径表达式', () => {
  for (const edit of [
    { path: '/0/id', before: 'dice-task', after: 'evil' },
    { path: '/0/__proto__/x', before: 'x', after: 'y' },
    { path: '/10/prompt', before: 'x', after: 'y' },
    { path: '/0/prompt', before: '不存在', after: '' },
    { path: '/0/prompt', before: '', after: '插入' },
    { path: '/0/prompt', before: '一次', after: '一次' },
  ]) assert.equal(applyPracticeEdits(tasks, { edits: [edit] }, 'dice', '2026-10-08').ok, false)
  const repeated = [{ ...tasks[0], prompt: '重复重复' }]
  assert.equal(applyPracticeEdits(repeated, { edits: [{ path: '/0/prompt', before: '重复', after: '一次' }] }, 'dice', '2026-10-08').ok, false)
})
