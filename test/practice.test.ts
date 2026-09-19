import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CourseStore } from '../src/core/store.ts'
import {
  applyPracticeResult,
  buildPracticeGenPrompt,
  buildPracticeIntro,
  judgePracticeTask,
  judgeTest,
  validatePracticeTasks,
} from '../src/core/practice.ts'
import type { PracticeTask } from '../src/core/schema.ts'

const validFile = {
  generated_at: '2026-09-20',
  tasks: [
    {
      id: 'go-setup-basics-hello',
      node: 'go-setup-basics',
      title: '第一个 Go 程序',
      prompt: '初始化模块并打印 hello, tutor',
      starter_files: [{ path: 'README.md', content: '# 任务' }],
      tests: [
        { name: 'go-mod-exists', command: 'test -f go.mod' },
        { name: 'output-correct', command: 'go run .', expect_output_contains: ['hello, tutor'] },
      ],
      hints: ['go mod init hello'],
    },
  ],
}

describe('validatePracticeTasks', () => {
  it('合法文件通过', () => {
    const result = validatePracticeTasks(validFile)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.tasks[0].tests.length, 2)
  })

  it('node 不匹配报错；tests 空报错；空命令报错', () => {
    assert.equal(validatePracticeTasks(validFile, 'goroutines').ok, false)
    const noTests = { ...validFile, tasks: [{ ...validFile.tasks[0], tests: [] }] }
    assert.match(String((validatePracticeTasks(noTests) as { error?: string }).error ?? ''), /tests/)
    const emptyCommand = {
      ...validFile,
      tasks: [{ ...validFile.tasks[0], tests: [{ name: 'x', command: '  ' }] }],
    }
    assert.equal(validatePracticeTasks(emptyCommand).ok, false)
  })

  it('同知识点任务超过 2 个报错', () => {
    const tooMany = {
      generated_at: '2026-09-20',
      tasks: [
        { ...validFile.tasks[0], id: 'go-setup-basics-a' },
        { ...validFile.tasks[0], id: 'go-setup-basics-b' },
        { ...validFile.tasks[0], id: 'go-setup-basics-c' },
      ],
    }
    assert.equal(validatePracticeTasks(tooMany).ok, false)
  })
})

describe('judgeTest', () => {
  const test: Parameters<typeof judgeTest>[1] = { name: 't', command: 'x', expect_output_contains: ['PASS'] }

  it('exit 与 contains 全匹配才通过', () => {
    assert.equal(judgeTest({ exitCode: 0, output: 'PASS ok', timedOut: false }, test), true)
    assert.equal(judgeTest({ exitCode: 3, output: 'PASS ok', timedOut: false }, test), false)
    assert.equal(judgeTest({ exitCode: 0, output: 'FAIL', timedOut: false }, test), false)
    assert.equal(judgeTest({ exitCode: 0, output: 'PASS', timedOut: true }, test), false)
  })

  it('默认期望 exit=0', () => {
    const bare: Parameters<typeof judgeTest>[1] = { name: 't', command: 'x' }
    assert.equal(judgeTest({ exitCode: 0, output: '', timedOut: false }, bare), true)
    assert.equal(judgeTest({ exitCode: 1, output: '', timedOut: false }, bare), false)
  })
})

describe('judgePracticeTask', () => {
  const task: PracticeTask = validFile.tasks[0]

  it('全通过 done+score=1；部分通过给比例与明细', () => {
    const all = judgePracticeTask(task, {
      'go-mod-exists': { exitCode: 0, output: '', timedOut: false },
      'output-correct': { exitCode: 0, output: 'hello, tutor', timedOut: false },
    })
    assert.equal(all.done, true)
    assert.equal(all.score, 1)
    const partial = judgePracticeTask(task, {
      'go-mod-exists': { exitCode: 0, output: '', timedOut: false },
      'output-correct': { exitCode: 1, output: 'oops', timedOut: false },
    })
    assert.equal(partial.done, false)
    assert.equal(partial.score, 0.5)
    assert.equal(partial.perTest[1].passed, false)
    assert.match(partial.perTest[1].detail, /exit=1/)
  })

  it('未执行的测试判失败（明细：未执行）', () => {
    const result = judgePracticeTask(task, {})
    assert.equal(result.done, false)
    assert.equal(result.perTest[0].detail, '未执行')
  })
})

describe('applyPracticeResult', () => {
  it('未全通过：原样返回（不降级）', () => {
    const mastery = { a: { status: 'learning' as const, score: 0.6, review_stage: 2, review_due: '2026-09-25' } }
    assert.equal(applyPracticeResult(mastery, 'a', 0.5, '2026-09-20'), mastery)
  })

  it('通过且未 mastered：score 保底 0.8 并走掌握度更新（建复习阶梯）', () => {
    const mastery = { a: { status: 'weak' as const, score: 0.33 } }
    const updated = applyPracticeResult(mastery, 'a', 1, '2026-09-20')
    assert.equal(updated.a.status, 'mastered')
    assert.equal(updated.a.score, 0.8)
    assert.equal(updated.a.review_due, '2026-09-21')
    assert.equal(updated.a.review_stage, 1)
  })

  it('通过且已 mastered：仅 score 保底，复习阶梯不动', () => {
    const mastery = { a: { status: 'mastered' as const, score: 1, review_stage: 3, review_due: '2026-09-27' } }
    const updated = applyPracticeResult(mastery, 'a', 1, '2026-09-20')
    assert.equal(updated.a.status, 'mastered')
    assert.equal(updated.a.score, 1)
    assert.equal(updated.a.review_stage, 3)
    assert.equal(updated.a.review_due, '2026-09-27')
  })

  it('不影响其他节点', () => {
    const mastery = { a: { status: 'weak' as const, score: 0.3 }, b: { status: 'mastered' as const, score: 1 } }
    const updated = applyPracticeResult(mastery, 'a', 1, '2026-09-20')
    assert.equal(updated.b.status, 'mastered')
  })
})

describe('prompt 构建', () => {
  it('gen prompt 含知识点、测试约束与 JSON 模板', () => {
    const prompt = buildPracticeGenPrompt({ courseId: 'golang', node: 'go-setup-basics', title: '基础', goal: '学会 Go' })
    assert.match(prompt, /go-setup-basics/)
    assert.match(prompt, /GOPROXY=off|无网络依赖|确定性/)
    assert.match(prompt, /"tasks"/)
  })

  it('intro 含工作目录、测试命令与期望', () => {
    const intro = buildPracticeIntro(validFile.tasks[0], '/tmp/work')
    assert.match(intro, /\/tmp\/work/)
    assert.match(intro, /go run \./)
    assert.match(intro, /hello, tutor/)
    assert.match(intro, /中止/)
  })
})

describe('store round-trip', () => {
  it('practice 与 practice-state 写读一致，非法数据抛错', () => {
    const store = new CourseStore(fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-practice-')))
    store.create('demo', { goal: 'x' })
    store.write('demo', 'practice', validFile)
    const readBack = store.read('demo', 'practice') as typeof validFile
    assert.equal(readBack.generated_at, '2026-09-20')
    assert.equal(readBack.tasks.length, 1)
    assert.equal(readBack.tasks[0].id, 'go-setup-basics-hello')
    assert.equal(readBack.tasks[0].tests[1].expect_output_contains?.[0], 'hello, tutor')
    const state = { node: 'go-setup-basics', task_id: 'go-setup-basics-hello', updated_at: '2026-09-20', done_tests: ['go-mod-exists'], done: false, attempts: 1 }
    store.write('demo', 'practice-state', state)
    const stateBack = store.read('demo', 'practice-state') as typeof state
    assert.equal(stateBack.done, false)
    assert.deepEqual(stateBack.done_tests, ['go-mod-exists'])
    // schema 层（schemastery 对 object 数组的 min 不生效）不管 tasks 非空——空 tasks 由 store 无 schema 校验兜不住，
    // 但 PracticeTaskFileSchema 会拒绝缺 generated_at 的数据
    assert.throws(() => store.write('demo', 'practice', { tasks: validFile.tasks }), /校验失败/)
  })
})
