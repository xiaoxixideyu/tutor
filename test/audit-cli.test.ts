import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { CourseStore } from '../src/core/store.ts'
import { QualityStore } from '../src/core/quality-store.ts'
import { teachingContent } from '../src/core/content-quality.ts'
import type { KnowledgeMap } from '../src/core/schema.ts'
import { approveFixture } from './fixtures/quality.ts'

it('正式 audit 只统计已发布事件、保留拒绝稿成本，并从课堂首消息选择正确课程', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-audit-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const dshHome = path.join(root, 'dsh-home')
  fs.mkdirSync(workspace)
  const store = new CourseStore(path.join(root, 'courses'))
  const profile = { goal: '学习 goroutine' }
  store.create('alpha', profile); store.create('beta', profile)
  store.write('alpha', 'knowledge-map', { nodes: [{ id: 'foreign', title: 'Go 关键字' }] })
  store.write('beta', 'knowledge-map', { nodes: [{ id: 'goroutines', title: 'Goroutine 入门' }] })
  const reply = 'Go 关键字用于启动 goroutine。'
  const content = teachingContent({ reply, learnerMessage: '开始', previousReply: '' }, 'goroutines', profile, store.read('beta', 'knowledge-map') as KnowledgeMap)
  approveFixture(store.root, 'beta', content)
  const quality = new QualityStore(store.root, 'beta')
  const sessionId = 'session-audit-fixture'
  quality.publish(content, sessionId, 7)
  quality.publish(content, sessionId, 7)
  assert.equal(quality.published(sessionId).length, 1)
  const dir = path.join(dshHome, 'sessions', `-${workspace.replaceAll('/', '-')}--`, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const events = [
    { type: 'session', id: sessionId },
    { seq: 0, type: 'user/message', data: { message: { content: [{ type: 'text', text: '【课程】beta\n【本课知识点】goroutines（Goroutine 入门）\n【本课计划】\n1. Go 关键字\n核心例子：启动 goroutine' }] } } },
    { seq: 3, type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 20 }, message: { content: [{ type: 'text', text: '必须把这份拒绝稿当作已讲内容 [资料:99]' }] } } },
    { seq: 7, type: 'assistant/message', data: { usage: { inputTokens: 30, outputTokens: 40 }, message: { content: [{ type: 'text', text: reply }] } } },
  ]
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n')))
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/audit.mjs', import.meta.url)), 'audit', 'audit-fixture', '--json'],
    { cwd: workspace, env: { ...process.env, DSH_HOME: dshHome, TUTOR_COURSES_ROOT: store.root, TUTOR_AUDITS_ROOT: path.join(root, 'audits') }, encoding: 'utf8' })
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.publication.publishedTurns, 1)
  assert.equal(report.publication.excludedTurns, 1)
  assert.equal(report.cost.inputTokens, 40)
  assert.equal(report.cost.outputTokens, 60)
  assert.deepEqual(report.drift, [])
  assert.deepEqual(report.citations.invalidCitations, [])
  fs.rmSync(path.join(quality.directory, 'published'), { recursive: true })
  const missing = run()
  assert.equal(missing.status, 0, missing.stderr)
  assert.equal(JSON.parse(missing.stdout).coverageRate, null)
})
