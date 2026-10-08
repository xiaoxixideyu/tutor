import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CourseStore } from '../src/core/store.ts'
import { createRpcMethods, handleRpcRequest, type RpcRequest } from '../src/core/rpc.ts'
import type { KnowledgeMap, Mastery, Profile, QuestionBank, ReviewResult } from '../src/core/schema.ts'
import { bankContent } from '../src/core/content-quality.ts'
import { approveFixture } from './fixtures/quality.ts'

function attemptId(store: CourseStore): string {
  const result = createRpcMethods(store, today).reviewQuestions({ id: 'alpha' }) as { items: { attemptId: string }[] }
  return result.items[0].attemptId
}

function makeStore(): CourseStore {
  return new CourseStore(fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-rpc-')))
}

const today = () => '2026-09-19'

function seedStore(store: CourseStore): void {
  store.create('alpha', { goal: '目标 A', daily_minutes: 60 })
  store.write('alpha', 'knowledge-map', {
    verified: false,
    nodes: [{ id: 'a1', title: 'A1' }],
    edges: [],
    resources: [],
  })
  store.write('alpha', 'plan', { path: ['a1'], milestones: [], current: 'a1' })
  store.write('alpha', 'mastery', { a1: { status: 'mastered', score: 1, review_due: '2026-09-17', review_stage: 2 } })
}

describe('createRpcMethods', () => {
  it('ping 与 listCourses（含 dueCount）', () => {
    const store = makeStore()
    seedStore(store)
    const methods = createRpcMethods(store, today)
    assert.deepEqual(methods.ping(undefined), { ok: true })
    const items = methods.listCourses(undefined) as { id: string; dueCount?: number }[]
    assert.equal(items[0].id, 'alpha')
    assert.equal(items[0].dueCount, 1)
  })

  it('courseStatus 返回进度看板数据', () => {
    const store = makeStore()
    seedStore(store)
    const progress = createRpcMethods(store, today).courseStatus({ id: 'alpha' }) as { id: string; totalNodes: number }
    assert.equal(progress.id, 'alpha')
    assert.equal(progress.totalNodes, 1)
  })

  it('dueReviews：无 id 跨课程汇总，带 id 单课程', () => {
    const store = makeStore()
    seedStore(store)
    const methods = createRpcMethods(store, today)
    const all = methods.dueReviews(undefined) as { id: string; earliestDue?: string }[]
    assert.equal(all.length, 1)
    assert.equal(all[0].earliestDue, '2026-09-17')
    const one = methods.dueReviews({ id: 'alpha' }) as { node: string }[]
    assert.equal(one[0].node, 'a1')
  })

  it('readDoc 白名单内可读，白名单外 -32602', () => {
    const store = makeStore()
    seedStore(store)
    const methods = createRpcMethods(store, today)
    const profile = methods.readDoc({ id: 'alpha', kind: 'profile' }) as { goal: string }
    assert.equal(profile.goal, '目标 A')
    assert.throws(() => methods.readDoc({ id: 'alpha', kind: 'sessions' }), /rpcCode|-32602|未知的文档类型/)
  })

  it('applyReview 写入 mastery（SM-2 回退路径）', () => {
    const store = makeStore()
    seedStore(store)
    const entry = createRpcMethods(store, today).applyReview({ id: 'alpha', node: 'a1', score: 0.33 }) as {
      status: string
      review_stage: number
      review_due: string
    }
    assert.equal(entry.status, 'weak')
    assert.equal(entry.review_stage, 1)
    assert.equal(entry.review_due, '2026-09-20')
    const mastery = store.read('alpha', 'mastery') as { a1: { review_stage: number } }
    assert.equal(mastery.a1.review_stage, 1)
  })

  it('参数与课程错误带 rpcCode=-32602', () => {
    const store = makeStore()
    seedStore(store)
    const methods = createRpcMethods(store, today)
    assert.throws(() => methods.courseStatus({ id: 'nope' }), (error: unknown) => {
      assert.match((error as Error).message, /不存在/)
      assert.equal((error as { rpcCode?: number }).rpcCode, -32602)
      return true
    })
    assert.throws(() => methods.courseStatus({ id: 'BAD_ID' }), /非法/)
    assert.throws(() => methods.applyReview({ id: 'alpha', node: 'ghost', score: 0.5 }), /没有知识点/)
  })
})

describe('复习 RPC：reviewQuestions / submitReview', () => {
  // alpha 的 a1 已到期（due 2026-09-17 ≤ today 2026-09-19），stage 2；再补一个含 2 题的题库
  function seedReview(store: CourseStore): void {
    seedStore(store)
    store.write('alpha', 'question-bank', {
      a1: [
        { id: 'a1-q1', difficulty: 2, type: 'choice', question: '1+1=?', choices: ['A. 2', 'B. 3'], answer: 'A' },
        { id: 'a1-q2', difficulty: 3, type: 'short', question: '2+2=?', answer: '4', accept: ['four'] },
      ],
    })
    approveFixture(store.root, 'alpha', bankContent(store.read('alpha', 'question-bank') as QuestionBank, 'a1',
      store.read('alpha', 'profile') as Profile, store.read('alpha', 'knowledge-map') as KnowledgeMap))
  }

  it('旧题库和修改课程范围后的题库不能下发或判分，掌握度保持不变', () => {
    const store = makeStore()
    seedReview(store)
    const id = attemptId(store)
    const before = store.read('alpha', 'mastery')
    store.write('alpha', 'profile', { goal: '只学习加法，不学其他运算' })
    const methods = createRpcMethods(store, today)
    assert.throws(() => methods.reviewQuestions({ id: 'alpha' }), /audit-content/)
    assert.throws(() => methods.submitReview({ id: 'alpha', node: 'a1', attemptId: id, answers: ['A', '4'] }), /audit-content/)
    assert.deepEqual(store.read('alpha', 'mastery'), before)
    fs.rmSync(path.join(store.root, 'alpha', 'quality'), { recursive: true })
    assert.throws(() => methods.reviewQuestions({ id: 'alpha' }), /尚未通过审查/)
  })

  it('reviewQuestions 下发到期题且抹掉答案', () => {
    const store = makeStore()
    seedReview(store)
    const result = createRpcMethods(store, today).reviewQuestions({ id: 'alpha' }) as {
      today: string
      items: { node: string; questions: { id: string; answer?: string }[] }[]
    }
    assert.equal(result.today, '2026-09-19')
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].node, 'a1')
    assert.equal(result.items[0].questions.length, 2)
    // 判分留服务端：下发的题目不得含 answer/accept
    assert.equal('answer' in result.items[0].questions[0], false)
    assert.equal('accept' in result.items[0].questions[0], false)
  })

  it('submitReview 全对：升阶回写 mastery', () => {
    const store = makeStore()
    seedReview(store)
    const out = createRpcMethods(store, today).submitReview({ id: 'alpha', node: 'a1', attemptId: attemptId(store), answers: ['A', '4'] }) as {
      score: number
      correct: number
      total: number
      entry: { status: string; review_stage: number; review_due: string }
    }
    assert.equal(out.correct, 2)
    assert.equal(out.total, 2)
    assert.equal(out.score, 1)
    assert.equal(out.entry.status, 'mastered')
    assert.equal(out.entry.review_stage, 3) // 2 → 3
    assert.equal(out.entry.review_due, '2026-09-26') // today + 7
    const mastery = store.read('alpha', 'mastery') as { a1: { review_stage: number } }
    assert.equal(mastery.a1.review_stage, 3)
  })

  it('submitReview 全错：回退一阶且留在复习队列', () => {
    const store = makeStore()
    seedReview(store)
    const out = createRpcMethods(store, today).submitReview({ id: 'alpha', node: 'a1', attemptId: attemptId(store), answers: ['B', '错'] }) as {
      score: number
      entry: { status: string; review_stage: number; review_due: string }
    }
    assert.equal(out.score, 0)
    assert.equal(out.entry.status, 'weak')
    assert.equal(out.entry.review_stage, 1) // 2 → 1
    assert.equal(out.entry.review_due, '2026-09-20') // today + 1
  })

  it('submitReview 题库缺失 / 参数非法带 rpcCode', () => {
    const store = makeStore()
    seedStore(store) // 无 question-bank
    const methods = createRpcMethods(store, today)
    assert.throws(() => methods.submitReview({ id: 'alpha', node: 'a1', attemptId: 'missing-bank', answers: ['A'] }), /没有可复习的题目/)
    assert.throws(() => methods.submitReview({ id: 'alpha', node: 'a1', answers: 'A' }), /字符串数组/)
    assert.throws(() => methods.submitReview({ id: 'alpha', node: 'ghost', answers: [] }), /没有知识点/)
  })

  it('同一作答重复提交及服务重启后的重试返回同一回执，不重复升阶', () => {
    const store = makeStore()
    seedReview(store)
    const params = { id: 'alpha', node: 'a1', attemptId: attemptId(store), answers: ['A', '4'] }
    const first = createRpcMethods(store, today).submitReview(params) as ReviewResult
    const saved = store.read('alpha', 'mastery')
    const restarted = new CourseStore(store.root)
    const duplicate = createRpcMethods(restarted, today).submitReview(params)
    assert.deepEqual(duplicate, first)
    assert.deepEqual(restarted.read('alpha', 'mastery'), saved)
    assert.throws(() => createRpcMethods(restarted, today).submitReview({ ...params, answers: ['B', '4'] }), /不能更改/)
  })

  it('题库或掌握状态变化后拒绝旧作答，漏答与未知 attemptId 不写状态', () => {
    const store = makeStore()
    seedReview(store)
    const params = { id: 'alpha', node: 'a1', attemptId: attemptId(store), answers: ['A', '4'] }
    const methods = createRpcMethods(store, today)
    const before = store.read('alpha', 'mastery') as Mastery
    assert.throws(() => methods.submitReview({ ...params, answers: ['A'] }), /全部复习题/)
    assert.throws(() => methods.submitReview({ ...params, answers: ['A', ''] }), /全部复习题/)
    assert.throws(() => methods.submitReview({ ...params, attemptId: 'old' }), /已变化/)
    assert.deepEqual(store.read('alpha', 'mastery'), before)
    store.write('alpha', 'question-bank', { a1: [{ id: 'changed', difficulty: 2, type: 'short', question: '新题', answer: '4' }] })
    assert.throws(() => methods.submitReview(params), /已变化/)
    store.write('alpha', 'mastery', { a1: { ...before.a1, review_due: '2026-10-01' } })
    assert.throws(() => methods.submitReview(params), /已变化/)
  })

  it('旧 applyReview 入口也不能重复推进，拒绝 NaN 与伪造日期', () => {
    const store = makeStore()
    seedReview(store)
    const methods = createRpcMethods(store, today)
    assert.throws(() => methods.applyReview({ id: 'alpha', node: 'a1', score: NaN }), /0-1/)
    methods.applyReview({ id: 'alpha', node: 'a1', score: 1 })
    assert.throws(() => methods.applyReview({ id: 'alpha', node: 'a1', score: 1, today: '2099-01-01' }), /尚未到/)
  })
})

describe('handleRpcRequest', () => {
  it('未知方法 -32601，非字符串 method -32600，id 原样回显', () => {
    const store = makeStore()
    const notFound = handleRpcRequest(store, { id: 7, method: 'nope' }, today)
    assert.equal(notFound.id, 7)
    assert.equal(notFound.error?.code, -32601)
    const invalid = handleRpcRequest(store, { id: 8, method: 123 as unknown as string }, today)
    assert.equal(invalid.error?.code, -32600)
    const echoed = handleRpcRequest(store, { id: 'req-1', method: 'ping' }, today)
    assert.equal(echoed.id, 'req-1')
    assert.deepEqual(echoed.result, { ok: true })
    assert.equal(handleRpcRequest(store, null as unknown as RpcRequest, today).error?.code, -32600)
    assert.equal(handleRpcRequest(store, { method: 'toString' }, today).error?.code, -32601)
  })

  it('store 异常映射为 -32603', () => {
    const store = makeStore()
    // courseStatus 已校验课程存在；readDoc 直接触发 store.read 的"缺少文档"异常
    store.create('beta', { goal: 'x' })
    const response = handleRpcRequest(store, { id: 3, method: 'readDoc', params: { id: 'beta', kind: 'plan' } }, today)
    assert.equal(response.error?.code, -32603)
    assert.match(response.error!.message, /缺少/)
  })

  it('完整请求往返：RpcRequest -> RpcResponse（result）', () => {
    const store = makeStore()
    seedStore(store)
    const request: RpcRequest = { id: 42, method: 'dueReviews', params: { id: 'alpha' } }
    const response = handleRpcRequest(store, request, today)
    assert.equal(response.jsonrpc, '2.0')
    assert.equal(response.id, 42)
    assert.ok(Array.isArray(response.result))
  })
})
