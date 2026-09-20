import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { buildPrepPrompt, buildCheckPrompt, buildTeachingIntro, checkCitations, currentNode, resourcesForNode, validateLessonDraft, type LessonResourceView } from '../core/lesson.ts'
import { judgeQuizAnswer, updateMasteryForNode } from '../core/assessment.ts'
import { dueReviews } from '../core/review.ts'
import { extractProfileJson } from '../core/interview.ts'
import type { KnowledgeMap, LessonDraft, LessonState, Mastery, Plan, Profile } from '../core/schema.ts'
import { createAgentChat, type AgentChat } from './agent-chat.ts'
import { createLineReader } from './line-reader.ts'
import { generateTurn, parseJsonBlock } from './generation.ts'
import { loadCostConfigFromRepo, printSessionTotal } from './cost-line.ts'
import { formatTurnCost } from '../core/cost.ts'

const name = 'tutor-learn-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({ courseId: z.string().required() })

interface StoreView {
  root: string
  exists(id: string): boolean
  has(id: string, kind: string): boolean
  read(id: string, kind: string): unknown
  write(id: string, kind: string, data: unknown): void
  remove(id: string, kind: string): void
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function startFreshLesson(
  ctx: Context,
  config: { courseId: string },
  store: StoreView,
  plan: Plan,
  map: KnowledgeMap,
  profile: Profile,
  mastery: Mastery | undefined,
  node: string,
  resources: LessonResourceView[],
  readAnswer: () => Promise<string | null>
): Promise<{ chat: AgentChat; draft: LessonDraft }> {
  const out = process.stdout
  const prepChat = await createAgentChat(ctx)
  if (!prepChat) throw new Error('tutor: 备课会话创建失败')
  out.write(`正在备课：${node}…\n`)
  const draft = (await generateTurn(prepChat, buildPrepPrompt({ courseId: config.courseId, node, map, plan, profile, mastery }), (text) => {
    const data = parseJsonBlock(text)
    if (!data.ok) return data
    return validateLessonDraft(data.value, node)
  })) as LessonDraft
  await prepChat.flush()
  out.write('备课完成，开始上课。\n')

  const teachChat = await createAgentChat(ctx)
  if (!teachChat) throw new Error('tutor: 课堂会话创建失败')
  void readAnswer
  store.write(config.courseId, 'lesson', {
    session_id: teachChat.sessionId,
    node,
    started_at: today(),
    draft,
  })
  const reply = await teachChat.ask(buildTeachingIntro({ courseId: config.courseId, node, plan, profile, mastery, draft, resources }))
  out.write(`\n${reply}`)
  return { chat: teachChat, draft }
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
  const readAnswer = createLineReader(process.stdin)
  const mastery = store.has(config.courseId, 'mastery') ? (store.read(config.courseId, 'mastery') as Mastery) : undefined
  const due = mastery ? dueReviews(mastery, today()) : []
  if (due.length > 0) {
    out.write(`提醒：${due.length} 个知识点到复习期（${due.map((d) => d.node).join('、')}）——回访先复习再继续：npm run agent -- review ${config.courseId}\n\n`)
  }
  const node = currentNode(plan, mastery)
  if (!node) {
    out.write('计划内知识点均已掌握，无课可上。可运行 assess 重新摸底或 plan 修订计划。\n')
    exit(0)
    return
  }

  let chat: AgentChat | null = null
  let draft: LessonDraft | null = null
  let resumed = false
  if (store.has(config.courseId, 'lesson')) {
    const lesson = store.read(config.courseId, 'lesson') as LessonState
    const draftValid = validateLessonDraft(lesson.draft, lesson.node).ok
    if (draftValid && lesson.node === node && lesson.session_id) {
      const adopted = await createAgentChat(ctx, { resumeSessionId: lesson.session_id })
      if (adopted) {
        chat = adopted
        draft = lesson.draft
        resumed = true
        out.write(`从上次断点继续本课（${node}）。\n\n${chat.lastReply()}`)
      }
    }
    if (!resumed) {
      store.remove(config.courseId, 'lesson')
      out.write('上次课堂已失效，重新备课。\n')
    }
  }
  const resources = resourcesForNode(map.resources, node)
  if (!resumed || chat === null || draft === null) {
    const fresh = await startFreshLesson(ctx, config, store, plan, map, profile, mastery, node, resources, readAnswer)
    chat = fresh.chat
    draft = fresh.draft
  }
  if (chat === null || draft === null) throw new Error('tutor: 课堂会话初始化失败')
  const replies: string[] = [chat.lastReply()].filter((r) => r !== '')

  const costConfig = loadCostConfigFromRepo()
  const colorEnabled = out.isTTY === true
  const disconnectStdin = () => {
    process.stdin.destroy()
  }
  const pause = async () => {
    await chat.flush()
    printSessionTotal(chat, out)
    out.write('\n本课暂停（进度已保存）。重新运行 learn 将从断点继续。\n')
    disconnectStdin()
    exit(0)
  }
  while (true) {
    out.write('\n> ')
    const line = await readAnswer()
    const command = line?.trim() ?? ''
    if (!line || command === '/exit') {
      await pause()
      return
    }
    if (command === '/check') {
      if (replies.length === 0) {
        out.write('\n本课尚无讲授内容，无需核对。\n')
        continue
      }
      out.write('\n事实核对（规则引用检查 + 模型断言核对）…\n')
      const citation = checkCitations(replies.join('\n'), resources.length)
      out.write(`引用标记：${citation.cited.length > 0 ? `使用了 [资料:${citation.cited.join('] [资料:')}]` : '未使用'}${citation.invalid.length > 0 ? `，无效编号：${citation.invalid.join('、')}` : ''}\n`)
      if (resources.length === 0) {
        out.write('本课知识点无联网资料（先运行 research），仅做规则检查。\n')
        continue
      }
      const checkReply = await chat.ask(buildCheckPrompt(replies, resources))
      const checkData = extractProfileJson(checkReply)
      const claims = (checkData && typeof checkData === 'object' ? (checkData as { claims?: unknown }).claims : null) as
        | { claim: string; verdict: string; evidence?: string }[]
        | null
      if (Array.isArray(claims) && claims.length > 0) {
        const mark: Record<string, string> = { supported: '✓', unverified: '?', contradicted: '✗' }
        for (const claim of claims) {
          out.write(`  ${mark[claim.verdict] ?? '?'} ${claim.claim}${claim.evidence ? `（${claim.evidence}）` : ''}\n`)
        }
        const bad = claims.filter((c) => c.verdict !== 'supported').length
        out.write(bad === 0 ? '核对通过：全部断言有资料支撑。\n' : `发现 ${bad} 处需注意的断言，讲授中请以此为准。\n`)
      } else {
        out.write('核对结果解析失败，请重试。\n')
      }
      continue
    }
    if (command === '/quiz') {
      out.write(`\n单元小测（${draft.quiz.length} 题，规则判分）\n`)
      let correct = 0
      for (const [index, item] of draft.quiz.entries()) {
        out.write(`\n小测 ${index + 1}/${draft.quiz.length}：${item.question}\n`)
        for (const choice of item.choices ?? []) out.write(`  ${choice}\n`)
        const answer = await readAnswer()
        if (!answer || !answer.trim()) {
          out.write('小测中止，本次不做掌握度更新，本课保留断点。\n')
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
      store.remove(config.courseId, 'lesson')
      const entry = updatedMastery[node]
      out.write(`\n小测得分：${score}（${correct}/${draft.quiz.length}）\n`)
      out.write(`掌握度更新：${node} → ${entry.status}${entry.score !== undefined ? `（${entry.score}）` : ''}${entry.review_due !== undefined ? `，复习到期 ${entry.review_due}` : ''}\n`)
      out.write(pointer ? `计划指针：${node} → ${pointer}\n` : '计划内知识点均已掌握，课程完成。\n')
      await chat.flush()
      printSessionTotal(chat, out)
      disconnectStdin()
      exit(0)
      return
    }
    const reply = await chat.ask(command)
    replies.push(reply)
    out.write(`\n${reply}\n${formatTurnCost(chat.lastTurnUsage(), chat.model, costConfig, colorEnabled)}`)
  }
}

export function apply(ctx: Context, config: { courseId: string }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-learn-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy()
    exit(1)
  })
}

export { name, inject, Config }
