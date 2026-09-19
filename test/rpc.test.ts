import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CourseStore } from '../src/core/store.ts'
import { createRpcMethods, handleRpcRequest, type RpcRequest } from '../src/core/rpc.ts'

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
