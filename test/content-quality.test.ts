import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { evaluateRational, sameRational } from '../src/core/rational.ts'
import { bankContent, blindQuestions, contentIssues, contentKey, lessonContent, mapContent, parseBlindSolutions, parseContentReview,
  planContent, practiceContent, replayApprovedReply, requiredAssertions, teachingContent, type ContentInput, type ContentReview } from '../src/core/content-quality.ts'
import { QualityStore, type QualityRecord } from '../src/core/quality-store.ts'
import { ContentGate, generateApproved, generateApprovedTeaching } from '../src/plugin/content-gate.ts'
import { OutputLimitError, type AgentChat } from '../src/plugin/agent-chat.ts'
import type { KnowledgeMap, LessonDraft, Profile, QuestionBank } from '../src/core/schema.ts'
import { parseJsonBlock } from '../src/plugin/generation.ts'

const profile: Profile = { goal: '只学习一次掷一枚公平六面骰子，排除多次试验', daily_minutes: 15 }
const map: KnowledgeMap = { verified: false, nodes: [{ id: 'die', title: '一次掷骰', summary: '秘密资料摘要' }], edges: [] }
const bank: QuestionBank = { die: [{ id: 'q1', type: 'choice', difficulty: 1, question: '掷出 1 的概率？', choices: ['1/6', '1/2', '1', '0'], answer: 'A', accept: ['不应进入盲解的答案'] }] }
const input = bankContent(bank, 'die', profile, map)
const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
const reviewFor = (content: ContentInput): ContentReview => ({ units: content.units.map(u => ({ id: u.id, scope: 'pass', correctness: 'pass', explanation: '核查了条件与边界', arithmetic: [],
  assertions: requiredAssertions(content, u).map(a => ({ id: a.id, verdict: 'pass', explanation: '逐字核对' })) })) })

function mockChat(reply: (prompt: string) => string, id: string): AgentChat {
  let last = ''
  return { sessionId: id, model: 'test', ask: async prompt => (last = reply(prompt)), flush: async () => {}, lastReply: () => last,
    totalUsage: () => ({ inputTokens: 10, outputTokens: 10 }), lastTurnUsage: () => ({ inputTokens: 10, outputTokens: 10 }) }
}
function setup(t: TestContext, reviewer: (content: ContentInput) => unknown = reviewFor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-quality-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new QualityStore(root, 'course')
  const requests: { role: string; prompt: string; persona: string }[] = []
  let seq = 0
  const gate = new ContentGate(store, async (role, persona) => mockChat(prompt => {
    requests.push({ role, prompt, persona })
    const data = JSON.parse(prompt)
    return json(role === 'solver' ? { solutions: data.questions.map((q: { id: string }) => ({ id: q.id, status: 'solved', answer: 'A', reasoning: '六个等可能结果中一个有利结果', arithmetic: [{ expression: '1/6', result: '1/6' }] })) }
      : role === 'facts' ? { claims: data.claims.map((claim: { id: string }) => ({ id: claim.id, verdict: 'pass', explanation: '核查断言', arithmetic: [] })) }
        : reviewer(data.content))
  }, `session-${++seq}`))
  const records = () => fs.readdirSync(path.join(store.directory, 'reviews')).map(file => JSON.parse(fs.readFileSync(path.join(store.directory, 'reviews', file), 'utf8')) as QualityRecord)
  return { root, gate, store, requests, records }
}

it('精确分数运算拒绝错误概率恒等式，解析器不执行代码或接受无限大输入', () => {
  assert.equal(evaluateRational('1/3 + 1/2 + 1/3'), '7/6')
  assert.equal(evaluateRational('-(0.25+1/4)*2'), '-1')
  assert.equal(sameRational('2/6', '1/3'), true)
  assert.equal(sameRational('1/3+1/2+1/3', '1'), false)
  for (const unsafe of ['process.exit()', '1/0', '2**10', '1;2', '.5', '('.repeat(300), '9'.repeat(25), '1 2']) {
    assert.throws(() => evaluateRational(unsafe))
  }
})

it('盲解使用字段白名单，实际请求无参考答案、课程摘要和学员档案；两个角色各自新会话', async t => {
  const { gate, requests, records } = setup(t)
  assert.equal((await gate.review(input)).approved, true)
  assert.deepEqual(JSON.parse(requests[0].prompt), { questions: blindQuestions(input) })
  assert.doesNotMatch(requests[0].prompt, /秘密|不应进入|goal|answer|accept|keywords/)
  assert.notEqual(records()[0].calls[0].sessionId, records()[0].calls[1].sessionId)
  assert.match(requests[0].persona, /看不到参考答案/)
  assert.match(requests[1].persona, /不可信|待核查数据/)
  assert.equal((await gate.review(input)).cached, true)
  assert.equal(requests.length, 2)
})

it('遗漏、重复、未知单元和只给一个结论不能视为审查通过', () => {
  for (const value of [{}, { units: [] }, { units: [{ id: 'q2', scope: 'pass', correctness: 'pass' }] },
    { units: [{ id: 'q1', scope: 'pass', explanation: '没检查答案', arithmetic: [] }] }]) assert.throws(() => parseContentReview(value, input))
  const two = { ...input, units: [...input.units, { ...input.units[0], id: 'q2' }] }
  assert.throws(() => parseContentReview({ units: [reviewFor(input).units[0], reviewFor(input).units[0]] }, two))
  assert.throws(() => parseBlindSolutions({ solutions: [] }, input))
})

it('独立答案不一致、模型不确定、模型误判通过的算式都会拦截', () => {
  const solutions = parseBlindSolutions({ solutions: [{ id: 'q1', status: 'solved', answer: 'B', reasoning: '解答', arithmetic: [] }] }, input)
  assert.match(contentIssues(input, solutions, reviewFor(input)).join(''), /不一致/)
  solutions[0].answer = 'A'; solutions[0].status = 'uncertain'
  assert.match(contentIssues(input, solutions, reviewFor(input)).join(''), /不确定/)
  solutions[0].status = 'solved'
  const review = reviewFor(input)
  review.units[0].arithmetic = [{ expression: '1/3+1/2+1/3', result: '1' }]
  assert.match(contentIssues(input, solutions, review).join(''), /7\/6/)
  review.units[0].arithmetic = []; review.units[0].scope = 'uncertain'
  assert.match(contentIssues(input, solutions, review).join(''), /uncertain/)
})

it('盲解返回完整选项或等价分数时按选项唯一映射，错误或歧义答案仍拒绝', () => {
  const solution = { id: 'q1', status: 'solved' as const, answer: '2/12', reasoning: '六个结果中一个', arithmetic: [] }
  assert.deepEqual(contentIssues(input, [solution], reviewFor(input)), [])
  solution.answer = '1/2'
  assert.ok(contentIssues(input, [solution], reviewFor(input)).length)
  const duplicate = structuredClone(input)
  duplicate.units[0].question!.choices![1] = '2/12'
  solution.answer = '1/6'
  assert.ok(contentIssues(duplicate, [solution], reviewFor(duplicate)).length)
  const words = structuredClone(input)
  words.units[0].question!.choices![0] = '掷出的点数是 1、2、3、5、6'
  solution.answer = '掷出的点数是 1、2、3、5、6'
  assert.deepEqual(contentIssues(words, [solution], reviewFor(words)), [])
  solution.answer = 'A 或 B'
  assert.ok(contentIssues(words, [solution], reviewFor(words)).length)
})

it('审查响应不完整和网络错误时关闭准入，保留失败证据和用量', async t => {
  const { gate, store, records } = setup(t, () => ({ units: [] }))
  await assert.rejects(gate.review(input), /未完成，未发布/)
  assert.equal(store.approved(input), false)
  assert.equal(records()[0].status, 'error')
  assert.equal(records()[0].calls.length, 2)
  assert.equal(records()[0].calls[1].usage.outputTokens, 10)
  const broken = new ContentGate(store, async () => { throw new Error('网络中断') })
  await assert.rejects(broken.review(input), /网络中断/)
  assert.equal(store.approved(input), false)
})

it('生成后审查中断保留待审草稿，续跑重新校验与审查而不重复生成', async t => {
  const { gate, store, requests } = setup(t)
  const broken = new ContentGate(store, async () => { throw new Error('测试断网') })
  let generations = 0
  const generator = { ask: async () => { generations++; return json(bank) } }
  const content = (value: QuestionBank) => bankContent(value, 'die', profile, map)
  await assert.rejects(generateApproved(generator, '生成该节点题库', parseJsonBlock, broken, content), /测试断网/)
  assert.equal(store.approved(input), false)
  assert.equal(store.candidate('生成该节点题库')?.status, 'pending')
  assert.deepEqual(await generateApproved(generator, '生成该节点题库', parseJsonBlock, gate, content), bank)
  assert.equal(generations, 1)
  assert.equal(requests.filter(request => request.role === 'solver').length, 1)
  assert.equal(store.approved(input), true)
  assert.equal(store.candidate('生成该节点题库'), undefined)
})

it('中断后复用逐字匹配且结构完整的检查，保留原失败并只计算新增请求', async t => {
  const { gate, store, records } = setup(t, () => { throw new Error('网关中断') })
  await assert.rejects(gate.review(input), /网关中断/)
  const original = records()[0]
  const requests: string[] = []
  const resumed = new ContentGate(store, async role => {
    requests.push(role)
    return mockChat(() => json(reviewFor(input)), 'new-reviewer')
  })
  assert.equal((await resumed.review(input)).approved, true)
  assert.deepEqual(requests, ['reviewer'])
  const approved = records().find(record => record.status === 'approved')!
  assert.equal(approved.resumedFrom, original.id)
  assert.equal(approved.calls[0].reusedFrom, original.id)
  assert.equal(approved.calls[0].usage.outputTokens, 0)
  assert.equal(approved.calls[1].usage.outputTokens, 10)
  assert.equal(records().find(record => record.id === original.id)?.status, 'error')
  assert.equal(store.approved(input), true)
  fs.rmSync(store.evidenceFile(original.id))
  assert.equal(store.approved(input), false, '复用的原始证据缺失时不能批准')
})

it('恢复不会复用缺少必需字段的响应，已拒内容也不能重抽审查变成通过', async t => {
  const { gate, store } = setup(t, () => ({ units: [] }))
  await assert.rejects(gate.review(input), /未完成/)
  let requests = 0
  const resumed = new ContentGate(store, async () => mockChat(() => {
    requests++
    const review = reviewFor(input)
    review.units[0].scope = 'fail'
    return json(review)
  }, 'valid-rejection'))
  assert.equal((await resumed.review(input)).approved, false)
  assert.equal(requests, 1)
  const untouched = new ContentGate(store, async () => { throw new Error('不应重新请求') })
  assert.equal((await untouched.review(input)).approved, false)
  const changed = structuredClone(input)
  changed.context.profile.goal += '；允许复习'
  await assert.rejects(untouched.review(changed), /不应重新请求/)
})

it('不能复用出题答案所在的盲解会话作为审查会话', async t => {
  const { store } = setup(t)
  const gate = new ContentGate(store, async role => mockChat(() => json(role === 'solver'
    ? { solutions: [{ id: 'q1', status: 'solved', answer: 'A', reasoning: '解答', arithmetic: [] }] } : reviewFor(input)), 'same-session'))
  await assert.rejects(gate.review(input), /独立新会话/)
  assert.equal(store.approved(input), false)
})

it('内容、学员范围、节点描述、策略或缓存完整性变化使批准失效；推进成绩指针不影响内容摘要', async t => {
  const { gate, store } = setup(t)
  await gate.review(input)
  const changed = structuredClone(input)
  changed.context.profile.goal += '，排除掷出 1'
  assert.equal(store.approved(changed), false)
  changed.context.profile.goal = input.context.profile.goal
  changed.context.nodes[0].summary = '变化'
  assert.equal(store.approved(changed), false)
  const plan = { path: ['die'], milestones: [{ id: 'm1', title: '计算一次掷骰概率', nodes: ['die'] }], current: 'die' }
  assert.equal(contentKey(planContent(plan, profile, map)), contentKey(planContent({ ...plan, current: undefined,
    milestones: [{ ...plan.milestones[0], exam_passed: true, exam_score: 1 }] }, profile, map)))
  const file = path.join(store.directory, 'approved', `${contentKey(input)}.json`)
  const cached = JSON.parse(fs.readFileSync(file, 'utf8'))
  cached.review.units = []
  fs.writeFileSync(file, JSON.stringify(cached))
  assert.equal(store.approved(input), false)
})

it('实践 README、测试和提示，教案所有题目和误区都纳入审查', () => {
  const tasks = [{ id: 'task', node: 'die', title: '练习', prompt: '一次试验', starter_files: [{ path: 'README.md', content: '可选：掷 30 次' }],
    tests: [{ name: 'count', command: 'test -f answer.txt' }], hints: ['提示'] }]
  const content = practiceContent(tasks, 'die', profile, map)
  assert.match(JSON.stringify(content), /掷 30 次/)
  const modified = structuredClone(tasks); modified[0].tests[0].command = 'false'
  assert.notEqual(contentKey(content), contentKey(practiceContent(modified, 'die', profile, map)))
  const draft: LessonDraft = { node: 'die', title: '课', hook: '开场', structure: ['要点'], example: '例子',
    practice: [{ question: '练习题', answer: '1' }], quiz: [{ question: '小测题', answer: '2' }], misconceptions: ['错误假设'] }
  const lesson = lessonContent(draft, profile, map)
  assert.deepEqual(blindQuestions(lesson).map(q => q.id), ['practice:0', 'quiz:0'])
  assert.match(JSON.stringify(lesson.units[0]), /错误假设/)
})

it('强断言定位到具体分句，缺漏反例核查时不能批准；干扰项与历史发言不混入断言', () => {
  const turn = teachingContent({ reply: 'copy复制较短长度，因此目标必须与源等长；这样一定合法。', learnerMessage: '学员说必须一样', previousReply: '旧话必须这样' }, 'die', profile, map)
  assert.deepEqual(requiredAssertions(turn, turn.units[0]).map(a => a.quote), ['因此目标必须与源等长', '这样一定合法'])
  assert.throws(() => parseContentReview({ units: [{ ...reviewFor(turn).units[0], assertions: [] }] }, turn), /覆盖不完整/)
  const copy = structuredClone(input)
  ;(copy.units[0].content as { choices: string[] }).choices[1] = '错误项：一定发生'
  assert.deepEqual(requiredAssertions(copy, copy.units[0]), [])
})

it('长内容分批审查仍需全量覆盖，后续批次失败不会留下有效准入', async t => {
  let reviews = 0
  const { gate, store, records } = setup(t, content => ++reviews === 2 ? { units: [] } : reviewFor(content))
  const large = mapContent({ ...map, nodes: Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, title: `知识点${i}` })) }, profile)
  await assert.rejects(gate.review(large), /未完成/)
  assert.ok(reviews >= 2)
  assert.equal(store.approved(large), false)
  assert.ok((records()[0].review?.units.length ?? 0) < large.units.length)
})

it('输出截断后拆小盲解批次并保留失败；完整复核后才批准，调用并发不超过二', async t => {
  const { store } = setup(t)
  let serial = 0
  let active = 0
  let maxActive = 0
  const gate = new ContentGate(store, async role => ({ ...mockChat(() => '', `split-${++serial}`), ask: async prompt => {
    active++; maxActive = Math.max(maxActive, active)
    try {
      await new Promise(resolve => setTimeout(resolve, 5))
      const data = JSON.parse(prompt)
      if (role === 'solver' && data.questions.length > 1) throw new OutputLimitError()
      return json(role === 'solver' ? { solutions: data.questions.map((q: { id: string }) => ({ id: q.id, status: 'solved', answer: 'A', reasoning: '独立解答', arithmetic: [] })) }
        : reviewFor(data.content))
    } finally { active-- }
  } }))
  const largeBank = bankContent({ die: Array.from({ length: 5 }, (_, i) => ({ ...bank.die[0], id: `q${i}` })) }, 'die', profile, map)
  assert.equal((await gate.review(largeBank)).approved, true)
  assert.equal(store.approved(largeBank), true)
  assert.equal(maxActive, 2)
  const record = JSON.parse(fs.readFileSync(path.join(store.directory, 'approved', `${contentKey(largeBank)}.json`), 'utf8')) as QualityRecord
  assert.equal(record.solutions?.length, 5)
  assert.ok(record.calls.some(call => call.error && call.splitAfterError))
  assert.ok(record.calls.every(call => typeof call.elapsedMs === 'number'))
})

it('课程地图明确每节点一课，骨架越界即可提前拒绝但不能提前批准', async t => {
  const { gate, requests, store } = setup(t, content => {
    const review = reviewFor(content)
    review.units[0].scope = 'fail'
    return review
  })
  const large = mapContent({ ...map, nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, title: '节点' })) }, profile)
  assert.equal((await gate.review(large)).approved, false)
  assert.equal(requests.length, 1)
  assert.match(JSON.parse(requests[0].prompt).dataContract, /一个 node 就是一节课/)
  assert.equal(store.approved(large), false)
})

it('第四次修复重新审查后可发布；未修改的拒绝稿不靠反复审查碰运气', async t => {
  const { gate, store, records } = setup(t, content => {
    const result = reviewFor(content)
    if (JSON.stringify(content).includes('错误')) { result.units[0].correctness = 'fail'; result.units[0].explanation = '修正错误概念' }
    return result
  })
  const versions = ['错误一', '错误二', '错误三', '正确']
  let index = 0
  const generated = await generateApproved<KnowledgeMap>({ ask: async () => json({ ...map, nodes: [{ id: 'die', title: versions[index++] }] }) },
    '生成地图', parseJsonBlock, gate, value => mapContent(value, profile))
  assert.equal(generated.nodes[0].title, '正确')
  assert.equal(records().length, 4)
  assert.equal(records().filter(r => r.status === 'rejected').length, 3)
  assert.equal(store.approved(mapContent(generated, profile)), true)
  let tries = 0
  await assert.rejects(generateApproved<KnowledgeMap>({ ask: async () => { tries++; return json({ ...map, nodes: [{ id: 'die', title: '固定错误' }] }) } },
    '生成地图', parseJsonBlock, gate, value => mapContent(value, profile)), /多次生成/)
  assert.equal(tries, 4)
  assert.equal(records().length, 5)
})

it('被拒讲授不发布；恢复只回放持久化且匹配的已批准回复', async t => {
  const { gate, store } = setup(t, content => {
    const result = reviewFor(content)
    if ((content.units[0].content as { reply: string }).reply.includes('两枚')) result.units[0].scope = 'fail'
    return result
  })
  const saved = { reply: '一次掷一枚骰子', learnerMessage: '开始', previousReply: '' }
  await gate.require(teachingContent(saved, 'die', profile, map))
  const chat = mockChat(() => '改为两枚骰子', 'teacher')
  await assert.rejects(generateApprovedTeaching(chat, '继续', gate, { node: 'die', map, profile, learnerMessage: '继续', previousReply: saved.reply }), /未按审查意见修复/)
  assert.equal(replayApprovedReply(chat.lastReply(), saved), null)
  assert.equal(replayApprovedReply('旧的未审查回复'), null)
  assert.equal(replayApprovedReply(saved.reply, saved), saved.reply)
  assert.equal(store.approved(teachingContent(saved, 'die', profile, map)), true)
})
