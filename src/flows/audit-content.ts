import type { KnowledgeMap, LessonState, Plan, PracticeTaskFile, Profile, QuestionBank } from '../core/schema.ts'
import { bankContent, lessonContent, mapContent, planContent, practiceContent, teachingContent, type ContentInput } from '../core/content-quality.ts'
import { createContentGate } from './content-gate.ts'
import type { FlowDeps } from './deps.ts'

export async function runAuditContent(deps: FlowDeps, config: { courseId: string }): Promise<number> {
  const { store, io } = deps
  const courseId = config.courseId
  const profile = store.read(courseId, 'profile') as Profile
  const map = store.read(courseId, 'knowledge-map') as KnowledgeMap
  const gate = createContentGate(deps, courseId)
  const items: ContentInput[] = [mapContent(map, profile)]
  if (store.has(courseId, 'plan')) items.push(planContent(store.read(courseId, 'plan') as Plan, profile, map))
  if (store.has(courseId, 'question-bank')) {
    const bank = store.read(courseId, 'question-bank') as QuestionBank
    for (const node of Object.keys(bank)) if (bank[node].length) items.push(bankContent(bank, node, profile, map))
  }
  if (store.has(courseId, 'lesson')) {
    const lesson = store.read(courseId, 'lesson') as LessonState
    items.push(lessonContent(lesson.draft, profile, map))
    if (lesson.approved_turn) items.push(teachingContent(lesson.approved_turn, lesson.node, profile, map))
  }
  if (store.has(courseId, 'practice')) {
    const file = store.read(courseId, 'practice') as PracticeTaskFile
    for (const node of new Set(file.tasks.map(t => t.node))) items.push(practiceContent(file.tasks.filter(t => t.node === node), node, profile, map))
  }
  let failures = 0
  let errors = 0
  for (const item of items) {
    io.out(`审查已有内容：${item.kind} ${item.context.activeNodes.join('、')}…\n`)
    try {
      const verdict = await gate.review(item)
      if (!verdict.approved) {
        failures++
        io.out(`未通过：${verdict.evidenceFile}\n`)
      } else if (verdict.cached) io.out('当前内容已有有效审查记录。\n')
    } catch (error) {
      errors++
      io.err(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  io.out(`内容审查完成：${items.length - failures - errors}/${items.length} 项通过；${failures} 项拒绝，${errors} 项未完成。\n`)
  if (failures || errors) io.out('审查记录位于课程 quality/reviews/。可修正 YAML 后重审，或用 research / plan / assess / learn / practice-gen 重新生成相应内容。\n')
  return errors ? 1 : failures ? 2 : 0
}
