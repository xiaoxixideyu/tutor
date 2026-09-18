import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { buildPrepPrompt, buildTeachingIntro, currentNode, validateLessonDraft } from '../core/lesson.ts'
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
  let reply = await teachChat.ask(buildTeachingIntro({ courseId: config.courseId, node, plan, profile, mastery, draft }))
  while (true) {
    out.write(`\n${reply}\n\n> `)
    const line = await readAnswer()
    if (!line || !line.trim() || line.trim() === '/exit') {
      await teachChat.flush()
      out.write(`\n本课暂停（进度已保存在会话日志）。重新运行 learn 可继续本课。\n`)
      exit(0)
      return
    }
    reply = await teachChat.ask(line.trim())
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
