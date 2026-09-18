import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CourseStore } from '../src/core/store.ts'
import { courseProgress, listCourseSummaries } from '../src/core/summary.ts'

function makeStore(): CourseStore {
  return new CourseStore(fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-summary-')))
}

describe('courseProgress', () => {
  it('聚合掌握状态、计数与里程碑完成度', () => {
    const store = makeStore()
    store.create('golang', { goal: '掌握 Go', daily_minutes: 60 })
    store.write('golang', 'knowledge-map', {
      verified: false,
      nodes: [
        { id: 'basics', title: '基础' },
        { id: 'goroutines', title: 'Goroutine' },
      ],
      edges: [['goroutines', 'basics']],
      resources: [],
    })
    store.write('golang', 'plan', {
      path: ['basics', 'goroutines'],
      milestones: [{ id: 'm1', title: '入门', nodes: ['basics', 'goroutines'] }],
      current: 'goroutines',
    })
    store.write('golang', 'mastery', {
      basics: { status: 'mastered', score: 1, review_due: '2026-09-20' },
      goroutines: { status: 'weak', score: 0.3 },
    })

    const progress = courseProgress(store, 'golang')
    assert.equal(progress.goal, '掌握 Go')
    assert.deepEqual(progress.path, ['basics', 'goroutines'])
    assert.equal(progress.current, 'goroutines')
    assert.equal(progress.totalNodes, 2)
    assert.deepEqual(progress.counts, { mastered: 1, learning: 0, weak: 1, unknown: 0 })
    assert.equal(progress.nodes[0].status, 'mastered')
    assert.equal(progress.nodes[0].title, '基础')
    assert.equal(progress.nodes[0].review_due, '2026-09-20')
    assert.equal(progress.milestones[0].masteredCount, 1)
  })

  it('容忍缺 plan/mastery（新课程）', () => {
    const store = makeStore()
    store.create('empty', { goal: 'x' })
    const progress = courseProgress(store, 'empty')
    assert.deepEqual(progress.counts, { mastered: 0, learning: 0, weak: 0, unknown: 0 })
    assert.deepEqual(progress.milestones, [])
    assert.equal(progress.current, undefined)
  })

  it('mastery 中地图外的知识点也计入展示', () => {
    const store = makeStore()
    store.create('g', { goal: 'x' })
    store.write('g', 'knowledge-map', {
      verified: false,
      nodes: [{ id: 'a', title: 'A' }],
      edges: [],
      resources: [],
    })
    store.write('g', 'mastery', { a: { status: 'learning' }, ghost: { status: 'weak' } })
    const progress = courseProgress(store, 'g')
    assert.equal(progress.totalNodes, 2)
    assert.equal(progress.nodes[1].id, 'ghost')
  })

  it('不存在的课程报错', () => {
    const store = makeStore()
    assert.throws(() => courseProgress(store, 'nope'), /不存在/)
  })
})

describe('listCourseSummaries', () => {
  it('列出课程与进度', () => {
    const store = makeStore()
    store.create('a', { goal: '目标 A' })
    store.create('b', { goal: '目标 B' })
    store.write('a', 'knowledge-map', {
      verified: false,
      nodes: [
        { id: 'a1', title: 'A1' },
        { id: 'a2', title: 'A2' },
      ],
      edges: [],
      resources: [],
    })
    store.write('a', 'mastery', { a1: { status: 'mastered' }, a2: { status: 'unknown' } })
    const items = listCourseSummaries(store)
    assert.deepEqual(items.map((i) => i.id), ['a', 'b'])
    assert.equal(items[0].mastered, 1)
    assert.equal(items[0].total, 2)
    assert.equal(items[1].total, 0)
  })
})
