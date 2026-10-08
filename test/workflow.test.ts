import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CourseStore } from '../src/core/store.ts'
import { assemblePlan, buildPlanPath, masteredFromMastery } from '../src/core/plan.ts'
import { currentNode } from '../src/core/lesson.ts'
import { updateMasteryForNode } from '../src/core/assessment.ts'
import { createRpcMethods } from '../src/core/rpc.ts'
import { practiceGenerationNodes, selectPracticeNode } from '../src/core/practice.ts'
import type { KnowledgeMap, Mastery, Plan, QuestionBank } from '../src/core/schema.ts'
import { bankContent } from '../src/core/content-quality.ts'
import { approveFixture } from './fixtures/quality.ts'

const map: KnowledgeMap = { verified: false, nodes: [{ id: 'basics', title: '基础' }, { id: 'advanced', title: '进阶' }],
  edges: [['advanced', 'basics']] }
const initial: Mastery = { basics: { status: 'mastered', score: 1, review_due: '2026-10-08', review_stage: 2 },
  advanced: { status: 'learning', score: 0.5 } }

it('重规划跳过已掌握节点后，复习全错让看板和课堂回到该节点；补救通过后继续原路径', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-workflow-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new CourseStore(root)
  store.create('alpha', { goal: '学习' })
  store.write('alpha', 'knowledge-map', map)
  store.write('alpha', 'mastery', initial)
  const plan = assemblePlan(buildPlanPath(map, masteredFromMastery(initial)), [], ['basics', 'advanced'])
  assert.deepEqual(plan.path, ['advanced'])
  store.write('alpha', 'plan', plan)
  store.write('alpha', 'question-bank', { basics: [
    { id: 'q1', difficulty: 2, type: 'short', question: '1+1', answer: '2' },
    { id: 'q2', difficulty: 3, type: 'short', question: '2+2', answer: '4' },
  ] })
  approveFixture(root, 'alpha', bankContent(store.read('alpha', 'question-bank') as QuestionBank, 'basics', { goal: '学习' }, map))
  const rpc = createRpcMethods(store, () => '2026-10-08')
  const quiz = rpc.reviewQuestions({ id: 'alpha' }) as { items: { attemptId: string }[] }
  rpc.submitReview({ id: 'alpha', node: 'basics', attemptId: quiz.items[0].attemptId, answers: ['错', '错'] })
  const mastery = store.read('alpha', 'mastery') as Mastery
  const restored = store.read('alpha', 'plan') as Plan
  assert.equal(currentNode(restored, mastery), 'basics')
  assert.equal((rpc.courseStatus({ id: 'alpha' }) as { current: string }).current, 'basics')
  assert.equal(currentNode(restored, updateMasteryForNode(mastery, 'basics', 1, '2026-10-08')), 'advanced')
  // 旧计划尚无 scope，也能借助地图找回补救节点；地图外记录不会成为课程。
  delete restored.scope
  assert.equal(currentNode(restored, { ...mastery, ghost: { status: 'weak' } }, map), 'basics')
})

it('全部掌握后生成的空待学路径仍保留补救范围，完成后忽略过期指针', () => {
  const all: Mastery = { basics: { status: 'mastered' }, advanced: { status: 'mastered' } }
  const plan = assemblePlan([], [], ['basics', 'advanced'])
  assert.equal(currentNode(plan, all), null)
  assert.equal(currentNode(plan, { ...all, basics: { status: 'weak' } }), 'basics')
  assert.equal(currentNode({ ...plan, current: 'ghost' }, all), null)
  assert.equal(currentNode({ path: [], milestones: [] }, { ...all, basics: { status: 'weak' } }, map), 'basics')
})

it('已掌握及被重规划跳过的知识点仍可生成、选择和重复实践，拒绝跨课程节点', () => {
  const plan = assemblePlan(['advanced'], [], ['basics', 'advanced'])
  const empty = { generated_at: '2026-10-08', tasks: [] }
  assert.deepEqual(practiceGenerationNodes(plan, map, empty), ['basics', 'advanced'])
  assert.deepEqual(practiceGenerationNodes(plan, map, empty, 'basics'), ['basics'])
  assert.equal(selectPracticeNode(plan, map, initial, 'basics'), 'basics')
  assert.equal(selectPracticeNode(assemblePlan([], [], ['basics', 'advanced']), map,
    { basics: { status: 'mastered' }, advanced: { status: 'mastered' } }), 'basics')
  assert.throws(() => selectPracticeNode(plan, map, initial, 'other-course-node'), /知识地图/)
  assert.throws(() => practiceGenerationNodes(plan, map, empty, 'other-course-node'), /知识地图/)
})
