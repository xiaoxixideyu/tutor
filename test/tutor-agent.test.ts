import { it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { TutorSystem } from '../src/application/tutor-system.ts'
import { jsonReply, toolReply, scriptedTransport, systemFixture, SKILL, activity } from './fixtures/tutor.ts'
import type { LlmResult, LlmRequest } from '../src/runtime/llm.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('agent 可以选择先定义目标再独立检验，程序只执行它选择的能力', async (t) => {
  const { system } = systemFixture(
    t,
    scriptedTransport([
      toolReply('update_curriculum', { skills: [SKILL], reason: '定义可检验目标' }),
      toolReply('present_activity', activity()),
    ]),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.start('alpha', { requestId: 'first', intent: 'learn' })
  await system.wait('alpha')
  const state = system.repository.read('alpha'),
    view = system.service.view('alpha')
  assert.equal(view.active?.question?.id, 'q1')
  assert.equal(view.tutorStatus, 'idle')
  assert.deepEqual(
    state.decisions.map((item) => item.action),
    ['update_curriculum', 'present_activity'],
  )
  assert.ok(state.decisions.every((item) => item.status === 'executed'))
})

it('同一系统允许先解释、先诊断或直接迁移任务，不强制同一工序', async (t) => {
  for (const kind of ['explanation', 'diagnostic', 'transfer'] as const) {
    const content = activity('2+3=?', '5', { kind, ...(kind === 'explanation' ? { questions: [] } : {}) })
    const fixture = systemFixture(t, scriptedTransport([toolReply('present_activity', content)]))
    fixture.system.service.create({ id: 'alpha', goal: '掌握整数加法' })
    fixture.system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '已有近期目标' }, 'seed', 0)
    fixture.system.start('alpha', { requestId: randomUUID(), intent: 'learn' })
    await fixture.system.wait('alpha')
    assert.equal(fixture.system.service.view('alpha').active?.kind, kind)
    assert.equal(fixture.system.repository.read('alpha').decisions.length, 1)
  }
})

it('自述画像由模型依据原话更新，不用关键词给掌握状态赋值', async (t) => {
  let step = 0
  const { system } = systemFixture(
    t,
    scriptedTransport([], {
      primary: (request) => {
        const input = JSON.parse(request.messages.findLast((message) => message.role === 'user')!.content!)
        if (step++ === 0)
          return toolReply('update_learner', {
            background: '有 Java 后端经验',
            preferences: ['先看例子'],
            evidenceIds: [input.observation.evidence[0].id],
            reason: '学员在目标里明确说明',
          })
        return toolReply('ask_learner', { question: '你希望先解决哪个具体问题？', reason: '澄清目标用途' })
      },
    }),
  )
  system.service.create({ id: 'alpha', goal: '我会 Java，喜欢先看例子，想学 Go 并发' })
  system.start('alpha', { requestId: 'profile' })
  await system.wait('alpha')
  const state = system.repository.read('alpha')
  assert.deepEqual(state.learner.preferences, ['先看例子'])
  assert.equal(state.evidence.filter((item) => item.kind === 'answer').length, 0)
  assert.deepEqual(state.judgments, {})
})

it('只有自述的证据不能支持能力达成，即使 agent 提出 supported', async (t) => {
  let step = 0
  const { system } = systemFixture(
    t,
    scriptedTransport([], {
      primary: (request) => {
        const input = JSON.parse(request.messages.findLast((message) => message.role === 'user')!.content!)
        return step++ === 0
          ? toolReply('record_judgment', {
              skillId: 'addition',
              status: 'supported',
              evidenceIds: [input.observation.evidence[0].id],
              reason: '学员自述已经会',
            })
          : toolReply('ask_learner', { question: '先独立验证一次，好吗？', reason: '还缺实测证据' })
      },
    }),
  )
  system.service.create({ id: 'alpha', goal: '我已经会整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.start('alpha', { requestId: 'claim' })
  await system.wait('alpha')
  assert.equal(system.service.view('alpha').supported, 0)
  assert.equal(system.repository.read('alpha').decisions[0].status, 'rejected')
})

it('节点集合正确也不能忽略内容语义越界', async (t) => {
  const bad = activity()
  bad.body = '今天开始做微积分。'
  const { system } = systemFixture(
    t,
    scriptedTransport([toolReply('present_activity', bad)], {
      review: (request) => {
        const input = JSON.parse(request.messages.at(-1)!.content!)
        return input.kind === 'activity'
          ? { scope: 'fail', correctness: 'pass', issues: ['微积分不属于加法目标'], arithmetic: [] }
          : { scope: 'pass', correctness: 'pass', issues: [], arithmetic: [] }
      },
    }),
  )
  system.service.create({ id: 'alpha', goal: '只学习加法，不学习微积分' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.start('alpha', { requestId: 'scope' })
  await system.wait('alpha')
  assert.equal(system.service.view('alpha').active, null)
  assert.equal(system.repository.read('alpha').contentFailures?.length, 1)
})

it('实际修复候选后重新审核并发布，不靠重审抽成通过', async (t) => {
  let primary = 0
  const bad = activity()
  bad.body = '错误：加法就是乘法。'
  const good = activity()
  const { system } = systemFixture(
    t,
    scriptedTransport([], {
      primary: (request) => {
        if (primary++ === 0) return toolReply('present_activity', bad)
        const output = JSON.parse(request.messages.findLast((message) => message.role === 'tool')!.content!)
        return toolReply('repair_content', { taskId: output.taskId, reason: '根据具体错误修复' })
      },
      review: (request) => {
        if (request.messages[0].content!.includes('最小修复候选')) return { content: good }
        const input = JSON.parse(request.messages.at(-1)!.content!)
        return input.kind === 'activity' && input.content.body.includes('加法就是乘法')
          ? { scope: 'pass', correctness: 'fail', issues: ['加法与乘法含义不同'], arithmetic: [] }
          : { scope: 'pass', correctness: 'pass', issues: [], arithmetic: [] }
      },
    }),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.start('alpha', { requestId: 'repair' })
  await system.wait('alpha')
  const view = system.service.view('alpha')
  assert.equal(view.tutorError, null)
  assert.equal(view.active?.body, good.body)
  assert.deepEqual(
    system.repository.read('alpha').decisions.map((item) => item.status),
    ['rejected', 'executed'],
  )
})

it('暂停恢复沿用同一活动、题目和草稿，缓存恢复零新增模型调用', async (t) => {
  let calls = 0
  const { system } = systemFixture(
    t,
    scriptedTransport([toolReply('present_activity', activity())], {
      called: () => {
        calls++
      },
    }),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.start('alpha', { requestId: 'lesson' })
  await system.wait('alpha')
  const first = system.service.view('alpha')
  system.service.saveDraft('alpha', {
    activityId: first.active!.id,
    questionId: 'q1',
    answer: '思考中的草稿',
  })
  system.pause('alpha', 'pause')
  const before = calls
  system.resume('alpha', 'resume')
  await system.wait('alpha')
  const resumed = system.service.view('alpha')
  assert.equal(resumed.active!.id, first.active!.id)
  assert.equal(resumed.active!.question!.id, 'q1')
  assert.equal(resumed.active!.draft!.text, '思考中的草稿')
  assert.equal(calls, before)
})

it('每次作答后由 agent 决定继续还是改变教学策略', async (t) => {
  const original = activity()
  original.questions.push({ ...original.questions[0], id: 'q2', prompt: '5+6=?', answer: '11' })
  const explanation = activity('2+3=?', '5', {
    kind: 'explanation',
    questions: [],
    title: '用实物合并理解',
    body: '先看两个数量如何合在一起。',
  })
  const { system } = systemFixture(
    t,
    scriptedTransport([toolReply('present_activity', original), toolReply('present_activity', explanation)]),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.start('alpha', { requestId: 'first' })
  await system.wait('alpha')
  const view = system.service.view('alpha')
  system.answer('alpha', {
    requestId: 'answer',
    activityId: view.active!.id,
    questionId: 'q1',
    contentHash: view.active!.contentHash,
    answer: '0',
    expectedRevision: view.revision,
  })
  await system.wait('alpha')
  const state = system.repository.read('alpha')
  assert.equal(system.service.view('alpha').active!.kind, 'explanation')
  assert.equal(state.activities[0].status, 'paused')
  assert.equal(state.activities[0].index, 1)
  assert.equal(state.evidence.filter((item) => item.kind === 'answer').length, 1)
})

it('重复提交不再次评分或触发 agent，不能改变已提交答案', async (t) => {
  let calls = 0
  const content = activity()
  content.questions.push({ ...content.questions[0], id: 'q2', prompt: '5+6=?', answer: '11' })
  const { system } = systemFixture(
    t,
    scriptedTransport(
      [toolReply('present_activity', content), toolReply('continue_activity', { reason: '继续检验' })],
      {
        called: () => {
          calls++
        },
      },
    ),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.start('alpha', { requestId: 'first' })
  await system.wait('alpha')
  const view = system.service.view('alpha')
  const input = {
    requestId: 'same',
    activityId: view.active!.id,
    questionId: 'q1',
    contentHash: view.active!.contentHash,
    answer: '5',
    expectedRevision: view.revision,
  }
  system.answer('alpha', input)
  await system.wait('alpha')
  const before = calls,
    count = system.repository.read('alpha').evidence.length
  assert.equal(system.answer('alpha', input).duplicate, true)
  assert.equal(calls, before)
  assert.equal(system.repository.read('alpha').evidence.length, count)
  assert.throws(() => system.answer('alpha', { ...input, answer: '0' }), /不能更改/)
})

it('处理中和完成后的教学请求校验原始反馈与意图，预算用尽也可重放', async (t) => {
  const entered = deferred(),
    release = deferred()
  let calls = 0
  const transport = scriptedTransport([
    toolReply('ask_learner', { question: '先从哪一部分开始？', reason: '澄清下一步' }),
  ])
  const { system } = systemFixture(t, async (request, signal, onChunk) => {
    calls++
    if (request.tools?.some((tool) => tool.name === 'present_activity')) {
      entered.resolve()
      await release.promise
    }
    return transport(request, signal, onChunk)
  })
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  const input = { requestId: 'same-turn', message: '先看例子', intent: 'learn' as const }
  const first = system.start('alpha', input)
  try {
    await entered.promise
    const before = system.repository.read('alpha')
    const duplicate = system.start('alpha', { ...input, message: '  先看例子  ' })
    assert.equal(duplicate.resumed, true)
    assert.equal(duplicate.job!.id, first.job!.id)
    assert.throws(() => system.start('alpha', { ...input, message: '先做题' }), {
      code: 'ALREADY_SUBMITTED',
      status: 409,
    })
    assert.throws(() => system.start('alpha', { ...input, intent: 'exam' }), {
      code: 'ALREADY_SUBMITTED',
      status: 409,
    })
    assert.equal(system.repository.read('alpha').revision, before.revision)
    assert.equal(system.activeJobs().length, 1)
    assert.equal(calls, 1)
  } finally {
    release.resolve()
    await system.wait('alpha')
  }
  const callsAfter = calls
  assert.equal(system.repository.read('alpha').turns[input.requestId].status, 'completed')
  system.usageLedger.record({
    id: 'exhausted-budget',
    at: new Date().toISOString(),
    day: system.today(),
    model: 'fixture',
    role: 'tutor',
    courseId: 'alpha',
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 10,
    unknown: false,
  })
  const before = system.repository.read('alpha')
  assert.equal(system.start('alpha', input).duplicate, true)
  assert.throws(() => system.start('alpha', { ...input, message: '改后的反馈' }), {
    code: 'ALREADY_SUBMITTED',
    status: 409,
  })
  assert.throws(() => system.start('alpha', { ...input, intent: 'exam' }), {
    code: 'ALREADY_SUBMITTED',
    status: 409,
  })
  assert.throws(() => system.start('alpha', { ...input, requestId: 'new-turn' }), {
    code: 'BUDGET_EXCEEDED',
    status: 429,
  })
  assert.equal(system.repository.read('alpha').revision, before.revision)
  assert.equal(calls, callsAfter)
})

it('正在评分的同一请求不能更改答案或题目身份，重试沿用原作答', async (t) => {
  const entered = deferred(),
    release = deferred()
  let graderCalls = 0
  const content = activity()
  content.questions[0].type = 'open'
  const transport = scriptedTransport([toolReply('present_activity', content)])
  const { system } = systemFixture(t, async (request, signal, onChunk) => {
    if (
      request.messages.some((message) => message.role === 'system' && message.content?.includes('独立阅卷员'))
    ) {
      graderCalls++
      entered.resolve()
      await release.promise
    }
    return transport(request, signal, onChunk)
  })
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.start('alpha', { requestId: 'first' })
  await system.wait('alpha')
  const view = system.service.view('alpha')
  const input = {
    requestId: 'same-answer',
    activityId: view.active!.id,
    questionId: 'q1',
    contentHash: view.active!.contentHash,
    answer: '5',
    expectedRevision: view.revision,
  }
  const first = system.answer('alpha', input)
  try {
    await entered.promise
    const before = system.repository.read('alpha')
    const duplicate = system.answer('alpha', { ...input, answer: ' 5 ' })
    assert.equal(duplicate.resumed, true)
    assert.equal(duplicate.job!.id, first.job!.id)
    for (const changed of [
      { answer: '0' },
      { activityId: 'different-activity' },
      { questionId: 'different-question' },
      { contentHash: '0'.repeat(64) },
    ])
      assert.throws(() => system.answer('alpha', { ...input, ...changed }), {
        code: 'ALREADY_SUBMITTED',
        status: 409,
      })
    assert.throws(() => system.start('alpha', { requestId: input.requestId }), {
      code: 'ALREADY_SUBMITTED',
      status: 409,
    })
    assert.equal(system.repository.read('alpha').revision, before.revision)
    assert.equal(graderCalls, 1)
  } finally {
    release.resolve()
    await system.wait('alpha')
  }
  const evidence = system.repository.read('alpha').evidence.filter((item) => item.kind === 'answer')
  assert.equal(evidence.length, 1)
  assert.equal(system.repository.asset<{ answer: string }>('alpha', evidence[0].asset).answer, '5')
  assert.equal(system.answer('alpha', input).duplicate, true)
  assert.equal(graderCalls, 1)
})

it('迟到的模型结果不能在用户暂停后发布活动', async (t) => {
  let release!: (value: LlmResult) => void
  const { system } = systemFixture(
    t,
    async () =>
      new Promise<LlmResult>((resolve) => {
        release = resolve
      }),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.start('alpha', { requestId: 'late' })
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5))
  system.pause('alpha', 'pause')
  release(toolReply('present_activity', activity()))
  await system.wait('alpha')
  assert.equal(system.repository.read('alpha').activities.length, 0)
  assert.equal(system.repository.read('alpha').turns.late.status, 'pending')
})

it('生成、核验和内部重试共用回合预算', async (t) => {
  let calls = 0
  const fixture = systemFixture(
    t,
    scriptedTransport(
      [
        toolReply('update_curriculum', { skills: [SKILL], reason: '定义目标' }),
        toolReply('present_activity', activity()),
      ],
      {
        called: () => {
          calls++
        },
      },
    ),
  )
  const system = new TutorSystem({
    ...fixture.options,
    env: { ...fixture.options.env, TUTOR_AGENT_MAX_REQUESTS: '3' },
  })
  t.after(() => system.close())
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.start('alpha', { requestId: 'budget' })
  await system.wait('alpha')
  assert.equal(calls, 3)
  assert.equal(system.repository.read('alpha').activities.length, 0)
  assert.match(system.service.view('alpha').tutorError!, /共用的请求预算/)
})

it('查看状态和重放事件不调用模型，未作答题目不下发答案', async (t) => {
  let calls = 0
  const { system } = systemFixture(
    t,
    scriptedTransport([toolReply('present_activity', activity())], {
      called: () => {
        calls++
      },
    }),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  system.start('alpha', { requestId: 'first' })
  await system.wait('alpha')
  const before = calls
  for (let i = 0; i < 20; i++) {
    system.service.view('alpha')
    system.service.list()
    system.events('alpha', -1)
  }
  assert.equal(calls, before)
  assert.equal('answer' in system.service.view('alpha').active!.question!, false)
  const question = system.events('alpha', -1).find((event) => event.type === 'question_presented')!.data
    .question as Record<string, unknown>
  assert.equal('answer' in question, false)
})

it('日程推荐由模型选择并缓存，查看和相同条件重试不计费', async (t) => {
  let calls = 0
  const { system } = systemFixture(
    t,
    scriptedTransport([], {
      called: () => {
        calls++
      },
    }),
  )
  system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  const first = await system.recommendToday(20)
  const before = calls
  const same = await system.recommendToday(20)
  system.readToday()
  assert.deepEqual(same.recommendation, first.recommendation)
  assert.equal(calls, before)
  assert.equal(system.usageLedger.read().length, 1)
})
