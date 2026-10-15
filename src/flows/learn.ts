import { buildPrepPrompt, buildTeachingIntro, checkCitations, currentNode, lessonStructureCap, resourcesForNode, validateLessonDraft, type LessonResourceView } from '../core/lesson.ts'
import { formatChoice, judgeQuizAnswer, updateMasteryForNode } from '../core/assessment.ts'
import { dueReviews } from '../core/review.ts'
import type { KnowledgeMap, LessonDraft, LessonState, Mastery, Plan, Profile } from '../core/schema.ts'
import type { AgentChat } from '../runtime/chat.ts'
import { parseJsonBlock } from './generation.ts'
import { loadCostConfigFromRepo, printSessionTotal } from './cost-line.ts'
import { formatTurnCost } from '../core/cost.ts'
import { lessonContent, mapContent, planContent, replayApprovedReply, teachingContent, type ApprovedTeachingTurn } from '../core/content-quality.ts'
import { createContentGate, generateApproved, generateApprovedTeaching, type ContentGate } from './content-gate.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'
import { today } from './deps.ts'

async function publishTeaching(deps: FlowDeps, gate: ContentGate, chat: AgentChat, turn: ApprovedTeachingTurn, node: string, profile: Profile, map: KnowledgeMap, text: string): Promise<void> {
  const seq = chat.lastReplySeq()
  if (seq === undefined || seq === null) throw new Error('缺少课堂事件编号，无法记录发布')
  deps.io.out(text)
  gate.store.publish(teachingContent(turn, node, profile, map), chat.sessionId, seq)
}

async function startFreshLesson(
  deps: FlowDeps,
  config: { courseId: string },
  plan: Plan,
  map: KnowledgeMap,
  profile: Profile,
  mastery: Mastery | undefined,
  node: string,
  resources: LessonResourceView[],
  gate: ContentGate,
  savedDraft?: LessonDraft,
  previousTurn?: ApprovedTeachingTurn
): Promise<{ chat: AgentChat; draft: LessonDraft; turn: ApprovedTeachingTurn }> {
  const { store, io } = deps
  let draft = savedDraft
  if (!draft) {
    const prepChat = await deps.createChat()
    io.out(`正在备课：${node}…\n`)
    const cap = lessonStructureCap(profile.daily_minutes)
    draft = await generateApproved<LessonDraft>(prepChat, buildPrepPrompt({ courseId: config.courseId, node, map, plan, profile, mastery }), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      return validateLessonDraft(data.value, node, cap)
    }, gate, value => lessonContent(value, profile, map))
    // 没有可恢复的已批准讲授时，先保存新教案；被拒旧教案不能阻止落盘。
    // 可用的已批准课堂断点仍由后续新讲授替换，不能在尝试恢复时提前覆盖。
    if (!previousTurn) store.write(config.courseId, 'lesson', { node, started_at: today(), draft })
    io.out('备课完成并通过审查，准备开课。\n')
  }

  const teachChat = await deps.createChat()
  const intro = buildTeachingIntro({ courseId: config.courseId, node, plan, profile, mastery, draft, resources })
  const turn = await generateApprovedTeaching(teachChat, previousTurn
    ? `${intro}\n恢复课堂：上一段已向学员展示的内容为 ${JSON.stringify(previousTurn)}。从这个进度继续，不重讲已完成的部分。` : intro,
  gate, { node, profile, map, learnerMessage: previousTurn ? '恢复本课' : '开始本课', previousReply: previousTurn?.reply ?? '' })
  store.write(config.courseId, 'lesson', {
    session_id: teachChat.sessionId,
    node,
    started_at: today(),
    draft,
    approved_turn: turn,
  })
  await publishTeaching(deps, gate, teachChat, turn, node, profile, map, `\n${turn.reply}`)
  return { chat: teachChat, draft, turn }
}

export async function runLearn(deps: FlowDeps, config: { courseId: string }): Promise<void> {
  const { store, io } = deps
  if (!store.exists(config.courseId)) {
    io.err(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    throw new FlowExit(1)
  }
  if (!store.has(config.courseId, 'plan')) {
    io.err(`tutor: 课程 "${config.courseId}" 缺少教学计划，请先运行 npm run agent -- plan ${config.courseId}\n`)
    throw new FlowExit(1)
  }
  const plan = store.read(config.courseId, 'plan') as Plan
  const map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
  const profile = store.read(config.courseId, 'profile') as Profile
  const gate = createContentGate(deps, config.courseId)
  await gate.require(mapContent(map, profile))
  await gate.require(planContent(plan, profile, map))
  const mastery = store.has(config.courseId, 'mastery') ? (store.read(config.courseId, 'mastery') as Mastery) : undefined
  const due = mastery ? dueReviews(mastery, today()) : []
  if (due.length > 0) {
    io.out(`提醒：${due.length} 个知识点到复习期（${due.map((d) => d.node).join('、')}）——回访先复习再继续：npm run agent -- review ${config.courseId}\n\n`)
  }
  const node = currentNode(plan, mastery, map)
  if (!node) {
    io.out('计划内知识点均已掌握，无课可上。可运行 assess 重新摸底或 plan 修订计划。\n')
    throw new FlowExit(0)
  }

  let chat: AgentChat | null = null
  let draft: LessonDraft | null = null
  let approvedTurn: ApprovedTeachingTurn | undefined
  let resumed = false
  if (store.has(config.courseId, 'lesson')) {
    const lesson = store.read(config.courseId, 'lesson') as LessonState
    const draftValid = validateLessonDraft(lesson.draft, lesson.node, lessonStructureCap(profile.daily_minutes)).ok
    if (draftValid && lesson.node === node) {
      const admitted = await gate.review(lessonContent(lesson.draft, profile, map))
      if (admitted.approved) {
        draft = lesson.draft
        if (lesson.approved_turn && lesson.session_id && (await gate.review(teachingContent(lesson.approved_turn, node, profile, map))).approved) {
          approvedTurn = lesson.approved_turn
          const adopted = await deps.createChat({ resumeSessionId: lesson.session_id })
          const replay = adopted ? replayApprovedReply(adopted.lastReply(), approvedTurn) : null
          if (adopted && replay !== null) {
            chat = adopted; resumed = true
            await publishTeaching(deps, gate, chat, approvedTurn, node, profile, map, `从上次断点继续本课（${node}）。\n\n${replay}`)
          } else if (adopted) {
            const pending = gate.store.unfinishedTeaching(node, adopted.lastReply(), approvedTurn.reply)
            if (pending && (await gate.review(teachingContent(pending, node, profile, map))).approved) {
              chat = adopted; resumed = true; approvedTurn = pending
              store.write(config.courseId, 'lesson', { ...lesson, approved_turn: pending })
              await publishTeaching(deps, gate, chat, pending, node, profile, map, `上次回复的内容核对已完成，继续本课（${node}）。\n\n${pending.reply}`)
            }
          }
        }
      }
    }
    if (!resumed) {
      io.out('正在从可用的已审查内容恢复课堂…\n')
    }
  }
  const resources = resourcesForNode(map.resources, node)
  if (!resumed || chat === null || draft === null) {
    const fresh = await startFreshLesson(deps, config, plan, map, profile, mastery, node, resources, gate, draft ?? undefined, approvedTurn)
    chat = fresh.chat
    draft = fresh.draft
    approvedTurn = fresh.turn
  }
  if (chat === null || draft === null) throw new Error('tutor: 课堂会话初始化失败')
  if (!approvedTurn) throw new Error('tutor: 缺少已通过审查的讲授断点')
  const approvedTurns: ApprovedTeachingTurn[] = [approvedTurn]

  const costConfig = loadCostConfigFromRepo(deps.workspace)
  const colorEnabled = io.tty
  const disconnectInput = () => { io.closeInput() }
  const pause = async () => {
    await chat.flush()
    printSessionTotal(chat, deps)
    io.out('\n本课暂停（进度已保存）。重新运行 learn 将从断点继续。\n')
    disconnectInput()
    throw new FlowExit(0)
  }
  while (true) {
    io.out('\n> ')
    const line = await io.readLine()
    const command = line?.trim() ?? ''
    if (!line || command === '/exit') {
      await pause()
      return
    }
    if (command === '/check') {
      io.out('\n核对内容准入记录与资料引用编号…\n')
      const citation = checkCitations(approvedTurns.map(turn => turn.reply).join('\n'), resources.length)
      io.out(`引用标记：${citation.cited.length > 0 ? `使用了 [资料:${citation.cited.join('] [资料:')}]` : '未使用'}${citation.invalid.length > 0 ? `，无效编号：${citation.invalid.join('、')}` : ''}\n`)
      for (const turn of approvedTurns) await gate.require(teachingContent(turn, node, profile, map))
      io.out(`本次课堂 ${approvedTurns.length} 段讲授均持有当前范围下的独立审查记录。记录位于 ${store.root}/${config.courseId}/quality/。\n`)
      io.out('引用编号检查只验证编号；内容审查依靠独立推理与数值复算，仍可能漏错。\n')
      continue
    }
    if (command === '/quiz') {
      io.out(`\n单元小测（${draft.quiz.length} 题，规则判分）\n`)
      let correct = 0
      for (const [index, item] of draft.quiz.entries()) {
        io.out(`\n小测 ${index + 1}/${draft.quiz.length}：${item.question}\n`)
        for (const [i, choice] of (item.choices ?? []).entries()) io.out(`  ${formatChoice(choice, i)}\n`)
        io.out('\n> ') // 轮到学员作答：前端靠这个提示符收起忙态、把选项渲染成可点选项
        const answer = await io.readLine()
        if (!answer || !answer.trim() || answer.trim() === '/exit') {
          io.out('小测中止，本次不做掌握度更新，本课保留断点。\n')
          await pause()
          return
        }
        const ok = judgeQuizAnswer(item, answer)
        correct += ok ? 1 : 0
        const correctAnswer = (item.choices?.length ?? 0) > 0 ? item.answer.toUpperCase() : item.answer
        io.out(ok ? '✓ 正确\n' : `✗ 错误（正确答案：${correctAnswer}）\n`)
      }
      const score = Math.round((correct / draft.quiz.length) * 100) / 100
      const updatedMastery = updateMasteryForNode(mastery, node, score, today())
      store.write(config.courseId, 'mastery', updatedMastery)
      const pointer = currentNode(plan, updatedMastery, map)
      const updatedPlan: Plan = pointer ? { ...plan, current: pointer } : { ...plan, current: undefined }
      store.write(config.courseId, 'plan', updatedPlan)
      store.remove(config.courseId, 'lesson')
      const entry = updatedMastery[node]
      io.out(`\n小测得分：${score}（${correct}/${draft.quiz.length}）\n`)
      io.out(`掌握度更新：${node} → ${entry.status}${entry.score !== undefined ? `（${entry.score}）` : ''}${entry.review_due !== undefined ? `，复习到期 ${entry.review_due}` : ''}\n`)
      io.out(pointer ? `计划指针：${node} → ${pointer}\n` : '计划内知识点均已掌握，课程完成。\n')
      await chat.flush()
      printSessionTotal(chat, deps)
      disconnectInput()
      throw new FlowExit(0)
    }
    approvedTurn = await generateApprovedTeaching(chat, command, gate, { node, profile, map, learnerMessage: command, previousReply: approvedTurn.reply })
    store.write(config.courseId, 'lesson', { session_id: chat.sessionId, node, started_at: today(), draft, approved_turn: approvedTurn })
    approvedTurns.push(approvedTurn)
    await publishTeaching(deps, gate, chat, approvedTurn, node, profile, map, `\n${approvedTurn.reply}`)
    io.out(`\n${formatTurnCost(chat.lastTurnUsage(), chat.model, costConfig, colorEnabled)}`)
  }
}
