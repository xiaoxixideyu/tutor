import { it } from 'node:test'
import assert from 'node:assert/strict'
import { CourseService } from '../src/application/course-service.ts'
import { TutorSystem } from '../src/application/tutor-system.ts'
import type { LearnerInteraction } from '../src/domain/model.ts'
import { activity, SKILL, scriptedTransport, systemFixture, toolReply, setup } from './fixtures/tutor.ts'

function assertSummary(service: CourseService, kind: LearnerInteraction['kind']) {
  const view = service.view('alpha')
  const summary = service.list()[0]
  assert.equal(view.interaction.kind, kind)
  assert.deepEqual(summary.interaction, { kind })
  assert.deepEqual(summary.progress, view.progress)
}

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
  assertSummary(system.service, 'answer')
  system.start('alpha', { requestId: 'ask', message: '请先了解我的用途' })
  await system.wait('alpha')
  const reply = system.service.view('alpha')
  assert.equal(reply.interaction.kind, 'reply')
  assertSummary(system.service, 'reply')
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
  assertSummary(system.service, 'answer')
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
  assertSummary(system.service, 'reply')
  system.pause('alpha', 'pause')
  assertSummary(system.service, 'resume')
  const used = calls
  system.resume('alpha', 'resume')
  await system.wait('alpha')
  assert.deepEqual(system.service.view('alpha').interaction, before)
  assertSummary(system.service, 'reply')
  assert.equal(calls, used)
})

it('提示仍交回作答，解释只交回继续，原始问题及提示记录保留', (t) => {
  const { service, repository } = setup(t)
  service.presentActivity('alpha', activity(), 'present', 1, 'seed')
  service.message('alpha', '先合并两个数量', 'hint', 'seed', repository.read('alpha').revision, '提示', true)
  assertSummary(service, 'answer')
  assert.equal(service.activity(repository.read('alpha'))!.record.assistance.q1, 1)
  service.presentActivity(
    'alpha',
    activity('', '', { kind: 'explanation', questions: [] }),
    'explain',
    repository.read('alpha').revision,
    'seed',
  )
  assertSummary(service, 'continue')
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
  assert.equal(view.goalSupported, false)
  assertSummary(system.service, 'complete')
  assert.deepEqual(system.readToday().courses[0].interaction, { kind: 'complete' })
  assert.equal(view.nextSuggestion!.date, '2026-11-26')
  const later = new CourseService(system.repository, () => '2026-11-27')
  const next = later.view('alpha').interaction
  assert.equal(next.kind, 'continue')
  assertSummary(later, 'continue')
  if (next.kind === 'continue') assert.equal(next.intent, 'assess')
})

it('摘要遵循暂停、失败、目标确认和处理中入口，读取不修改学习状态', (t) => {
  const { service, repository } = setup(t)
  assertSummary(service, 'continue')
  service.presentActivity('alpha', activity(), 'present', 1, 'seed')
  service.pause('alpha', 'pause')
  assertSummary(service, 'resume')
  service.finishTurn('alpha', 'failed-turn', { error: '连接中断' })
  assertSummary(service, 'resume')
  service.finishTurn('alpha', 'failed-turn')
  service.proposeGoal(
    'alpha',
    { goal: { text: '把整数加法应用到购物计算' }, explanation: '根据学员用途调整目标' },
    'proposal',
    repository.read('alpha').revision,
  )
  assertSummary(service, 'proposal')
  service.beginTurn('alpha', { requestId: 'working', intent: 'learn', message: '请解释这个目标调整' })
  assertSummary(service, 'waiting')
  const before = repository.read('alpha')
  service.list()
  service.list()
  assert.deepEqual(repository.read('alpha'), before)
})

it('回复摘要不加载导师正文，列表与今日查询不触发模型或写入', async (t) => {
  const { system } = systemFixture(
    t,
    scriptedTransport([toolReply('ask_learner', { question: '你想解决什么具体问题？', reason: '澄清用途' })]),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.start('alpha', { requestId: 'ask' })
  await system.wait('alpha')
  const state = system.repository.read('alpha')
  const turn = state.learnerTurn
  assert.equal(turn?.kind, 'reply')
  if (turn?.kind !== 'reply') throw new Error('导师没有交回回复入口')
  const asset = system.repository.asset.bind(system.repository)
  t.mock.method(system.repository, 'asset', (courseId: string, hash: string) => {
    assert.notEqual(hash, turn.promptAsset, '摘要不应读取导师正文')
    return asset(courseId, hash)
  })
  const used = system.usageLedger.read().length
  assert.deepEqual(system.service.list()[0].interaction, { kind: 'reply' })
  assert.deepEqual(system.readToday().courses[0].interaction, { kind: 'reply' })
  assert.equal(system.usageLedger.read().length, used)
  assert.deepEqual(system.repository.read('alpha'), state)
})
