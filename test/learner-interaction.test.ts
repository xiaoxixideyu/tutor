import { it } from 'node:test'
import assert from 'node:assert/strict'
import { CourseService } from '../src/application/course-service.ts'
import { TutorSystem } from '../src/application/tutor-system.ts'
import { activity, SKILL, scriptedTransport, systemFixture, toolReply, setup } from './fixtures/tutor.ts'

it('导师澄清覆盖已有作答入口，回复后才重新交回原题', async (t) => {
  const { system } = systemFixture(
    t,
    scriptedTransport([
      toolReply('ask_learner', { question: '你希望用加法解决哪类问题？', reason: '澄清用途' }),
      toolReply('continue_activity', { reason: '用途已经明确，继续原题' }),
    ]),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.service.presentActivity('alpha', activity(), 'present', 1, 'seed')
  assert.equal(system.service.view('alpha').interaction.kind, 'answer')
  system.start('alpha', { requestId: 'ask', message: '请先了解我的用途' })
  await system.wait('alpha')
  const reply = system.service.view('alpha')
  assert.equal(reply.interaction.kind, 'reply')
  assert.equal(reply.active!.question!.id, 'q1')
  assert.throws(
    () =>
      system.answer('alpha', {
        requestId: 'stale-answer',
        activityId: reply.active!.id,
        questionId: 'q1',
        contentHash: reply.active!.contentHash,
        answer: '5',
        expectedRevision: reply.revision,
      }),
    { code: 'REPLY_REQUIRED' },
  )
  system.start('alpha', { requestId: 'reply', message: '想用在购物计算上' })
  await system.wait('alpha')
  assert.equal(system.service.view('alpha').interaction.kind, 'answer')
  assert.equal(system.service.view('alpha').active!.question!.id, 'q1')
})

it('暂停澄清后恢复同一个回复入口，不切回题目或新增模型调用', async (t) => {
  let calls = 0
  const { system } = systemFixture(
    t,
    scriptedTransport([toolReply('ask_learner', { question: '你想先处理哪个场景？', reason: '澄清用途' })], {
      called: () => {
        calls++
      },
    }),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.service.presentActivity('alpha', activity(), 'present', 1, 'seed')
  system.start('alpha', { requestId: 'ask' })
  await system.wait('alpha')
  const before = system.service.view('alpha').interaction
  system.pause('alpha', 'pause')
  assert.equal(system.service.view('alpha').interaction.kind, 'resume')
  const used = calls
  system.resume('alpha', 'resume')
  await system.wait('alpha')
  assert.deepEqual(system.service.view('alpha').interaction, before)
  assert.equal(calls, used)
})

it('提示仍交回作答，解释只交回继续，原始问题及提示记录保留', (t) => {
  const { service, repository } = setup(t)
  service.presentActivity('alpha', activity(), 'present', 1, 'seed')
  service.message('alpha', '先合并两个数量', 'hint', 'seed', repository.read('alpha').revision, '提示', true)
  assert.equal(service.view('alpha').interaction.kind, 'answer')
  assert.equal(service.activity(repository.read('alpha'))!.record.assistance.q1, 1)
  service.presentActivity(
    'alpha',
    activity('', '', { kind: 'explanation', questions: [] }),
    'explain',
    repository.read('alpha').revision,
    'seed',
  )
  assert.equal(service.view('alpha').interaction.kind, 'continue')
})

it('结束本次学习只有完成入口，未来安排及下一天的开始入口可追溯', async (t) => {
  const fixture = systemFixture(
    t,
    scriptedTransport([
      toolReply('finish_session', {
        outcome: 'time_up',
        reason: '本次时间已用完，下次独立检验',
        nextLabel: '无提示的整数加法任务',
        nextIntent: 'assess',
        nextDate: '2026-11-26',
      }),
    ]),
  )
  const system = new TutorSystem({ ...fixture.options, today: () => '2026-11-24' })
  t.after(() => system.close())
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.service.presentActivity('alpha', activity(), 'present', 1, 'seed')
  system.start('alpha', { requestId: 'finish', message: '今天先到这里' })
  await system.wait('alpha')
  const view = system.service.view('alpha')
  assert.equal(view.tutorStatus, 'paused')
  assert.equal(view.interaction.kind, 'complete')
  assert.equal(view.nextSuggestion!.date, '2026-11-26')
  const later = new CourseService(system.repository, () => '2026-11-27')
  const next = later.view('alpha').interaction
  assert.equal(next.kind, 'continue')
  if (next.kind === 'continue') assert.equal(next.intent, 'assess')
})
