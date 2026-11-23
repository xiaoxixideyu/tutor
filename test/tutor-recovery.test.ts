import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { TutorSystem } from '../src/application/tutor-system.ts'
import { acquireCourseLock } from '../src/core/course-lock.ts'
import { activity, SKILL, scriptedTransport, systemFixture, toolReply } from './fixtures/tutor.ts'

it('查询不暂停其他进程，崩溃后恢复同一原始作答并只评分一次', async (t) => {
  let child: ChildProcess | undefined
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGKILL')
      await closed
    }
  })
  let grades = 0
  const fixture = systemFixture(
    t,
    scriptedTransport([], {
      called: (request) => {
        if (
          request.messages.some(
            (message) => message.role === 'system' && message.content?.includes('独立阅卷员'),
          )
        )
          grades++
      },
    }),
  )
  const { system, options, directory } = fixture
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  const content = activity()
  content.questions[0].type = 'open'
  system.service.presentActivity('alpha', content, 'activity', 1, 'seed')
  child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures/tutor-owner.ts'), directory], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) })
  assert.equal(message.type, 'ready')
  const before = system.repository.read('alpha')
  assert.equal(before.tutorStatus, 'working')
  const peer = new TutorSystem(options)
  t.after(() => peer.close())
  assert.equal(peer.service.view('alpha').tutorStatus, 'working')
  peer.service.list()
  peer.readToday()
  assert.equal(peer.repository.read('alpha').revision, before.revision)
  assert.throws(() => peer.start('alpha', { requestId: 'other-turn' }), { code: 'COURSE_BUSY', status: 409 })
  assert.throws(() => peer.resume('alpha', 'other-resume'), { code: 'COURSE_BUSY', status: 409 })
  assert.throws(() => peer.pause('alpha', 'other-pause'), { code: 'COURSE_BUSY', status: 409 })
  await assert.rejects(() => peer.remove('alpha'), { code: 'COURSE_BUSY', status: 409 })
  const view = system.service.view('alpha')
  assert.throws(
    () =>
      peer.answer('alpha', {
        requestId: 'other-answer',
        activityId: view.active!.id,
        questionId: 'q1',
        contentHash: view.active!.contentHash,
        answer: '5',
      }),
    { code: 'COURSE_BUSY', status: 409 },
  )
  assert.throws(
    () =>
      system.service.saveDraft('alpha', {
        activityId: view.active!.id,
        questionId: 'q1',
        answer: '未提交草稿',
      }),
    { code: 'PENDING_ANSWER', status: 409 },
  )
  const writeLock = acquireCourseLock(system.repository.root, 'alpha')
  writeLock.release()
  assert.equal(system.repository.read('alpha').revision, before.revision)
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
  const recovered = new TutorSystem(options)
  t.after(() => recovered.close())
  const paused = recovered.repository.read('alpha')
  assert.equal(paused.tutorStatus, 'paused')
  assert.equal(paused.pendingAnswer!.requestId, 'crashing-answer')
  assert.equal(paused.pendingAnswer!.activityId, before.pendingAnswer!.activityId)
  assert.equal(paused.pendingAnswer!.asset, before.pendingAnswer!.asset)
  recovered.resume('alpha', 'recover-answer')
  await recovered.wait('alpha')
  const completed = recovered.repository.read('alpha')
  assert.equal(completed.tutorStatus, 'idle')
  assert.equal(completed.pendingAnswer, undefined)
  const evidence = completed.evidence.filter((item) => item.kind === 'answer')
  assert.equal(evidence.length, 1)
  assert.equal(
    recovered.repository.asset<{ answer: string }>('alpha', evidence[0].asset).answer,
    '合并两个和三个，得到五个',
  )
  assert.equal(grades, 1)
  assert.equal(fs.existsSync(path.join(directory, 'courses/.runs/alpha.lock')), false)
})

it('运行时初始化失败会释放运行互斥，同一反馈可恢复且不重复保存', async (t) => {
  const fixture = systemFixture(
    t,
    scriptedTransport([toolReply('ask_learner', { question: '先看哪个例子？', reason: '澄清下一步' })]),
  )
  fixture.system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  const broken = new TutorSystem({
    ...fixture.options,
    runtimeFactory: () => {
      throw new Error('初始化失败')
    },
  })
  t.after(() => broken.close())
  const input = { requestId: 'retry', message: '先看例子' }
  assert.throws(() => broken.start('alpha', input), /初始化失败/)
  assert.equal(broken.activeJobs().length, 0)
  assert.equal(broken.repository.read('alpha').tutorStatus, 'failed')
  fixture.system.start('alpha', input)
  await fixture.system.wait('alpha')
  const state = fixture.system.repository.read('alpha')
  assert.equal(state.tutorStatus, 'idle')
  assert.equal(
    state.evidence.filter((item) => item.kind === 'feedback' && item.summary === '先看例子').length,
    1,
  )
})
