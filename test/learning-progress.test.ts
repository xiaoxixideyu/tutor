import { it } from 'node:test'
import assert from 'node:assert/strict'
import { activity, SKILL, setup, present, submit } from './fixtures/tutor.ts'

it('完成作答会记录学习投入，提示练习和未答对的记录不冒充独立达标', (t) => {
  const { service, repository } = setup(t)
  assert.equal(service.view('alpha').progress.completedAnswers, 0)
  assert.equal(service.view('alpha').progress.needsEvidence, 1)
  present(service, 'alpha', activity('2+3=?', '5', { kind: 'practice' }))
  service.message('alpha', '先合并两个数量', 'hint', 'seed', repository.read('alpha').revision, '提示', true)
  submit(service, 'alpha', '0', 'practice-answer')
  const afterPractice = service.view('alpha').progress
  assert.equal(afterPractice.completedAnswers, 1)
  assert.equal(afterPractice.developing, 1)
  assert.equal(afterPractice.supported, 0)
  service.commitAnswer('alpha', 'practice-answer', {
    score: 0,
    correct: false,
    feedback: '这次还未答对',
    criteria: [{ id: 'addition-result', met: false, note: '未满足要求' }],
  })
  assert.deepEqual(service.view('alpha').progress, afterPractice)
  present(service, 'alpha', activity('5+6=?', '11'))
  submit(service, 'alpha', '11')
  assert.equal(service.view('alpha').progress.completedAnswers, 2)
  assert.equal(service.view('alpha').progress.supported, 0)
  present(service, 'alpha', activity('6+7=?', '13'))
  submit(service, 'alpha', '13')
  const evidenceIds = repository
    .read('alpha')
    .evidence.filter((item) => item.kind === 'answer')
    .map((item) => item.id)
  service.recordJudgment(
    'alpha',
    { skillId: SKILL.id, status: 'supported', evidenceIds, reason: '两个不同应用任务均独立完成要求' },
    'verify',
    repository.read('alpha').revision,
  )
  assert.deepEqual(service.view('alpha').progress, {
    completedAnswers: 3,
    developing: 0,
    supported: 1,
    needsEvidence: 0,
    total: 1,
  })
  assert.deepEqual(service.list()[0].progress, service.view('alpha').progress)
})

it('一道题涉及多项能力时只计一次作答，调整当前目标后仍保留累计投入', (t) => {
  const { service, repository } = setup(t)
  const other = {
    ...SKILL,
    id: 'application',
    title: '购物计算',
    criteria: [{ id: 'application-result', description: '独立完成购物计算', critical: true }],
  }
  service.updateCurriculum('alpha', { skills: [SKILL, other], reason: '同时练习两项能力' }, 'skills', 1)
  const content = activity('购物时合计2元和3元是多少？', '5', { skillIds: [SKILL.id, other.id] })
  content.questions[0].criterionIds.push('application-result')
  present(service, 'alpha', content)
  submit(service, 'alpha')
  const view = service.view('alpha')
  assert.equal(view.progress.completedAnswers, 1)
  assert.equal(view.progress.developing, 2)
  assert.equal(view.progress.total, 2)
  assert.deepEqual(
    view.skills.map((skill) => skill.evidenceCount),
    [1, 1],
  )
  const proposal = service.proposeGoal(
    'alpha',
    { goal: { text: '学习新的计算场景' }, explanation: '根据新的需求调整目标' },
    'new-goal',
    repository.read('alpha').revision,
  )
  service.resolveGoal('alpha', proposal.result.proposalId, true, 'accept', repository.read('alpha').revision)
  assert.deepEqual(service.view('alpha').progress, {
    completedAnswers: 1,
    developing: 0,
    supported: 0,
    needsEvidence: 0,
    total: 0,
  })
})
