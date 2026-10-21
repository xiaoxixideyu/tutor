import { buildPrepPrompt, buildTeachingIntro, checkCitations, currentNode, lessonStructureCap, memoryNotes, prerequisiteIds, resourcesForNode, selectInterleaveQuestion, selectWarmupQuestions, stalePrerequisites, validateLessonDraft, type LessonResourceView, type WarmupRecord } from '../core/lesson.ts'
import { formatChoice, applyReviewResult, judgeQuizAnswer, updateMasteryForNode } from '../core/assessment.ts'
import { dueReviews } from '../core/review.ts'
import { requireReviewedBank } from '../core/quality-store.ts'
import { calibrationInsight, detectStyleSignal, LearnerNotesStore, parseConfidence, CALIBRATION_BIAS_THRESHOLD } from '../core/learner-notes.ts'
import { appendMasteryEvent } from '../core/events.ts'
import type { KnowledgeMap, LessonDraft, LessonState, Mastery, Plan, Profile, QuestionBank } from '../core/schema.ts'
import type { AgentChat } from '../runtime/chat.ts'
import { parseJsonBlock } from './generation.ts'
import { loadCostConfigFromRepo, printSessionTotal } from './cost-line.ts'
import { withChatUsage } from './cost-ledger.ts'
import { formatTurnCost } from '../core/cost.ts'
import { lessonContent, mapContent, planContent, replayApprovedReply, teachingContent, type ApprovedTeachingTurn } from '../core/content-quality.ts'
import { createContentGate, generateApproved, generateApprovedTeaching, type ContentGate } from './content-gate.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'
import { requirePlanMapConsistency } from './consistency.ts'

async function publishTeaching(deps: FlowDeps, gate: ContentGate, chat: AgentChat, turn: ApprovedTeachingTurn, node: string, profile: Profile, map: KnowledgeMap, text: string): Promise<void> {
  const seq = chat.lastReplySeq()
  if (seq === undefined || seq === null) throw new Error('缺少课堂事件编号，无法记录发布')
  deps.io.out(text)
  gate.store.publish(teachingContent(turn, node, profile, map), chat.sessionId, seq)
}

// 开课热身：对到期或低保留的前置做回忆检查（规则判分、零模型成本、不计分）。
// 结果随首消息注入导师上下文；题库缺失或未过审时静默跳过，不阻塞开课。
async function runWarmup(deps: FlowDeps, courseId: string, node: string, map: KnowledgeMap, mastery: Mastery | undefined): Promise<WarmupRecord[]> {
  const { store, io } = deps
  if (!mastery || !store.has(courseId, 'question-bank')) return []
  let bank: QuestionBank
  try {
    bank = store.read(courseId, 'question-bank') as QuestionBank
  } catch {
    // 热身是可选步骤：题库损坏/未通过 schema 时不应阻塞开课。
    return []
  }
  let picks: ReturnType<typeof selectWarmupQuestions>
  try {
    picks = selectWarmupQuestions(map, mastery, bank, node, deps.today())
    for (const pick of picks) requireReviewedBank(store, courseId, bank, pick.node)
  } catch {
    return []
  }
  if (picks.length === 0) return []
  io.out('\n【回忆热身】先花两分钟回顾本课要用到的前置知识（不计分）。\n')
  const results: WarmupRecord[] = []
  for (const [index, pick] of picks.entries()) {
    io.out(`\n热身 ${index + 1}/${picks.length}：${pick.node}（${pick.title ?? pick.node}）\n${pick.question.question}\n`)
    for (const [i, choice] of (pick.question.choices ?? []).entries()) io.out(`  ${formatChoice(choice, i)}\n`)
    io.out('\n> ')
    const answer = await io.readLine()
    if (!answer || !answer.trim() || answer.trim() === '/exit') {
      io.out('热身中止，本课暂停（进度已保存）。重新运行 learn 继续。\n')
      throw new FlowExit(0)
    }
    const correct = judgeQuizAnswer(pick.question, answer)
    const correctAnswer = (pick.question.choices?.length ?? 0) > 0 ? pick.question.answer.toUpperCase() : pick.question.answer
    io.out(correct ? '✓ 正确\n' : `✗ 错误（正确答案：${correctAnswer}）\n`)
    results.push({ node: pick.node, ...(pick.title !== undefined ? { title: pick.title } : {}), question: pick.question.question, correct, questionId: pick.question.id })
  }
  const right = results.filter((item) => item.correct).length
  io.out(`\n热身完成（${right}/${results.length} 正确），开始本课。\n`)
  // 热身不计分、不写掌握度，但作为学习活动进事件流（成绩轨迹只收有分事件，不受影响）。
  try {
    for (const [index, result] of results.entries()) {
      appendMasteryEvent(store.root, courseId, {
        key: `warmup:${courseId}:${node}:${deps.today()}:${picks[index].question.id}`,
        at: deps.today(), node: result.node, kind: 'warmup', passed: result.correct,
      })
    }
  } catch { /* 辅助数据写入失败忽略 */ }
  return results
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
  prepNotes: { errors?: { node: string; question: string; your: string }[]; calibration?: { at: string; predicted: number; actual: number }; styleNotes?: { at: string; kind: 'confused' | 'resolved'; detail: string }[] },
  savedDraft?: LessonDraft,
  previousTurn?: ApprovedTeachingTurn
): Promise<{ chat: AgentChat; draft: LessonDraft; turn: ApprovedTeachingTurn; warmupQuestionIds: string[] }> {
  const { store, io } = deps
  let draft = savedDraft
  if (!draft) {
    const prepChat = await deps.createChat()
    io.out(`正在备课：${node}…\n`)
    const cap = lessonStructureCap(profile.daily_minutes)
    draft = await withChatUsage(deps.costs, prepChat, 'prep', () => generateApproved<LessonDraft>(prepChat, buildPrepPrompt({ courseId: config.courseId, node, map, plan, profile, mastery, today: deps.today(), ...prepNotes }), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      return validateLessonDraft(data.value, node, cap)
    }, gate, value => lessonContent(value, profile, map)))
    io.out('备课开销：')
    printSessionTotal(prepChat, deps)
    // 没有可恢复的已批准讲授时，先保存新教案；被拒旧教案不能阻止落盘。
    // 可用的已批准课堂断点仍由后续新讲授替换，不能在尝试恢复时提前覆盖。
    if (!previousTurn) store.write(config.courseId, 'lesson', { node, started_at: deps.today(), draft })
    io.out('备课完成并通过审查，准备开课。\n')
  }

  // 新开课先做前置回忆热身（续讲/恢复不重复做），结果与记忆状态一起注入导师首消息。
  const warmup = previousTurn ? [] : await runWarmup(deps, config.courseId, node, map, mastery)
  const memory = memoryNotes(map, mastery, node, deps.today())
  const teachChat = await deps.createChat()
  const intro = buildTeachingIntro({ courseId: config.courseId, node, plan, profile, mastery, draft, resources,
    ...(memory.length > 0 ? { memory } : {}), ...(warmup.length > 0 ? { warmup } : {}) })
  const turn = await withChatUsage(deps.costs, teachChat, 'teach', () => generateApprovedTeaching(teachChat, previousTurn
    ? `${intro}\n恢复课堂：上一段已向学员展示的内容为 ${JSON.stringify(previousTurn)}。从这个进度继续，不重讲已完成的部分。` : intro,
  gate, { node, profile, map, learnerMessage: previousTurn ? '恢复本课' : '开始本课', previousReply: previousTurn?.reply ?? '' }))
  store.write(config.courseId, 'lesson', {
    session_id: teachChat.sessionId,
    node,
    started_at: deps.today(),
    draft,
    approved_turn: turn,
  })
  await publishTeaching(deps, gate, teachChat, turn, node, profile, map, `\n${turn.reply}`)
  return { chat: teachChat, draft, turn, warmupQuestionIds: warmup.flatMap((item) => (item.questionId !== undefined ? [item.questionId] : [])) }
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
  requirePlanMapConsistency(deps, config.courseId, plan, map)
  const gate = createContentGate(deps, config.courseId)
  await gate.require(mapContent(map, profile))
  await gate.require(planContent(plan, profile, map))
  const mastery = store.has(config.courseId, 'mastery') ? (store.read(config.courseId, 'mastery') as Mastery) : undefined
  const notes = new LearnerNotesStore(store.root, config.courseId)
  // 观察记录与事件流是辅助数据：写失败不阻塞课堂（YAML 状态才是事实来源）。
  const bestEffort = (work: () => void) => { try { work() } catch { /* 辅助数据写入失败忽略 */ } }
  const due = mastery ? dueReviews(mastery, deps.today()) : []
  if (due.length > 0) {
    const listed = due.map((d) => (d.overdue_days > 0 ? `${d.node}（逾期 ${d.overdue_days} 天）` : d.node)).join('、')
    const severe = due.filter((d) => d.overdue_days >= 7).length
    io.out(`提醒：${due.length} 个知识点到复习期（${listed}）——回访先复习再继续：npm run agent -- review ${config.courseId}\n`)
    if (severe > 0) io.out(`其中 ${severe} 个已逾期 ≥7 天，建议先复习再上新课。\n`)
    io.out('\n')
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
  const hadLesson = store.has(config.courseId, 'lesson')
  if (hadLesson) {
    // 断点文件损坏时不能整门课卡死：归档后按新课继续。
    let lesson: LessonState | undefined
    try {
      lesson = store.read(config.courseId, 'lesson') as LessonState
    } catch (error) {
      io.err(`tutor: 课堂断点无法读取（${error instanceof Error ? error.message : String(error)}），已归档并按新课开始。\n`)
      try {
        store.archive(config.courseId, ['lesson'], { label: 'broken-lesson', removeKinds: ['lesson'] })
      } catch { try { store.remove(config.courseId, 'lesson') } catch { /* 归档失败也继续开新课 */ } }
    }
    if (lesson) {
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
  }
  // 前置新鲜度软门：只有确实恢复到原课堂时才跳过；旧断点（其他节点/已失效）同样要提示。
  if (!resumed) {
    const stale = mastery ? stalePrerequisites(map, mastery, node, deps.today()) : []
    if (stale.length > 0) {
      const described = stale.map((item) => {
        const detail = item.retention !== undefined
          ? `预计保留 ≈${Math.round(item.retention * 100)}%，距上次实测 ${item.elapsedDays} 天`
          : `逾期 ${item.overdue_days ?? 0} 天`
        return `${item.node}（${detail}）`
      }).join('、')
      io.out(`\n前置知识可能已生疏：${described}。\n建议先复习再上新课（npm run agent -- review ${config.courseId}）。\n输入 c 直接开始本课（会先做回忆热身），或直接回车暂停：\n> `)
      const line = await io.readLine()
      if (line === null || line.trim().toLowerCase() !== 'c') {
        io.out('已暂停。先复习再回来上新课。\n')
        throw new FlowExit(0)
      }
    }
  }
  const resources = resourcesForNode(map.resources, node)
  const errorLines = notes.errorsFor([node, ...prerequisiteIds(map, node)])
  const insight = calibrationInsight(notes.latestCalibration())
  const styleNotes = notes.recentStyle(4)
  const prepNotes = {
    ...(errorLines.length > 0 ? { errors: errorLines } : {}),
    ...(insight ? { calibration: insight.note } : {}),
    ...(styleNotes.length > 0 ? { styleNotes } : {}),
  }
  let warmupQuestionIds: string[] = []
  if (!resumed || chat === null || draft === null) {
    const fresh = await startFreshLesson(deps, config, plan, map, profile, mastery, node, resources, gate, prepNotes, draft ?? undefined, approvedTurn)
    chat = fresh.chat
    draft = fresh.draft
    approvedTurn = fresh.turn
    warmupQuestionIds = fresh.warmupQuestionIds
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
      io.out('先估一下你对本课内容的把握（0-100，回车跳过）：\n> ')
      const predicted = parseConfidence(await io.readLine())
      let correct = 0
      const wrongItems: { question: string; your: string; answer: string }[] = []
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
        if (!ok) wrongItems.push({ question: item.question, your: answer.trim(), answer: correctAnswer })
      }
      const score = Math.round((correct / draft.quiz.length) * 100) / 100
      let updatedMastery = updateMasteryForNode(mastery, node, score, deps.today())
      store.write(config.courseId, 'mastery', updatedMastery)
      bestEffort(() => {
        notes.recordErrors(node, wrongItems, deps.today(), 'quiz')
        if (predicted !== undefined) notes.recordCalibration({ at: deps.today(), node, predicted, actual: score })
        appendMasteryEvent(store.root, config.courseId, { key: `quiz:${chat.sessionId}`, at: deps.today(), node, kind: 'quiz', score, passed: score >= 0.5 })
      })

      // 旧知识回访（交错练习）：只取已掌握节点的一题；失败按复习对待（衰减并可能回退指针）。
      const bank = store.has(config.courseId, 'question-bank') ? (store.read(config.courseId, 'question-bank') as QuestionBank) : {}
      const interleave = selectInterleaveQuestion(map, updatedMastery, bank, node, deps.today(), warmupQuestionIds)
      let interleaveNote = ''
      if (interleave) {
        try {
          requireReviewedBank(store, config.courseId, bank, interleave.node)
          io.out(`\n旧知识回访：${interleave.node}（${interleave.title ?? interleave.node}）\n${interleave.question.question}\n`)
          for (const [i, choice] of (interleave.question.choices ?? []).entries()) io.out(`  ${formatChoice(choice, i)}\n`)
          io.out('\n> ')
          const answer = await io.readLine()
          if (!answer || !answer.trim() || answer.trim() === '/exit') {
            io.out('跳过本次回访。\n')
          } else {
            const ok = judgeQuizAnswer(interleave.question, answer)
            const correctAnswer = (interleave.question.choices?.length ?? 0) > 0 ? interleave.question.answer.toUpperCase() : interleave.question.answer
            io.out(ok ? '✓ 正确\n' : `✗ 错误（正确答案：${correctAnswer}）\n`)
            updatedMastery = applyReviewResult(updatedMastery, interleave.node, ok ? 1 : 0, deps.today())
            store.write(config.courseId, 'mastery', updatedMastery)
            const entry = updatedMastery[interleave.node]
            interleaveNote = `旧知识回访：${interleave.node} → ${entry.status}${entry.score !== undefined ? `（${entry.score}）` : ''}${entry.review_due !== undefined ? `，复习到期 ${entry.review_due}` : ''}\n`
            bestEffort(() => {
              if (!ok) notes.recordErrors(interleave.node, [{ question: interleave.question.question, your: answer.trim(), answer: correctAnswer }], deps.today(), 'interleave')
              appendMasteryEvent(store.root, config.courseId, { key: `interleave:${chat.sessionId}`, at: deps.today(), node: interleave.node, kind: 'interleave', score: ok ? 1 : 0, passed: ok })
            })
          }
        } catch { /* 题库未过审或读取失败：跳过回访，不影响小测结算 */ }
      }

      const pointer = currentNode(plan, updatedMastery, map)
      // 课程完成时不能写 current: undefined：YAML 层的旧实现会把它落成 null，
      // 而 planMapMismatch 会把 null 当成一个不存在的节点。直接省略字段。
      const updatedPlan: Plan = pointer
        ? { ...plan, current: pointer }
        : (() => {
            const { current: _current, ...rest } = plan
            return rest
          })()
      store.write(config.courseId, 'plan', updatedPlan)
      store.remove(config.courseId, 'lesson')
      const entry = updatedMastery[node]
      io.out(`\n小测得分：${score}（${correct}/${draft.quiz.length}）\n`)
      if (predicted !== undefined) {
        const actual = Math.round(score * 100)
        const bias = predicted - actual
        io.out(`自评把握 ${predicted}%，实际 ${actual}%${Math.abs(bias) >= CALIBRATION_BIAS_THRESHOLD ? `（${bias > 0 ? '高估' : '低估'} ${Math.abs(bias)} 点，已记入教学参考）` : '（校准良好）'}\n`)
      }
      io.out(`掌握度更新：${node} → ${entry.status}${entry.score !== undefined ? `（${entry.score}）` : ''}${entry.review_due !== undefined ? `，复习到期 ${entry.review_due}` : ''}\n`)
      if (interleaveNote) io.out(interleaveNote)
      io.out(pointer ? `计划指针：${node} → ${pointer}\n` : '计划内知识点均已掌握，课程完成。\n')
      await chat.flush()
      printSessionTotal(chat, deps)
      disconnectInput()
      throw new FlowExit(0)
    }
    const signal = detectStyleSignal(command)
    if (signal) bestEffort(() => notes.recordStyle({ at: deps.today(), kind: signal.kind, detail: signal.detail }))
    if (!approvedTurn) throw new Error('tutor: 缺少已通过审查的讲授断点')
    const previousReply: string = approvedTurn.reply
    const nextTurn: ApprovedTeachingTurn = await withChatUsage<ApprovedTeachingTurn>(deps.costs, chat, 'teach',
      () => generateApprovedTeaching(chat, command, gate, { node, profile, map, learnerMessage: command, previousReply }))
    approvedTurn = nextTurn
    store.write(config.courseId, 'lesson', { session_id: chat.sessionId, node, started_at: deps.today(), draft, approved_turn: approvedTurn })
    approvedTurns.push(approvedTurn)
    await publishTeaching(deps, gate, chat, approvedTurn, node, profile, map, `\n${approvedTurn.reply}`)
    io.out(`\n${formatTurnCost(chat.lastTurnUsage(), chat.model, costConfig, colorEnabled)}`)
  }
}
