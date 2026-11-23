import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { CourseRepository } from '../src/application/repository.ts'
import { competencyEligibility, goalSupported } from '../src/domain/evidence.ts'
import { digest, parseActivity, parseGoal, parseSkills } from '../src/domain/validation.ts'
import { DomainError, type Grade } from '../src/domain/model.ts'
import { activity, present, setup, SKILL, submit } from './fixtures/tutor.ts'

it('创建记录用户原话，日期必须是真实日历日', (t) => {
  const { repository, service } = setup(t)
  const state = repository.read('alpha')
  assert.equal(state.evidence[0].kind, 'feedback')
  assert.equal(state.learner.background, '有基础')
  assert.throws(() => parseGoal({ text: '学习', deadline: '2026-02-31' }), DomainError)
  assert.equal(service.create({ id: 'alpha', goal: '掌握整数加法', background: '有基础' }).id, 'alpha')
  assert.throws(() => service.create({ id: 'alpha', goal: '另一个目标' }), /不能覆盖/)
})

it('请求回执幂等；不同内容和过期版本不会覆盖当前状态', (t) => {
  const { repository } = setup(t),
    before = repository.read('alpha')
  const command = { expectedRevision: before.revision, requestId: 'once', input: { title: '新名称' } }
  const first = repository.transact('alpha', command, (state) => {
    state.title = '新名称'
    return { saved: true }
  })
  const duplicate = repository.transact('alpha', command, () => {
    throw new Error('不能执行第二次')
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.state.revision, first.state.revision)
  assert.throws(
    () => repository.transact('alpha', { ...command, input: { title: '不同名称' } }, () => ({})),
    /不能更改/,
  )
  assert.throws(() => repository.transact('alpha', { ...command, requestId: 'stale' }, () => ({})), /状态已变化/)
})

it('单次快照切换失败时旧状态和全部证据仍完整', (t) => {
  const { directory, repository } = setup(t),
    before = repository.read('alpha')
  const failing = new CourseRepository(repository.root, {
    beforeSwitch: () => {
      throw new Error('injected')
    },
  })
  const asset = failing.putAsset('alpha', { text: '新资产' })
  assert.throws(
    () =>
      failing.transact('alpha', { requestId: 'fail', input: {} }, (state) => {
        state.title = '未提交'
        state.sources.push({
          id: 'src',
          url: 'https://example.com',
          title: '资料',
          asset,
          fetchedAt: new Date().toISOString(),
        })
        return {}
      }),
    /injected/,
  )
  assert.deepEqual(repository.read('alpha'), before)
  assert.ok(fs.existsSync(directory))
  assert.deepEqual(failing.asset('alpha', asset), { text: '新资产' })
})

it('内容寻址资产发生外部改动会被发现', (t) => {
  const { repository } = setup(t),
    asset = repository.putAsset('alpha', { text: '原始证据' })
  fs.writeFileSync(repository.root + '/alpha/assets/' + asset + '.json', '{"text":"伪造"}')
  assert.throws(() => repository.asset('alpha', asset), /未登记的变化/)
})

it('保留跨单元前置；拒绝未知引用和前置环，关联关系可成环', () => {
  const other = {
    ...SKILL,
    id: 'advanced',
    title: '进阶',
    unit: '另一单元',
    criteria: [{ id: 'advanced-result', description: '应用', critical: true }],
    prerequisites: ['addition'],
    related: ['addition'],
  }
  const parsed = parseSkills([SKILL, other])
  assert.deepEqual(parsed[1].prerequisites, ['addition'])
  assert.throws(() => parseSkills([{ ...SKILL, prerequisites: ['missing'] }]), /不存在/)
  assert.throws(() => parseSkills([{ ...SKILL, prerequisites: ['advanced'] }, other]), /循环/)
  assert.equal(parseSkills([{ ...SKILL, related: ['advanced'] }, other]).length, 2)
})

it('数值等价答案必须等价，不能把错误数值列入 accept', (t) => {
  const { repository } = setup(t),
    state = repository.read('alpha'),
    content = activity('计算 1/2', '1/2')
  content.questions[0].accept = ['0.5']
  assert.equal(parseActivity(content, state).questions[0].answer, '1/2')
  content.questions[0].accept = ['3']
  assert.throws(() => parseActivity(content, state), /数学等价/)
})

it('一道基础题答对不会形成整项能力达成', (t) => {
  const { service, repository } = setup(t),
    content = activity()
  content.questions[0].difficulty = 1
  present(service, 'alpha', content)
  submit(service, 'alpha')
  const state = repository.read('alpha'),
    evidenceId = state.evidence.at(-1)!.id
  assert.equal(service.view('alpha').supported, 0)
  assert.throws(
    () =>
      service.recordJudgment(
        'alpha',
        { skillId: 'addition', status: 'supported', evidenceIds: [evidenceId], reason: '答对' },
        randomUUID(),
        state.revision,
      ),
    /独立成功证据/,
  )
  assert.equal(goalSupported(state), false)
})

it('成绩、教学活动完成与能力判断是独立状态', (t) => {
  const { service, repository } = setup(t)
  present(service, 'alpha')
  submit(service, 'alpha')
  const state = repository.read('alpha')
  assert.equal(state.activities[0].status, 'completed')
  assert.equal(state.currentActivityId, undefined)
  assert.equal(state.evidence.at(-1)!.kind, 'answer')
  assert.equal(service.view('alpha').goalSupported, false)
  assert.equal(service.view('alpha').skills[0].status, 'developing')
})

it('完整独立证据仍需显式评定和整体目标覆盖核查', (t) => {
  const { service, repository } = setup(t)
  present(service, 'alpha')
  submit(service, 'alpha')
  present(service, 'alpha', activity('5+6=?', '11'))
  submit(service, 'alpha', '11')
  let state = repository.read('alpha')
  assert.equal(competencyEligibility(state, state.skills[0]).eligible, true)
  service.recordJudgment(
    'alpha',
    {
      skillId: 'addition',
      status: 'supported',
      evidenceIds: state.evidence.filter((item) => item.kind === 'answer').map((item) => item.id),
      reason: '两次独立计算均正确',
    },
    randomUUID(),
    state.revision,
  )
  state = repository.read('alpha')
  assert.equal(goalSupported(state), false)
  repository.transact('alpha', { requestId: 'coverage', input: {} }, (next) => {
    next.goalCoverage = {
      complete: true,
      goalHash: digest(next.goal),
      skillsHash: digest(next.skills),
      reason: '范围完整',
    }
    return {}
  })
  assert.equal(service.view('alpha').goalSupported, true)
})

it('新题关键要求失败保留历史成功事实，并等待进一步验证', (t) => {
  const { service, repository } = setup(t)
  present(service, 'alpha')
  submit(service, 'alpha')
  present(service, 'alpha', activity('5+6=?', '11'))
  submit(service, 'alpha', '11')
  let state = repository.read('alpha')
  service.recordJudgment(
    'alpha',
    {
      skillId: 'addition',
      status: 'supported',
      evidenceIds: state.evidence.filter((e) => e.kind === 'answer').map((e) => e.id),
      reason: '达标',
    },
    randomUUID(),
    state.revision,
  )
  present(service, 'alpha', activity('6+7=?', '13'))
  submit(service, 'alpha', '0')
  state = repository.read('alpha')
  assert.equal(state.activities.filter((item) => item.status === 'completed').length, 3)
  assert.equal(state.evidence.filter((item) => item.kind === 'answer').length, 3)
  assert.equal(state.judgments.addition.status, 'needs_evidence')
})

it('不同日期重做原题产生新记录，但不是新的独立能力证据', (t) => {
  const { service, repository, setDay } = setup(t)
  present(service, 'alpha')
  submit(service, 'alpha')
  setDay('2026-11-21')
  present(service, 'alpha')
  submit(service, 'alpha')
  const evidence = repository.read('alpha').evidence.filter((item) => item.kind === 'answer')
  assert.equal(evidence.length, 2)
  assert.notEqual(evidence[0].id, evidence[1].id)
  assert.equal(evidence[1].independent, false)
  assert.equal(evidence[1].exposureCount, 2)
})

it('一次请求格式澄清不会冒充实际提示；给出提示后明确记录帮助', (t) => {
  const { service, repository } = setup(t)
  present(service, 'alpha')
  service.beginTurn('alpha', { requestId: 'clarify', message: '应该填一个数字吗？', intent: 'learn' })
  let state = repository.read('alpha')
  service.message('alpha', '只需填写数值。', 'clarification', 'clarify', state.revision, '澄清格式')
  state = repository.read('alpha')
  assert.equal(state.activities[0].assistance.q1, undefined)
  service.message('alpha', '把两个数量合在一起。', 'hint', 'clarify', state.revision, '提供思路', true)
  submit(service, 'alpha')
  const evidence = repository.read('alpha').evidence.at(-1)!
  assert.equal(evidence.kind, 'answer')
  if (evidence.kind === 'answer') {
    assert.equal(evidence.assisted, true)
    assert.equal(evidence.independent, false)
  }
})

it('已提交作答回执重放不重新计分，不允许改变原答案', (t) => {
  const { service, repository } = setup(t)
  present(service, 'alpha')
  const first = submit(service, 'alpha', '5', 'same')
  const before = repository.read('alpha')
  const second = service.commitAnswer('alpha', 'same', { score: 0, correct: false, feedback: '不应执行', criteria: [] })
  assert.equal(second.duplicate, true)
  assert.deepEqual(second.result, first.result)
  assert.deepEqual(repository.read('alpha'), before)
})

it('不完整或非法评分不提交，原始作答保留等待恢复', (t) => {
  const { service, repository } = setup(t)
  present(service, 'alpha')
  const view = service.view('alpha')
  service.beginAnswer('alpha', {
    requestId: 'pending',
    activityId: view.active!.id,
    questionId: 'q1',
    contentHash: view.active!.contentHash,
    answer: '原始答案',
  })
  const invalid: Grade = {
    score: 1,
    correct: true,
    feedback: '伪造',
    criteria: [{ id: 'unknown', met: true, note: '错误' }],
  }
  assert.throws(() => service.commitAnswer('alpha', 'pending', invalid), /量规/)
  const state = repository.read('alpha')
  assert.ok(state.pendingAnswer)
  assert.equal(repository.asset<{ answer: string }>('alpha', state.pendingAnswer!.asset).answer, '原始答案')
})

it('未提交的多行草稿可恢复，但不能作为成绩或能力证据', (t) => {
  const { service, repository } = setup(t)
  present(service, 'alpha')
  const view = service.view('alpha')
  service.saveDraft('alpha', {
    activityId: view.active!.id,
    questionId: 'q1',
    answer: '第一行\n第二行',
    draftVersion: 0,
  })
  service.pause('alpha', 'pause')
  assert.equal(service.view('alpha').active!.draft!.text, '第一行\n第二行')
  assert.equal(repository.read('alpha').evidence.filter((item) => item.kind === 'answer').length, 0)
  assert.throws(
    () =>
      service.saveDraft('alpha', { activityId: view.active!.id, questionId: 'q1', answer: '覆盖', draftVersion: 0 }),
    /另一个页面/,
  )
})

it('用户未接受的目标调整不生效，接受后保留过去证据', (t) => {
  const { service, repository } = setup(t)
  present(service, 'alpha')
  submit(service, 'alpha')
  let state = repository.read('alpha')
  const proposal = service.proposeGoal(
    'alpha',
    { goal: { text: '掌握整数乘法', dailyMinutes: 10, exclusions: [] }, explanation: '用户选择新的目标' },
    'propose',
    state.revision,
  )
  assert.equal(repository.read('alpha').goal.text, '掌握整数加法')
  service.resolveGoal('alpha', proposal.result.proposalId, true, 'accept', proposal.state.revision)
  state = repository.read('alpha')
  assert.equal(state.goal.text, '掌握整数乘法')
  assert.equal(state.evidence.filter((item) => item.kind === 'answer').length, 1)
  assert.equal(state.skills[0].required, false)
})

it('画像假设和多项能力评定作为一次更新提交，任一不合法则全部不生效', (t) => {
  const { service, repository } = setup(t)
  present(service, 'alpha')
  submit(service, 'alpha', '0')
  const before = repository.read('alpha')
  const evidenceId = before.evidence.at(-1)!.id
  const hypothesis = {
    description: '需要进一步检查求和思路',
    evidenceIds: [evidenceId],
    nextCheck: '独立完成另一道求和题',
  }
  assert.throws(
    () =>
      service.recordLearningUpdate(
        'alpha',
        {
          hypotheses: [hypothesis],
          judgments: [{ skillId: 'addition', status: 'supported', evidenceIds: [evidenceId], reason: '尚不能支持' }],
        },
        'invalid-batch',
        before.revision,
      ),
    /独立成功证据/,
  )
  assert.deepEqual(repository.read('alpha'), before)
  const changed = service.recordLearningUpdate(
    'alpha',
    {
      hypotheses: [hypothesis],
      judgments: [
        { skillId: 'addition', status: 'needs_evidence', evidenceIds: [evidenceId], reason: '新任务未满足要求' },
      ],
    },
    'valid-batch',
    before.revision,
  )
  assert.equal(changed.state.hypotheses.length, 1)
  assert.equal(changed.state.judgments.addition.status, 'needs_evidence')
  assert.equal(changed.state.revision, before.revision + 1)
})
