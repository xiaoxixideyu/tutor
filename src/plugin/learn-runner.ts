import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { buildPrepPrompt, buildTeachingIntro, currentNode, validateLessonDraft } from '../core/lesson.ts'
import { judgeQuizAnswer, updateMasteryForNode } from '../core/assessment.ts'
import type { KnowledgeMap, LessonDraft, Mastery, Plan, Profile } from '../core/schema.ts'
import { createAgentChat } from './agent-chat.ts'
import { createLineReader } from './line-reader.ts'
import { generateTurn, parseJsonBlock } from './generation.ts'

const name = 'tutor-learn-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({ courseId: z.string().required() })

interface StoreView {
  root: string
  exists(id: string): boolean
  has(id: string, kind: string): boolean
  read(id: string, kind: string): unknown
  write(id: string, kind: string, data: unknown): void
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function run(ctx: Context, config: { courseId: string }): Promise<void> {
  const courseState = ctx.get('courseState') as { store: StoreView } | undefined
  if (!courseState) throw new Error('tutor: 核心服务未就绪')
  const store = courseState.store
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  const out = process.stdout
  if (!store.exists(config.courseId)) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    exit(1)
    return
  }
  if (!store.has(config.courseId, 'plan')) {
    process.stderr.write(`tutor: 课程 "${config.courseId}" 缺少教学计划，请先运行 npm run agent -- plan ${config.courseId}\n`)
    exit(1)
    return
  }
  const plan = store.read(config.courseId, 'plan') as Plan
  const map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
  const profile = store.read(config.courseId, 'profile') as Profile
  const mastery = store.has(config.courseId, 'mastery') ? (store.read(config.courseId, 'mastery') as Mastery) : undefined
  const node = currentNode(plan, mastery)
  if (!node) {
    out.write('计划内知识点均已掌握，无课可上。可运行 assess 重新摸底或 plan 修订计划。\n')
    exit(0)
    return
  }

  const prepChat = await createAgentChat(ctx)
  out.write(`正在备课：${node}…\n`)
  const draft = (await generateTurn(prepChat, buildPrepPrompt({ courseId: config.courseId, node, map, plan, profile, mastery }), (text) => {
    const data = parseJsonBlock(text)
    if (!data.ok) return data
    return validateLessonDraft(data.value, node)
  })) as LessonDraft
  await prepChat.flush()
  out.write('备课完成，开始上课。\n')

  const teachChat = await createAgentChat(ctx)
  const readAnswer = createLineReader(process.stdin)
  const pause = async () => {
    await teachChat.flush()
    out.write('\n本课暂停（进度已保存在会话日志）。重新运行 learn 可继续本课。\n')
    exit(0)
  }
  let reply = await teachChat.ask(buildTeachingIntro({ courseId: config.courseId, node, plan, profile, mastery, draft }))
  while (true) {
    out.write(`\n${reply}\n\n> `)
    const line = await readAnswer()
    const command = line?.trim() ?? ''
    if (!line || command === '/exit') {
      await pause()
      return
    }
    if (command === '/quiz') {
      out.write(`\n单元小测（${draft.quiz.length} 题，规则判分）\n`)
      let correct = 0
      for (const [index, item] of draft.quiz.entries()) {
        out.write(`\n小测 ${index + 1}/${draft.quiz.length}：${item.question}\n`)
        for (const choice of item.choices ?? []) out.write(`  ${choice}\n`)
        const answer = await readAnswer()
        if (!answer || !answer.trim()) {
          out.write('小测中止，本次不做掌握度更新。\n')
          await pause()
          return
        }
        const ok = judgeQuizAnswer(item, answer)
        correct += ok ? 1 : 0
        const correctAnswer = (item.choices?.length ?? 0) > 0 ? item.answer.toUpperCase() : item.answer
        out.write(ok ? '✓ 正确\n' : `✗ 错误（正确答案：${correctAnswer}）\n`)
      }
      const score = Math.round((correct / draft.quiz.length) * 100) / 100
      const updatedMastery = updateMasteryForNode(mastery, node, score, today())
      store.write(config.courseId, 'mastery', updatedMastery)
      const pointer = currentNode(plan, updatedMastery)
      const updatedPlan: Plan = pointer ? { ...plan, current: pointer } : { ...plan, current: undefined }
      store.write(config.courseId, 'plan', updatedPlan)
      const entry = updatedMastery[node]
      out.write(`\n小测得分：${score}（${correct}/${draft.quiz.length}）\n`)
      out.write(`掌握度更新：${node} → ${entry.status}${entry.score !== undefined ? `（${entry.score}）` : ''}${entry.review_due !== undefined ? `，复习到期 ${entry.review_due}` : ''}\n`)
      out.write(pointer ? `计划指针：${node} → ${pointer}\n` : '计划内知识点均已掌握，课程完成。\n')
      await teachChat.flush()
      exit(0)
      return
    }
    reply = await teachChat.ask(command)
  }
}

export function apply(ctx: Context, config: { courseId: string }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-learn-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}

export { name, inject, Config }
