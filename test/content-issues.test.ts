import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QualityStore } from '../src/core/quality-store.ts'
import { QUALITY_POLICY, contentKey, bankContent } from '../src/core/content-quality.ts'
import type { KnowledgeMap, Profile, QuestionBank } from '../src/core/schema.ts'

describe('QualityStore.openIssues', () => {
  it('列出当前未过审内容及其问题；无 rejected 记录时为空', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-issues-'))
    try {
      const qs = new QualityStore(root, 'c')
      const profile = { goal: '学 x' } as Profile
      const map = { nodes: [{ id: 'n1', title: 'N1' }], edges: [], resources: [] } as unknown as KnowledgeMap
      const bank = { n1: [{ id: 'n1-d3', difficulty: 3, type: 'short', question: '输出什么？', answer: 'ok', accept: ['ok'] }] } as unknown as QuestionBank
      const input = bankContent(bank, 'n1', profile, map)

      assert.deepEqual(qs.issuesFor([input]), [])

      const id = '11111111-1111-4111-8111-111111111111'
      const dir = path.join(root, 'c', 'quality', 'reviews')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
        id, key: contentKey(input), policy: QUALITY_POLICY, input, status: 'rejected',
        issues: ['n1-d3：规则判分题须为四选一或单一数值填空'],
        startedAt: '2026-10-10T00:00:00.000Z', completedAt: '2026-10-10T00:01:00.000Z', calls: [],
      }))

      const issues = qs.issuesFor([input])
      assert.equal(issues.length, 1)
      assert.equal(issues[0].kind, 'bank')
      assert.equal(issues[0].node, 'n1')
      assert.match(issues[0].issues[0], /四选一/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
