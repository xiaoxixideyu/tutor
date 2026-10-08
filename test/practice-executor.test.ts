import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureStarterFiles, runTests } from '../src/plugin/practice-executor.ts'
import { validatePracticeTasks } from '../src/core/practice.ts'

const task = { id: 'task', node: 'topic', title: '任务', prompt: '完成任务', tests: [{ name: 'check', command: 'true' }], starter_files: [{ path: 'README.md', content: '原要求' }] }

it('任务修复更新未修改的模板，保留学员改动并另存新模板', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-starter-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  ensureStarterFiles(task, root)
  const corrected = { ...task, starter_files: [{ path: 'README.md', content: '修正要求' }] }
  ensureStarterFiles(corrected, root)
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '修正要求')
  fs.writeFileSync(path.join(root, 'README.md'), '学员笔记')
  const next = { ...task, starter_files: [{ path: 'README.md', content: '新要求' }] }
  const result = ensureStarterFiles(next, root)
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '学员笔记')
  assert.equal(fs.readFileSync(result.preserved[0].currentMaterial, 'utf8'), '新要求')
  assert.deepEqual(ensureStarterFiles(next, root).preserved, result.preserved)
})

it('初始文件拒绝目录逃逸和符号链接；重复任务或测试名不能造成错误判分', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-path-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const unsafe of ['../outside', '/absolute', 'a/../../outside', 'C:\\outside', '.tutor-starters.json']) {
    const invalid = { ...task, starter_files: [{ path: unsafe, content: 'bad' }] }
    assert.equal(validatePracticeTasks({ generated_at: '2026-10-08', tasks: [invalid] }).ok, false)
    assert.throws(() => ensureStarterFiles(invalid, path.join(root, 'work')))
  }
  fs.writeFileSync(path.join(root, 'protected.txt'), '保留')
  fs.symlinkSync(path.join(root, 'protected.txt'), path.join(root, 'work', 'README.md'))
  assert.throws(() => ensureStarterFiles(task, path.join(root, 'work')), /符号链接/)
  assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), '保留')
  assert.equal(validatePracticeTasks({ generated_at: '2026-10-08', tasks: [task, task] }).ok, false)
  assert.equal(validatePracticeTasks({ generated_at: '2026-10-08', tasks: [{ ...task, tests: [task.tests[0], task.tests[0]] }] }).ok, false)
})

it('实践进程不继承服务凭据，超时会终止子进程组并及时返回', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-exec-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const previous = process.env.TUTOR_LLM_API_KEY
  process.env.TUTOR_LLM_API_KEY = 'test-only-sentinel'
  try {
    const checked = await runTests({ ...task, tests: [{ name: 'env', command: 'test -z "$TUTOR_LLM_API_KEY" && echo ENV_CLEAN' }] }, root)
    assert.equal(checked[0].exitCode, 0)
    assert.match(checked[0].output, /ENV_CLEAN/)
  } finally {
    if (previous === undefined) delete process.env.TUTOR_LLM_API_KEY
    else process.env.TUTOR_LLM_API_KEY = previous
  }
  const started = Date.now()
  const result = await runTests({ ...task, tests: [{ name: 'process-tree', command: 'sleep 5 & wait' }] }, root, { timeoutMs: 40 })
  assert.equal(result[0].timedOut, true)
  assert.ok(Date.now() - started < 2000)
})
