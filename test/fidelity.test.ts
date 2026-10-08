import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assembleReport,
  citationAudit,
  coverageFrontier,
  parseLessonIntro,
  parseSessionLog,
  planCoverage,
  scopeDrift,
  sumUsage,
} from '../src/core/fidelity.ts'

const INTRO = [
  '【课程】golang',
  '【学员档案】目的：x',
  '【本课知识点】goroutines（Goroutine 入门）',
  '',
  '【本课资料】（讲授中引用事实时标注 [资料:编号]）',
  '1. 官方入门 https://go.dev/x',
  '2. 并发指南 https://go.dev/y',
  '',
  '【本课计划】',
  '开场：从线程类比切入',
  '1. 什么是 goroutine',
  '2. go 关键字的用法',
  '3. 与线程的差异',
  '核心例子：go fmt.Println("hi")',
].join('\n')

describe('parseSessionLog', () => {
  const events = [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: INTRO }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '讲 goroutine [资料:1]' }] }, usage: { inputTokens: 100, outputTokens: 10 } } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '懂了' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '继续讲 go 关键字' }] }, usage: { inputTokens: 200, outputTokens: 20 } } },
  ]
  it('提取首消息/发言/用量', () => {
    const log = parseSessionLog(events)
    assert.equal(log.intro, INTRO)
    assert.equal(log.assistantTexts.length, 2)
    assert.equal(log.userTexts.length, 2)
    assert.deepEqual(sumUsage(log.usage), { inputTokens: 300, outputTokens: 30 })
  })
  it('成本包括缓存和失败尝试，失败尝试不计入已讲授内容', () => {
    const log = parseSessionLog([
      { type: 'assistant/attempt', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 },
        message: { content: [{ type: 'text', text: '未完成的尝试' }] } } },
      { type: 'assistant/message', data: { usage: { inputTokens: 30, outputTokens: 10, cacheWriteTokens: 40 },
        message: { content: [{ type: 'text', text: '已讲内容' }] } } },
    ])
    assert.deepEqual(sumUsage(log.usage), { inputTokens: 100, outputTokens: 15 })
    assert.deepEqual(log.assistantTexts, ['已讲内容'])
  })
  it('发布回执按事件序号和完整文本匹配，拒绝稿、未发布稿及同文其他事件不进入课堂统计', () => {
    const log = parseSessionLog([
      { seq: 1, type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 20 }, message: { content: [{ type: 'text', text: '同一段话' }] } } },
      { seq: 2, type: 'assistant/message', data: { usage: { inputTokens: 20, outputTokens: 30 }, message: { content: [{ type: 'text', text: '被拒绝的内容' }] } } },
      { seq: 3, type: 'assistant/message', data: { usage: { inputTokens: 30, outputTokens: 40 }, message: { content: [{ type: 'text', text: '同一段话' }] } } },
    ], [{ seq: 3, reply: '同一段话' }, { seq: 2, reply: '无法匹配的文本' }])
    assert.deepEqual(log.assistantTexts, ['同一段话'])
    assert.deepEqual(log.publication, { source: 'published', rawTurns: 3, publishedTurns: 1, excludedTurns: 2 })
    assert.deepEqual(sumUsage(log.usage), { inputTokens: 60, outputTokens: 90 })
  })
})

describe('parseLessonIntro', () => {
  it('解析知识点/要点/资料数', () => {
    const view = parseLessonIntro(INTRO)
    assert.ok(view)
    assert.equal(view.node, 'goroutines')
    assert.equal(view.courseId, 'golang')
    assert.deepEqual(view.structure, ['什么是 goroutine', 'go 关键字的用法', '与线程的差异'])
    assert.equal(view.resourceCount, 2)
  })
  it('无资料块时 resourceCount=0', () => {
    const view = parseLessonIntro('【本课知识点】x（Y）\n【本课计划】\n1. a')
    assert.equal(view?.resourceCount, 0)
  })
})

describe('planCoverage', () => {
  it('讲到的要点覆盖高，未讲的接近 0', () => {
    const corpus = '今天讲什么是 goroutine。go 关键字用于启动并发。goroutine 是轻量线程，与线程的差异在于调度方式。'
    const coverage = planCoverage(['什么是 goroutine', 'go 关键字的用法', '与线程的差异', '错误处理惯用法'], corpus)
    assert.ok(coverage[0].coverage > 0.6)
    assert.ok(coverage[2].coverage > 0.6)
    assert.ok(coverage[3].coverage < 0.3, String(coverage[3]))
  })
})

describe('citationAudit', () => {
  it('统计标记/无效编号/无引用断言句', () => {
    const messages = [
      'Go 是静态编译的 [资料:1]。事实上 goroutine 非常轻量。见 [资料:9] 与 [资料:1]。',
      '一般来说接口是隐式实现 [资料:2]。',
    ]
    const result = citationAudit(messages, 2)
    assert.equal(result.totalCitations, 4)
    assert.deepEqual(result.invalidCitations, [9])
    assert.equal(result.assertionSentences, 2)
    assert.equal(result.uncitedAssertions, 1)
  })
})

describe('scopeDrift', () => {
  it('密集谈论另一知识点时报警', () => {
    const corpus = 'goroutine 的调度由运行时完成，goroutine 非常轻量，goroutine 启动廉价，goroutine 与线程不同。'
    const drift = scopeDrift(corpus, 'channels', [
      { id: 'goroutines', title: 'goroutine 与线程' },
      { id: 'http', title: 'HTTP 服务' },
    ])
    assert.equal(drift[0].id, 'goroutines')
    assert.ok(drift[0].overlap >= 0.5)
    assert.equal(drift.some((d) => d.id === 'http'), false)
  })
})

describe('coverageFrontier', () => {
  it('尾部未覆盖点算"未讲到"，不进前沿', () => {
    const { reachedCount, coveredWithinReached } = coverageFrontier([
      { point: 'a', coverage: 0.9 },
      { point: 'b', coverage: 0.6 },
      { point: 'c', coverage: 0.2 },
      { point: 'd', coverage: 0.1 },
    ])
    assert.equal(reachedCount, 2)
    assert.equal(coveredWithinReached, 2)
  })
  it('前沿之内的未覆盖点算真漏讲', () => {
    const { reachedCount, coveredWithinReached } = coverageFrontier([
      { point: 'a', coverage: 0.9 },
      { point: 'b', coverage: 0.1 },
      { point: 'c', coverage: 0.8 },
    ])
    assert.equal(reachedCount, 3) // 讲到了第 3 点，故 b 在前沿内
    assert.equal(coveredWithinReached, 2) // a、c 覆盖，b 漏讲
  })
  it('全未覆盖：前沿为 0', () => {
    assert.deepEqual(coverageFrontier([{ point: 'a', coverage: 0.1 }]), { reachedCount: 0, coveredWithinReached: 0 })
  })
})

describe('assembleReport', () => {
  it('报告组装：覆盖率/引用/成本齐备', () => {
    const introView = parseLessonIntro(INTRO)!
    const report = assembleReport({
      sessionId: 'session-test',
      introView,
      assistantTexts: ['什么是 goroutine [资料:1]。事实上它很轻量。', 'go 关键字的用法是加在调用前。'],
      usage: [{ inputTokens: 500, outputTokens: 50 }],
      otherNodes: [{ id: 'channels', title: 'Channel 通信' }],
      generatedAt: '2026-09-20 10:00:00',
    })
    assert.equal(report.node, 'goroutines')
    assert.equal(report.cost.turns, 2)
    assert.equal(report.citations.totalCitations, 1)
    assert.equal(report.citations.uncitedAssertions, 1)
    assert.ok(report.coverageRate !== null && report.coverageRate > 0)
    assert.ok(report.structure.length === 3)
  })

  it('暂停感知：讲到前 2 点即暂停 → 忠实度 100%、partial、未讲到点不失分', () => {
    const introView = parseLessonIntro(INTRO)! // 3 个计划要点
    const report = assembleReport({
      sessionId: 'session-partial',
      introView,
      // 只讲了前两点，第三点（与线程的差异）未讲到
      assistantTexts: ['什么是 goroutine 我们先说清楚。', 'go 关键字的用法是加在调用前。'],
      usage: [{ inputTokens: 100, outputTokens: 10 }],
      otherNodes: [],
      generatedAt: '2026-09-20 10:00:00',
    })
    assert.equal(report.plannedPoints, 3)
    assert.equal(report.reachedPoints, 2)
    assert.equal(report.partial, true)
    assert.equal(report.coverageRate, 1) // 讲到的都覆盖了，暂停不失分
  })

  it('前沿内漏讲 → 忠实度 < 1', () => {
    const introView = parseLessonIntro(INTRO)!
    const report = assembleReport({
      sessionId: 'session-gap',
      introView,
      // 讲了第 1、3 点，跳过第 2 点（go 关键字）
      assistantTexts: ['什么是 goroutine 先讲。', '再说与线程的差异在于调度。'],
      usage: [{ inputTokens: 100, outputTokens: 10 }],
      otherNodes: [],
      generatedAt: '2026-09-20 10:00:00',
    })
    assert.equal(report.reachedPoints, 3) // 讲到了第 3 点
    assert.equal(report.partial, false)
    assert.ok(report.coverageRate !== null && report.coverageRate < 1) // 第 2 点漏讲，忠实度失分
  })
})
