import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CourseStore } from '../core/store.ts'
import type { KnowledgeMap, LessonState, Plan, PracticeTaskFile, Profile, QuestionBank } from '../core/schema.ts'
import { bankContent, lessonContent, mapContent, planContent, practiceContent, teachingContent, type ContentInput } from '../core/content-quality.ts'
import { createContentGate } from './content-gate.ts'

export const name = 'tutor-audit-content-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
export const Config = z.object({ courseId: z.string().required() })

async function run(ctx: Context, courseId: string): Promise<number> {
  const store = (ctx.get('courseState') as { store: CourseStore }).store
  const profile = store.read(courseId, 'profile') as Profile
  const map = store.read(courseId, 'knowledge-map') as KnowledgeMap
  const gate = createContentGate(ctx, store, courseId)
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
    process.stdout.write(`审查已有内容：${item.kind} ${item.context.activeNodes.join('、')}…\n`)
    try {
      const verdict = await gate.review(item)
      if (!verdict.approved) {
        failures++
        process.stdout.write(`未通过：${verdict.evidenceFile}\n`)
      } else if (verdict.cached) process.stdout.write('当前内容已有有效审查记录。\n')
    } catch (error) {
      errors++
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  process.stdout.write(`内容审查完成：${items.length - failures - errors}/${items.length} 项通过；${failures} 项拒绝，${errors} 项未完成。\n`)
  if (failures || errors) process.stdout.write('审查记录位于课程 quality/reviews/。可修正 YAML 后重审，或用 research / plan / assess / learn / practice-gen 重新生成相应内容。\n')
  return errors ? 1 : failures ? 2 : 0
}

export function apply(ctx: Context, config: { courseId: string }): void {
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  run(ctx, config.courseId).then(code => { process.stdin.destroy(); exit(code) }).catch(error => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy(); exit(1)
  })
}
