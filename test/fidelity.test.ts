import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assembleReport,
  citationAudit,
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
})

describe('parseLessonIntro', () => {
  it('解析知识点/要点/资料数', () => {
    const view = parseLessonIntro(INTRO)
    assert.ok(view)
    assert.equal(view.node, 'goroutines')
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
    assert.ok(report.coverageRate > 0)
    assert.ok(report.structure.length === 3)
  })
})
