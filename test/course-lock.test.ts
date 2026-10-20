import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { acquireCourseLock, CourseBusyError } from '../src/core/course-lock.ts'
import { CourseStore } from '../src/core/store.ts'
import { createRpcMethods } from '../src/core/rpc.ts'
import { runFlowInProcess } from '../src/flows/run.ts'
import type { FlowIO } from '../src/flows/io.ts'

function tempRoot(t: { after(cb: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-lock-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

it('同一课程同时只能持有一把锁，释放后可重新获取', (t) => {
  const root = tempRoot(t)
  const first = acquireCourseLock(root, 'alpha')
  assert.throws(() => acquireCourseLock(root, 'alpha'), CourseBusyError)
  first.release()
  const second = acquireCourseLock(root, 'alpha')
  second.release()
})

it('同主机上已退出进程留下的锁会被回收', (t) => {
  const root = tempRoot(t)
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.ok(child.pid)
  const file = path.join(root, '.locks', 'alpha.lock')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, hostname: os.hostname(), startedAt: '2026-01-01T00:00:00.000Z', nonce: 'dead' }))
  const lock = acquireCourseLock(root, 'alpha')
  lock.release()
  assert.equal(fs.existsSync(file), false)
})

it('复习回写会遵守课程锁，不会覆盖另一个进程的进行中流程', (t) => {
  const root = tempRoot(t)
  const store = new CourseStore(root)
  store.create('alpha', { goal: '学习' })
  store.write('alpha', 'mastery', { a: { status: 'mastered', review_due: '2026-09-17' } })
  const methods = createRpcMethods(store, () => '2026-09-19')
  const held = acquireCourseLock(root, 'alpha')
  assert.throws(() => methods.applyReview({ id: 'alpha', node: 'a', score: 1 }), /另一个进程/)
  assert.equal((store.read('alpha', 'mastery') as { a: { review_due: string } }).a.review_due, '2026-09-17')
  held.release()
  const entry = methods.applyReview({ id: 'alpha', node: 'a', score: 1 }) as { review_due: string }
  assert.notEqual(entry.review_due, '2026-09-17')
})

it('流程启动会持锁并在退出后释放', async (t) => {
  const root = tempRoot(t)
  const store = new CourseStore(root)
  store.create('alpha', { goal: '学习' })
  const output: string[] = []
  const io: FlowIO = {
    out: () => {},
    err: (text) => output.push(text),
    readLine: async () => null,
    closeInput: () => {},
    signal: new AbortController().signal,
    tty: false,
  }
  const entry = acquireCourseLock(root, 'alpha')
  const busy = await runFlowInProcess({ kind: 'practice', courseId: 'alpha' }, io, {
    root, env: { TUTOR_COURSES_ROOT: root, TUTOR_WORKSPACE: root } as NodeJS.ProcessEnv,
  })
  assert.equal(busy, 1)
  assert.match(output.join(''), /另一个进程/)
  entry.release()

  const completed = await runFlowInProcess({ kind: 'practice', courseId: 'alpha' }, io, {
    root, env: { TUTOR_COURSES_ROOT: root, TUTOR_WORKSPACE: root } as NodeJS.ProcessEnv,
  })
  assert.equal(completed, 1)
  const after = acquireCourseLock(root, 'alpha')
  after.release()
})
