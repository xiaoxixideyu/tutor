import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CALIBRATION_BIAS_THRESHOLD, calibrationInsight, detectStyleSignal, ERROR_CAP,
  LearnerNotesStore, parseConfidence,
} from '../src/core/learner-notes.ts'

function makeStore(): { store: LearnerNotesStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-notes-'))
  return { store: new LearnerNotesStore(root, 'alpha'), root }
}

describe('LearnerNotesStore：错因档案', () => {
  it('记录错答、同题同答去重保留最新、每节点封顶', () => {
    const { store } = makeStore()
    store.recordErrors('a', [{ question: 'Q1', your: 'B', answer: 'C' }], '2026-09-18', 'quiz')
    store.recordErrors('a', [{ question: 'Q1', your: 'B', answer: 'C' }], '2026-09-19', 'review')
    let notes = store.read()
    assert.equal(notes.errors.a.length, 1)
    assert.equal(notes.errors.a[0].at, '2026-09-19')
    assert.equal(notes.errors.a[0].kind, 'review')
    for (let index = 0; index < ERROR_CAP + 3; index++) {
      store.recordErrors('a', [{ question: `Q${index}`, your: 'x', answer: 'y' }], '2026-09-20', 'quiz')
    }
    notes = store.read()
    assert.equal(notes.errors.a.length, ERROR_CAP)
    assert.equal(notes.errors.a.at(-1)!.question, `Q${ERROR_CAP + 2}`)
  })

  it('errorsFor 按节点取最近条目并封顶总数', () => {
    const { store } = makeStore()
    store.recordErrors('a', [{ question: 'A1', your: 'x', answer: 'y' }, { question: 'A2', your: 'x', answer: 'y' }, { question: 'A3', your: 'x', answer: 'y' }], '2026-09-18', 'quiz')
    store.recordErrors('b', [{ question: 'B1', your: 'x', answer: 'y' }, { question: 'B2', your: 'x', answer: 'y' }], '2026-09-18', 'review')
    const picked = store.errorsFor(['a', 'b'], 2, 4)
    assert.deepEqual(picked.map((item) => item.question), ['A2', 'A3', 'B1', 'B2'])
    assert.equal(picked[0].node, 'a')
  })

  it('损坏文件读取为空且可恢复写入', () => {
    const { store } = makeStore()
    fs.mkdirSync(path.dirname(store.file), { recursive: true })
    fs.writeFileSync(store.file, '{broken')
    assert.deepEqual(store.read(), { errors: {}, calibration: [], style: [] })
    store.recordStyle({ at: '2026-09-18', kind: 'confused', detail: '太快' })
    assert.equal(store.read().style.length, 1)
  })
})

describe('LearnerNotesStore：自评校准与课堂反馈', () => {
  it('校准记录封顶，latestCalibration 取最近一条', () => {
    const { store } = makeStore()
    store.recordCalibration({ at: '2026-09-17', node: 'a', predicted: 80, actual: 0.5 })
    store.recordCalibration({ at: '2026-09-18', node: 'b', predicted: 90, actual: 0.9 })
    assert.deepEqual(store.latestCalibration(), { at: '2026-09-18', node: 'b', predicted: 90, actual: 0.9 })
  })

  it('校准偏差达到阈值才提示，方向正确', () => {
    assert.equal(calibrationInsight(undefined), undefined)
    assert.equal(calibrationInsight({ at: 'x', node: 'a', predicted: 80, actual: 0.7 }), undefined)
    const over = calibrationInsight({ at: 'x', node: 'a', predicted: 90, actual: 0.5 })
    assert.equal(over?.bias, 40)
    const under = calibrationInsight({ at: 'x', node: 'a', predicted: 30, actual: 0.8 })
    assert.equal(under?.bias, -50)
    assert.equal(CALIBRATION_BIAS_THRESHOLD, 15)
  })

  it('把握解析：0-100 整数才有效，空行与非法值跳过', () => {
    assert.equal(parseConfidence('80'), 80)
    assert.equal(parseConfidence('0'), 0)
    assert.equal(parseConfidence('100'), 100)
    assert.equal(parseConfidence(''), undefined)
    assert.equal(parseConfidence(null), undefined)
    assert.equal(parseConfidence('101'), undefined)
    assert.equal(parseConfidence('abc'), undefined)
    assert.equal(parseConfidence('8.5'), undefined)
  })

  it('风格信号：跟不上优先于懂了，详情截断', () => {
    assert.deepEqual(detectStyleSignal('这个太快了，没跟上'), { kind: 'confused', detail: '这个太快了，没跟上' })
    assert.deepEqual(detectStyleSignal('明白了！'), { kind: 'resolved', detail: '明白了！' })
    assert.deepEqual(detectStyleSignal('懂了，不过前面太快的地方我没听懂'), { kind: 'confused', detail: '懂了，不过前面太快的地方我没听懂' })
    assert.equal(detectStyleSignal('继续讲下一个吧'), undefined)
    assert.equal(detectStyleSignal(`没听懂，${'很'.repeat(60)}`)?.detail.length, 40)
  })
})
