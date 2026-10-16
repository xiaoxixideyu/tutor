import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendMasteryEvent, dailyActivity, learningPace, masteryEventsFile,
  nodeTrails, readMasteryEvents, validMasteryEvent, type MasteryEvent,
} from '../src/core/events.ts'

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-events-'))
}

const event = (key: string, at: string, node: string, kind: MasteryEvent['kind'], score?: number, passed?: boolean): MasteryEvent =>
  ({ key, at, node, kind, ...(score !== undefined ? { score } : {}), ...(passed !== undefined ? { passed } : {}) })

describe('事件流：追加、去重与容错', () => {
  it('按 key 去重（保留首次），单行损坏不拖垮读取', () => {
    const root = makeRoot()
    appendMasteryEvent(root, 'alpha', event('quiz:s1', '2026-09-18', 'a', 'quiz', 1, true))
    appendMasteryEvent(root, 'alpha', event('quiz:s1', '2026-09-18', 'a', 'quiz', 1, true))
    appendMasteryEvent(root, 'alpha', event('review:s2', '2026-09-19', 'a', 'review', 0, false))
    fs.appendFileSync(masteryEventsFile(root, 'alpha'), '{"broken\n')
    const events = readMasteryEvents(root, 'alpha')
    assert.equal(events.length, 2)
    assert.deepEqual(events.map((item) => item.key), ['quiz:s1', 'review:s2'])
  })

  it('无文件返回空；非法事件被拒', () => {
    const root = makeRoot()
    assert.deepEqual(readMasteryEvents(root, 'ghost'), [])
    assert.equal(validMasteryEvent(event('k', '2026-09-18', 'a', 'quiz')), true)
    assert.equal(validMasteryEvent({ key: 'k', at: 'bad', node: 'a', kind: 'quiz' }), false)
    assert.equal(validMasteryEvent({ key: 'k', at: '2026-09-18', node: 'a', kind: 'nope' }), false)
    assert.equal(validMasteryEvent({ key: 'k', at: '2026-09-18', node: 'a', kind: 'quiz', score: 2 }), false)
  })
})

describe('事件流：聚合视图', () => {
  const events: MasteryEvent[] = [
    event('e1', '2026-09-16', 'a', 'quiz', 1, true),
    event('e2', '2026-09-16', 'b', 'review', 0, false),
    event('e3', '2026-09-18', 'a', 'review', 1, true),
    event('e4', '2026-09-19', 'a', 'interleave', 0, false),
  ]

  it('dailyActivity 补齐零活动日并统计种类', () => {
    const activity = dailyActivity(events, 5, '2026-09-19')
    assert.deepEqual(activity.map((day) => day.date), ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'])
    assert.equal(activity[1].count, 2)
    assert.equal(activity[1].kinds.quiz, 1)
    assert.equal(activity[4].kinds.interleave, 1)
    assert.equal(activity[0].count, 0)
  })

  it('learningPace 统计活跃天数与平均间隔', () => {
    const pace = learningPace(events, 14, '2026-09-19')
    assert.equal(pace.sessions, 3)
    assert.equal(pace.averageGapDays, 1.5)
    assert.equal(learningPace([], 14, '2026-09-19').sessions, 0)
  })

  it('nodeTrails 只收有成绩的事件，按节点分组并截断', () => {
    const trails = nodeTrails(events, 2)
    assert.deepEqual(trails.map((trail) => trail.node), ['a', 'b'])
    assert.deepEqual(trails[0].points.map((point) => point.key), ['e3', 'e4'])
    assert.deepEqual(trails[1].points.map((point) => point.key), ['e2'])
  })
})
