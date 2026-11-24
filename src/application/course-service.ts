import { randomUUID } from 'node:crypto'
import { localDate } from '../core/dates.ts'
import { competencyEligibility, competencyStatus, goalSupported, updateMemory } from '../domain/evidence.ts'
import {
  digest,
  id,
  integer,
  object,
  parseActivity,
  parseGoal,
  parseSkills,
  questionHash,
  problemFingerprint,
  strings,
  text,
} from '../domain/validation.ts'
import {
  domainAssert,
  type ActivityContent,
  type ActivityRecord,
  type CompetencyStatus,
  type CourseState,
  type Evidence,
  type Grade,
  type LearningIntent,
  type ModelUsageEntry,
  type Question,
  type TeachingEventType,
  type LearnerInteraction,
  type LearnerTurn,
} from '../domain/model.ts'
import { CourseRepository } from './repository.ts'

export function addEvent(state: CourseState, type: TeachingEventType, data: Record<string, unknown>): void {
  state.events.push({ seq: state.nextEventSeq++, type, at: new Date().toISOString(), data })
  // 重放窗口是轻量消息索引；完整作答、任务和正文存在内容寻址资产中。
  if (state.events.length > 500) state.events.splice(0, state.events.length - 500)
}

export function publicQuestion(question: Question): Record<string, unknown> {
  const { answer: _answer, accept: _accept, tests: _tests, ...visible } = question
  return visible
}

export class CourseService {
  readonly repository: CourseRepository
  private readonly day: () => string
  constructor(repository: CourseRepository, day: () => string = () => localDate()) {
    this.repository = repository
    this.day = day
  }
  today(): string {
    return this.day()
  }

  interaction(state: CourseState): LearnerInteraction {
    if (state.tutorStatus === 'working') return { kind: 'waiting' }
    if (state.pendingAnswer)
      return { kind: 'resume', label: '恢复评分', message: '作答已保存，恢复后继续评阅同一份作答。' }
    if (state.tutorStatus === 'failed')
      return {
        kind: 'resume',
        label: '恢复本次处理',
        message: '本轮未完成，已提交的内容和完成步骤都已保存。',
      }
    const proposal = state.proposals.find((item) => item.status === 'pending')
    if (proposal) return { kind: 'proposal', proposalId: proposal.id }
    let turn: LearnerTurn | undefined = state.learnerTurn
    // 旧快照根据已执行的结构化动作恢复主入口，不解析导师措辞。
    if (!turn) {
      const decision = state.decisions
        .filter(
          (item) =>
            item.status === 'executed' &&
            [
              'ask_learner',
              'give_hint',
              'present_activity',
              'continue_activity',
              'resume_activity',
              'repair_content',
              'finish_session',
            ].includes(item.action),
        )
        .at(-1)
      const message = state.events.filter((item) => item.type === 'tutor_message').at(-1)
      if (decision?.action === 'ask_learner' && typeof message?.data.asset === 'string')
        turn = {
          kind: 'reply',
          at: message.at,
          day: localDate(new Date(message.at)),
          promptAsset: message.data.asset,
          turnId: 'restored:' + message.seq,
        }
      else if (decision?.action === 'finish_session')
        turn = { kind: 'complete', at: decision.at, day: localDate(new Date(decision.at)) }
    }
    if (turn?.kind === 'complete') {
      if (turn.day === this.day() || (state.nextSuggestion?.date ?? '') > this.day() || goalSupported(state))
        return {
          kind: 'complete',
          message: goalSupported(state) ? '学习目标已通过验证' : '本次学习已结束',
          nextLabel: state.nextSuggestion?.label,
          nextDate: state.nextSuggestion?.date,
        }
      return { kind: 'continue', label: '开始今天的学习', intent: state.nextSuggestion?.intent ?? 'learn' }
    }
    if (state.tutorStatus === 'paused')
      return { kind: 'resume', label: '继续本次学习', message: '已暂停，继续后恢复原有问题和作答。' }
    if (turn?.kind === 'reply')
      return {
        kind: 'reply',
        prompt: this.repository.asset<{ text: string }>(state.id, turn.promptAsset).text,
        key: turn.turnId,
      }
    const active = this.activity(state)
    const question = active?.content.questions[active.record.index]
    if (active?.record.status === 'active' && question)
      return { kind: 'answer', activityId: active.record.id, questionId: question.id }
    if (active?.record.status === 'paused')
      return { kind: 'resume', label: '继续这个活动', message: '继续后恢复原有活动和未完成题目。' }
    return {
      kind: 'continue',
      label: active ? '看懂了，继续' : state.activities.length ? '继续学习' : '开始学习',
      intent: state.nextSuggestion?.intent ?? 'learn',
    }
  }

  create(input: unknown): CourseState {
    const raw = object(input)
    const goal = parseGoal({
      text: raw.goal,
      exclusions: raw.exclusions,
      deadline: raw.deadline,
      dailyMinutes: raw.dailyMinutes,
      priority: raw.priority,
      requests: [text(raw.goal, '学习目标', 4000)],
    })
    const title = text(raw.title ?? goal.text.slice(0, 60), '课程名称', 160)
    const courseId =
      raw.id === undefined ? 'course-' + randomUUID().slice(0, 8) : text(raw.id, '课程标识', 64)
    const background = text(raw.background ?? '', '现有基础', 4000, true)
    if (this.repository.exists(courseId)) {
      const existing = this.repository.read(courseId)
      domainAssert(
        existing.creationHash === digest({ title, goal, background }),
        'COURSE_EXISTS',
        '该课程标识已存在，不能覆盖原目标',
        409,
      )
      return existing
    }
    return this.repository.create(courseId, title, goal, background)
  }

  activity(
    state: CourseState,
    activityId = state.currentActivityId,
  ): { record: ActivityRecord; content: ActivityContent } | undefined {
    const record = state.activities.find((item) => item.id === activityId)
    return record
      ? { record, content: this.repository.asset<ActivityContent>(state.id, record.asset) }
      : undefined
  }

  view(courseId: string) {
    const state = this.repository.read(courseId)
    const active = this.activity(state)
    const skills = state.skills.map((skill) => ({
      ...skill,
      status: competencyStatus(state, skill),
      eligibility: competencyEligibility(state, skill),
      judgment: state.judgments[skill.id] ?? null,
      memory: state.memory[skill.id] ?? null,
      evidenceCount: state.evidence.filter(
        (item) => item.kind === 'answer' && item.skillIds.includes(skill.id),
      ).length,
    }))
    return {
      version: state.version,
      id: state.id,
      title: state.title,
      revision: state.revision,
      goal: state.goal,
      learner: state.learner,
      skills,
      supported: skills.filter((skill) => skill.required && skill.status === 'supported').length,
      total: skills.filter((skill) => skill.required).length,
      goalSupported: goalSupported(state),
      tutorStatus: state.tutorStatus,
      tutorError: state.tutorError ?? null,
      interaction: this.interaction(state),
      active: active
        ? {
            id: active.record.id,
            contentHash: active.record.asset,
            kind: active.content.kind,
            title: active.content.title,
            body: active.content.body,
            skillIds: active.content.skillIds,
            rationale: active.content.rationale,
            status: active.record.status,
            index: active.record.index,
            total: active.content.questions.length,
            draft: active.content.questions[active.record.index]
              ? this.repository.readDraft(
                  state.id,
                  active.record.id,
                  active.content.questions[active.record.index].id,
                )
              : null,
            question: active.content.questions[active.record.index]
              ? publicQuestion(active.content.questions[active.record.index])
              : null,
            answers: active.record.answerIds
              .map((answerId) => {
                const evidence = state.evidence.find((item) => item.id === answerId)
                return evidence?.kind === 'answer'
                  ? {
                      questionId: evidence.questionId,
                      grade: evidence.grade,
                      answer: this.repository.asset<{ answer: string }>(state.id, evidence.asset).answer,
                    }
                  : null
              })
              .filter(Boolean),
          }
        : null,
      evidence: state.evidence
        .slice(-80)
        .map((item) =>
          item.kind === 'answer' ? { ...item, asset: undefined } : { ...item, asset: undefined },
        ),
      hypotheses: state.hypotheses,
      decisions: state.decisions.slice(-20),
      proposals: state.proposals.filter((item) => item.status === 'pending'),
      contentFailures: state.contentFailures ?? [],
      sources: state.sources.map(({ asset: _asset, ...source }) => source),
      nextSuggestion: state.nextSuggestion ?? null,
      activeMs: state.activeMs,
      todayActiveMs: state.dailyActiveMs?.[this.day()] ?? 0,
      pendingAnswer: state.pendingAnswer
        ? {
            requestId: state.pendingAnswer.requestId,
            activityId: state.pendingAnswer.activityId,
            questionId: state.pendingAnswer.questionId,
          }
        : null,
      usage: {
        requests: state.usage.length,
        estimatedCost: state.usage.reduce((sum, item) => sum + item.estimatedCost, 0),
        unknown: state.usage.filter((item) => item.unknown).length,
      },
      nextEventSeq: state.nextEventSeq,
      updatedAt: state.updatedAt,
    }
  }

  list() {
    return this.repository.list().map((courseId) => {
      try {
        const state = this.repository.read(courseId)
        const active = this.activity(state)
        return {
          id: state.id,
          title: state.title,
          goal: state.goal.text,
          dailyMinutes: state.goal.dailyMinutes,
          deadline: state.goal.deadline,
          priority: state.goal.priority,
          updatedAt: state.updatedAt,
          supported: state.skills.filter(
            (skill) => skill.required && competencyStatus(state, skill) === 'supported',
          ).length,
          total: state.skills.filter((skill) => skill.required).length,
          goalSupported: goalSupported(state),
          tutorStatus: state.tutorStatus,
          nextSuggestion: state.nextSuggestion ?? null,
          active: active
            ? { id: active.record.id, title: active.content.title, status: active.record.status }
            : null,
          activeMs: state.activeMs,
          todayActiveMs: state.dailyActiveMs?.[this.day()] ?? 0,
          due: Object.values(state.memory).filter((item) => item.reviewDue <= this.day()).length,
        }
      } catch (error) {
        return {
          id: courseId,
          title: '课程状态需要检查',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  }

  observation(courseId: string) {
    const state = this.repository.read(courseId)
    const active = this.activity(state)
    return {
      course: { id: state.id, title: state.title, revision: state.revision },
      today: this.day(),
      goal: state.goal,
      learner: state.learner,
      time: {
        todayActiveMinutes:
          state.evidence
            .filter((item) => item.kind === 'answer' && item.at.slice(0, 10) === this.day())
            .reduce(
              (sum, item) =>
                sum + (this.repository.asset<{ activeMs?: number }>(state.id, item.asset).activeMs ?? 0),
              0,
            ) / 60000,
        deadlineDays: state.goal.deadline
          ? Math.ceil((Date.parse(state.goal.deadline + 'T23:59:59Z') - Date.now()) / 86400000)
          : null,
      },
      skills: state.skills.map((skill) => ({
        ...skill,
        status: competencyStatus(state, skill),
        missingEvidence: competencyEligibility(state, skill).reasons,
        memory: state.memory[skill.id] ?? null,
      })),
      active: active
        ? {
            ...active.content,
            id: active.record.id,
            status: active.record.status,
            index: active.record.index,
            assistance: active.record.assistance,
            completedAnswers: active.record.answerIds,
          }
        : null,
      evidence: state.evidence
        .slice(-30)
        .map((item) => ({ ...item, raw: this.repository.asset(state.id, item.asset) })),
      hypotheses: state.hypotheses.slice(-12),
      sources: state.sources.map((source) => ({
        ...source,
        excerpt: this.repository.asset<{ text: string }>(state.id, source.asset).text.slice(0, 3500),
      })),
      recentDecisions: state.decisions.slice(-6),
      pendingProposals: state.proposals.filter((item) => item.status === 'pending'),
      blockedContent: (state.contentFailures ?? [])
        .slice(-4)
        .map((item) => ({ ...item, draft: this.repository.readTask(state.id, item.taskId) })),
      goalSupported: goalSupported(state),
    }
  }

  beginTurn(
    courseId: string,
    input: {
      requestId: string
      message: string
      intent: LearningIntent
      expectedRevision?: number
      activeMs?: number
      trigger?: 'user' | 'answer_result' | 'resume'
    },
  ) {
    const message = text(input.message, '学习反馈', 20000, true)
    const asset = this.repository.putAsset(courseId, { text: message, intent: input.intent })
    return this.repository.transact(
      courseId,
      {
        expectedRevision: input.expectedRevision,
        requestId: input.requestId,
        input: { message, intent: input.intent, trigger: input.trigger ?? 'user' },
      },
      (state) => {
        domainAssert(!state.pendingAnswer, 'PENDING_ANSWER', '上次作答还未完成评分，请先恢复', 409)
        const evidenceId = 'feedback-' + randomUUID()
        const current = this.activity(state)
        if (current && current.record.status === 'active') {
          const milliseconds = this.activeMilliseconds(input.activeMs ?? 0, current.record.servedAt)
          current.record.activeMs += milliseconds
          state.activeMs += milliseconds
          state.dailyActiveMs ??= {}
          state.dailyActiveMs[this.day()] = (state.dailyActiveMs[this.day()] ?? 0) + milliseconds
          if (current.content.questions.length === 0) {
            current.record.status = 'completed'
            current.record.completedAt = new Date().toISOString()
            delete state.currentActivityId
            addEvent(state, 'activity_completed', { activityId: current.record.id })
          }
        }
        const evidence: Evidence = {
          id: evidenceId,
          kind: 'feedback',
          at: new Date().toISOString(),
          asset,
          summary: message.slice(0, 800),
          ...(current ? { activityId: current.record.id } : {}),
        }
        if (message) state.evidence.push(evidence)
        state.turns[input.requestId] = {
          intent: input.intent,
          messageAsset: asset,
          status: 'pending',
          yielded: false,
          at: new Date().toISOString(),
          trigger: input.trigger ?? 'user',
        }
        state.tutorStatus = 'working'
        delete state.learnerTurn
        delete state.tutorError
        if (message) addEvent(state, 'learner_feedback', { text: message })
        addEvent(state, 'tutor_busy', { requestId: input.requestId })
        return { requestId: input.requestId, evidenceId: message ? evidenceId : null }
      },
    )
  }

  private activeMilliseconds(value: number, servedAt: string): number {
    domainAssert(Number.isFinite(value) && value >= 0, 'INVALID_INPUT', '学习时间不合法')
    return Math.min(Math.floor(value), Math.max(0, Date.now() - Date.parse(servedAt)) + 1000, 4 * 3600000)
  }

  updateCurriculum(courseId: string, input: unknown, requestId: string, expectedRevision: number) {
    const raw = object(input)
    const state = this.repository.read(courseId)
    const skills = parseSkills(raw.skills, state.skills)
    for (const skill of skills) {
      const old = state.skills.find((item) => item.id === skill.id)
      if (old?.required)
        domainAssert(
          skill.required,
          'GOAL_REQUIREMENT_CHANGED',
          '已定义的必验目标不能自行改成可选，请先提出目标调整',
        )
      if (old && digest(old.criteria) !== digest(skill.criteria)) {
        domainAssert(
          !state.evidence.some((item) => item.kind === 'answer' && item.skillIds.includes(skill.id)),
          'RUBRIC_ALREADY_USED',
          '已有作答的技能不能覆盖量规，请使用新的技能标识保留原证据',
        )
      }
    }
    const reason = text(raw.reason, '课程调整依据', 1600)
    return this.repository.transact(courseId, { requestId, expectedRevision, input: raw }, (next) => {
      next.skills = skills
      addEvent(next, 'curriculum_updated', {
        skills: skills.map((item) => ({ id: item.id, title: item.title, unit: item.unit })),
        reason,
      })
      return { skills: skills.length, revision: next.revision + 1 }
    })
  }

  presentActivity(
    courseId: string,
    content: ActivityContent,
    requestId: string,
    expectedRevision: number,
    turnId: string,
  ) {
    const current = this.repository.read(courseId)
    const validated = parseActivity(content, current)
    const asset = this.repository.putAsset(courseId, validated)
    return this.repository.transact(courseId, { requestId, expectedRevision, input: { asset } }, (state) => {
      domainAssert(!state.pendingAnswer, 'PENDING_ANSWER', '仍有作答待评分', 409)
      const previous = this.activity(state)
      if (previous && previous.record.status === 'active') {
        if (validated.kind === 'explanation' && previous.content.questions[previous.record.index]) {
          const questionId = previous.content.questions[previous.record.index].id
          previous.record.assistance[questionId] = (previous.record.assistance[questionId] ?? 0) + 1
        }
        previous.record.status = 'paused'
      }
      const activityId = 'activity-' + randomUUID()
      const now = new Date().toISOString()
      const record: ActivityRecord = {
        id: activityId,
        asset,
        status: 'active',
        index: 0,
        answerIds: [],
        startedAt: now,
        servedAt: now,
        assistance: {},
        activeMs: 0,
        decisionId: turnId,
      }
      state.activities.push(record)
      state.currentActivityId = activityId
      state.learnerTurn = { kind: 'activity', at: now, day: this.day() }
      if (state.turns[turnId]) state.turns[turnId].yielded = true
      addEvent(state, 'activity_presented', {
        activityId,
        asset,
        title: validated.title,
        kind: validated.kind,
        rationale: validated.rationale,
      })
      if (validated.questions.length)
        addEvent(state, 'question_presented', {
          activityId,
          index: 0,
          question: publicQuestion(validated.questions[0]),
        })
      return { activityId }
    })
  }

  message(
    courseId: string,
    message: string,
    requestId: string,
    turnId: string,
    expectedRevision: number,
    reason: string,
    assistance = false,
  ) {
    const asset = this.repository.putAsset(courseId, { text: message })
    return this.repository.transact(
      courseId,
      { requestId, expectedRevision, input: { asset, reason } },
      (state) => {
        if (state.turns[turnId]) state.turns[turnId].yielded = true
        state.learnerTurn = assistance
          ? { kind: 'activity', at: new Date().toISOString(), day: this.day() }
          : { kind: 'reply', at: new Date().toISOString(), day: this.day(), promptAsset: asset, turnId }
        if (assistance) {
          const current = this.activity(state)
          const question = current?.content.questions[current.record.index]
          if (current && question)
            current.record.assistance[question.id] = (current.record.assistance[question.id] ?? 0) + 1
        }
        addEvent(state, 'tutor_message', { asset, reason })
        return { asset }
      },
    )
  }

  resumeActivity(
    courseId: string,
    activityId: string,
    requestId: string,
    expectedRevision: number,
    turnId: string,
  ) {
    return this.repository.transact(
      courseId,
      { requestId, expectedRevision, input: { activityId } },
      (state) => {
        const activity = this.activity(state, activityId)
        domainAssert(activity && activity.record.status === 'paused', 'INVALID_ACTIVITY', '活动不能恢复')
        const current = this.activity(state)
        if (current?.record.status === 'active') current.record.status = 'paused'
        activity.record.status = 'active'
        activity.record.servedAt = new Date().toISOString()
        state.currentActivityId = activityId
        state.learnerTurn = { kind: 'activity', at: new Date().toISOString(), day: this.day() }
        if (state.turns[turnId]) state.turns[turnId].yielded = true
        addEvent(state, 'activity_presented', {
          activityId,
          asset: activity.record.asset,
          title: activity.content.title,
          kind: activity.content.kind,
          resumed: true,
        })
        if (activity.content.questions[activity.record.index])
          addEvent(state, 'question_presented', {
            activityId,
            index: activity.record.index,
            question: publicQuestion(activity.content.questions[activity.record.index]),
          })
        return { activityId }
      },
    )
  }

  beginAnswer(
    courseId: string,
    input: {
      requestId: string
      activityId: string
      questionId: string
      contentHash: string
      answer: string
      expectedRevision?: number
      activeMs?: number
    },
  ) {
    const answer = text(input.answer, '作答', 50000)
    const answerAsset = this.repository.putAsset(courseId, { answer, activeMs: input.activeMs ?? 0 })
    return this.repository.transact(
      courseId,
      {
        requestId: 'begin:' + input.requestId,
        expectedRevision: input.expectedRevision,
        input: {
          activityId: input.activityId,
          questionId: input.questionId,
          contentHash: input.contentHash,
          answer,
        },
      },
      (state) => {
        const active = this.activity(state)
        domainAssert(
          active &&
            active.record.status === 'active' &&
            active.record.id === input.activityId &&
            active.record.asset === input.contentHash,
          'STALE_ACTIVITY',
          '题目或活动已经变化，请刷新后继续',
          409,
        )
        const question = active.content.questions[active.record.index]
        domainAssert(
          question && question.id === input.questionId,
          'STALE_QUESTION',
          '该题已经提交或题目已变化',
          409,
        )
        domainAssert(
          state.learnerTurn?.kind !== 'reply',
          'REPLY_REQUIRED',
          '导师正在等待你的回复，请先回答当前问题',
          409,
        )
        domainAssert(!state.pendingAnswer, 'PENDING_ANSWER', '已有作答正在评分', 409)
        state.pendingAnswer = {
          requestId: input.requestId,
          activityId: input.activityId,
          questionId: input.questionId,
          questionHash: questionHash(question),
          inputHash: digest(answer),
          asset: answerAsset,
          activeMs: this.activeMilliseconds(input.activeMs ?? 0, active.record.servedAt),
          startedAt: new Date().toISOString(),
        }
        state.tutorStatus = 'working'
        delete state.learnerTurn
        addEvent(state, 'answer_evaluating', {
          requestId: input.requestId,
          activityId: input.activityId,
          questionId: input.questionId,
        })
        return { requestId: input.requestId }
      },
    )
  }

  saveDraft(
    courseId: string,
    input: { activityId: string; questionId: string; answer: string; draftVersion?: number },
  ) {
    const state = this.repository.read(courseId)
    const activity = this.activity(state, input.activityId)
    domainAssert(
      activity && activity.content.questions[activity.record.index]?.id === input.questionId,
      'STALE_QUESTION',
      '当前题目已经变化',
      409,
    )
    return this.repository.saveDraft(
      courseId,
      input.activityId,
      input.questionId,
      text(input.answer, '作答草稿', 50000, true),
      input.draftVersion,
    )
  }

  commitAnswer(courseId: string, requestId: string, grade: Grade) {
    const before = this.repository.read(courseId)
    const pending = before.pendingAnswer
    const prior = before.receipts['answer:' + requestId]
    if (prior) return { state: before, result: prior.result as { evidenceId: string }, duplicate: true }
    domainAssert(pending?.requestId === requestId, 'INVALID_ANSWER', '没有对应的待评分作答', 409)
    const active = this.activity(before, pending.activityId)!
    const question = active.content.questions[active.record.index]
    domainAssert(
      Number.isFinite(grade.score) &&
        grade.score >= 0 &&
        grade.score <= 1 &&
        typeof grade.correct === 'boolean' &&
        grade.criteria.every((item) => typeof item.met === 'boolean') &&
        grade.correct === grade.criteria.every((item) => item.met),
      'INVALID_GRADE',
      '评分结果的分数或达标结论不一致',
      500,
    )
    domainAssert(
      question && question.id === pending.questionId && questionHash(question) === pending.questionHash,
      'STALE_QUESTION',
      '评分期间题目发生变化',
      409,
    )
    domainAssert(
      grade.criteria.length === question.criterionIds.length &&
        new Set(grade.criteria.map((item) => item.id)).size === grade.criteria.length &&
        grade.criteria.every((item) => question.criterionIds.includes(item.id)),
      'INVALID_GRADE',
      '评分必须准确覆盖本题量规',
      500,
    )
    const raw = this.repository.asset<{ answer: string }>(courseId, pending.asset)
    const evidenceAsset = this.repository.putAsset(courseId, {
      answer: raw.answer,
      question,
      grade,
      activeMs: pending.activeMs,
    })
    return this.repository.transact(
      courseId,
      {
        requestId: 'answer:' + requestId,
        expectedRevision: before.revision,
        input: { inputHash: pending.inputHash },
      },
      (state) => {
        const record = state.activities.find((item) => item.id === pending.activityId)!
        const hash = pending.questionHash
        const fingerprint = problemFingerprint(question)
        const assessedSkillIds = state.skills
          .filter((skill) => skill.criteria.some((criterion) => question.criterionIds.includes(criterion.id)))
          .map((skill) => skill.id)
        const exposureCount = state.activities.filter((item) => {
          const content = this.repository.asset<ActivityContent>(courseId, item.asset)
          return content.questions
            .slice(0, item.index + 1)
            .some((item) => problemFingerprint(item) === fingerprint)
        }).length
        const assisted = (record.assistance[question.id] ?? 0) > 0
        const evidenceId = 'evidence-' + randomUUID()
        const at = new Date().toISOString()
        const evidence: Evidence = {
          id: evidenceId,
          kind: 'answer',
          activityId: record.id,
          questionId: question.id,
          questionHash: hash,
          problemFingerprint: fingerprint,
          contentHash: record.asset,
          asset: evidenceAsset,
          skillIds: assessedSkillIds,
          questionType: question.type,
          dimension: question.dimension,
          difficulty: question.difficulty,
          at,
          independent:
            ['assessment', 'transfer'].includes(active.content.kind) && !assisted && exposureCount === 1,
          assisted,
          exposureCount,
          grade,
        }
        state.evidence.push(evidence)
        record.answerIds.push(evidenceId)
        record.index += 1
        record.activeMs += pending.activeMs
        state.activeMs += pending.activeMs
        state.dailyActiveMs ??= {}
        state.dailyActiveMs[this.day()] = (state.dailyActiveMs[this.day()] ?? 0) + pending.activeMs
        record.servedAt = at
        for (const skillId of assessedSkillIds) {
          state.memory[skillId] = updateMemory(state.memory[skillId], grade.score, this.day())
          const skill = state.skills.find((item) => item.id === skillId)!
          if (
            state.judgments[skillId]?.status === 'supported' &&
            !competencyEligibility(state, skill).eligible
          ) {
            state.judgments[skillId] = {
              skillId,
              status: 'needs_evidence',
              evidenceIds: [evidenceId],
              reason: '出现新的冲突证据，保留历史成绩并等待进一步验证',
              at,
            }
          }
        }
        delete state.pendingAnswer
        state.tutorStatus = 'idle'
        delete state.tutorError
        addEvent(state, 'answer_graded', {
          activityId: record.id,
          questionId: question.id,
          evidenceId,
          answer: raw.answer,
          grade,
          independent: evidence.independent,
        })
        if (record.index >= active.content.questions.length) {
          record.status = 'completed'
          record.completedAt = at
          delete state.currentActivityId
          addEvent(state, 'activity_completed', { activityId: record.id, title: active.content.title })
        } else
          addEvent(state, 'question_presented', {
            activityId: record.id,
            index: record.index,
            question: publicQuestion(active.content.questions[record.index]),
          })
        return { evidenceId }
      },
    )
  }

  recordHypothesis(courseId: string, value: unknown, requestId: string, expectedRevision: number) {
    const raw = object(value)
    const evidenceIds = strings(raw.evidenceIds, '证据', 30)
    const description = text(raw.description, '画像假设', 1200)
    const nextCheck = text(raw.nextCheck, '验证方式', 1200)
    return this.repository.transact(courseId, { requestId, expectedRevision, input: raw }, (state) => {
      domainAssert(
        evidenceIds.length > 0 &&
          evidenceIds.every((item) => state.evidence.some((evidence) => evidence.id === item)),
        'INVALID_EVIDENCE',
        '画像推断必须引用已记录的作答或用户反馈',
      )
      const hypothesisId = 'hypothesis-' + randomUUID()
      state.hypotheses.push({
        id: hypothesisId,
        description,
        evidenceIds,
        nextCheck,
        status: 'tentative',
        at: new Date().toISOString(),
      })
      addEvent(state, 'hypothesis_updated', { id: hypothesisId, description, nextCheck })
      return { hypothesisId }
    })
  }

  recordJudgment(courseId: string, value: unknown, requestId: string, expectedRevision: number) {
    const raw = object(value)
    const skillId = id(raw.skillId)
    const status = raw.status as CompetencyStatus
    domainAssert(
      ['needs_evidence', 'developing', 'supported'].includes(status),
      'INVALID_INPUT',
      '能力评定状态不合法',
    )
    const reason = text(raw.reason, '评定依据', 1600)
    return this.repository.transact(courseId, { requestId, expectedRevision, input: raw }, (state) => {
      const skill = state.skills.find((item) => item.id === skillId)
      domainAssert(skill, 'UNKNOWN_SKILL', '技能不存在')
      const eligibility = competencyEligibility(state, skill)
      const evidenceIds = strings(raw.evidenceIds, '评定证据', 40)
      domainAssert(
        evidenceIds.length > 0 &&
          evidenceIds.every((item) =>
            state.evidence.some(
              (evidence) =>
                evidence.id === item && evidence.kind === 'answer' && evidence.skillIds.includes(skillId),
            ),
          ),
        'INVALID_EVIDENCE',
        '能力评定必须引用该技能的实测证据',
      )
      if (status === 'supported')
        domainAssert(eligibility.eligible, 'INSUFFICIENT_EVIDENCE', eligibility.reasons.join('；'))
      state.judgments[skillId] = { skillId, status, evidenceIds, reason, at: new Date().toISOString() }
      addEvent(state, 'judgment_recorded', { skillId, status, reason })
      return { skillId, status, goalSupported: goalSupported(state) }
    })
  }

  recordLearningUpdate(courseId: string, value: unknown, requestId: string, expectedRevision: number) {
    const raw = object(value)
    const hypotheses = raw.hypotheses ?? []
    const judgments = raw.judgments ?? []
    domainAssert(
      Array.isArray(hypotheses) &&
        hypotheses.length <= 8 &&
        Array.isArray(judgments) &&
        judgments.length <= 12,
      'INVALID_INPUT',
      '学习判断的数量超出单次更新范围',
    )
    domainAssert(hypotheses.length + judgments.length > 0, 'INVALID_INPUT', '学习判断不能为空')
    return this.repository.transact(courseId, { requestId, expectedRevision, input: raw }, (state) => {
      const hypothesisIds: string[] = []
      for (const value of hypotheses) {
        const hypothesis = object(value)
        const evidenceIds = strings(hypothesis.evidenceIds, '假设证据', 30)
        domainAssert(
          evidenceIds.length > 0 && evidenceIds.every((id) => state.evidence.some((item) => item.id === id)),
          'INVALID_EVIDENCE',
          '画像推断必须引用真实作答或反馈',
        )
        const id = 'hypothesis-' + randomUUID()
        const description = text(hypothesis.description, '画像假设', 1200)
        const nextCheck = text(hypothesis.nextCheck, '验证方式', 1200)
        state.hypotheses.push({
          id,
          description,
          nextCheck,
          evidenceIds,
          status: 'tentative',
          at: new Date().toISOString(),
        })
        hypothesisIds.push(id)
        addEvent(state, 'hypothesis_updated', { id, description, nextCheck })
      }
      const updated: { skillId: string; status: CompetencyStatus }[] = []
      for (const value of judgments) {
        const judgment = object(value)
        const skillId = id(judgment.skillId)
        const skill = state.skills.find((item) => item.id === skillId)
        domainAssert(skill, 'UNKNOWN_SKILL', '技能不存在')
        const status = judgment.status as CompetencyStatus
        domainAssert(
          ['needs_evidence', 'developing', 'supported'].includes(status),
          'INVALID_INPUT',
          '评定状态不合法',
        )
        const evidenceIds = strings(judgment.evidenceIds, '评定证据', 40)
        domainAssert(
          evidenceIds.length > 0 &&
            evidenceIds.every((id) =>
              state.evidence.some(
                (item) => item.id === id && item.kind === 'answer' && item.skillIds.includes(skillId),
              ),
            ),
          'INVALID_EVIDENCE',
          '评定需要对应技能的实测证据',
        )
        if (status === 'supported') {
          const eligibility = competencyEligibility(state, skill)
          domainAssert(eligibility.eligible, 'INSUFFICIENT_EVIDENCE', eligibility.reasons.join('；'))
        }
        const reason = text(judgment.reason, '评定依据', 1600)
        state.judgments[skillId] = { skillId, status, reason, evidenceIds, at: new Date().toISOString() }
        updated.push({ skillId, status })
        addEvent(state, 'judgment_recorded', { skillId, status, reason })
      }
      return { hypothesisIds, judgments: updated, goalSupported: goalSupported(state) }
    })
  }

  proposeGoal(courseId: string, value: unknown, requestId: string, expectedRevision: number) {
    const raw = object(value)
    const goal = parseGoal(raw.goal)
    const explanation = text(raw.explanation, '调整说明', 1600)
    return this.repository.transact(courseId, { requestId, expectedRevision, input: raw }, (state) => {
      const proposalId = 'proposal-' + randomUUID()
      state.proposals.push({
        id: proposalId,
        goal,
        explanation,
        status: 'pending',
        at: new Date().toISOString(),
      })
      addEvent(state, 'goal_proposed', { proposalId, goal, explanation })
      return { proposalId, requiresUserChoice: true }
    })
  }

  resolveGoal(
    courseId: string,
    proposalId: string,
    accept: boolean,
    requestId: string,
    expectedRevision: number,
  ) {
    return this.repository.transact(
      courseId,
      { requestId, expectedRevision, input: { proposalId, accept } },
      (state) => {
        const proposal = state.proposals.find((item) => item.id === proposalId)
        domainAssert(proposal?.status === 'pending', 'INVALID_PROPOSAL', '目标建议已处理或不存在')
        proposal.status = accept ? 'accepted' : 'rejected'
        if (accept) {
          state.goal = {
            ...proposal.goal,
            requests: [...state.goal.requests, '接受目标调整：' + proposal.goal.text],
          }
          state.skills = state.skills.map((skill) => ({ ...skill, required: false }))
          const current = this.activity(state)
          if (current?.record.status === 'active') current.record.status = 'paused'
          delete state.goalCoverage
          delete state.nextSuggestion
          delete state.learnerTurn
          addEvent(state, 'goal_updated', { goal: state.goal, explanation: proposal.explanation })
        }
        return { accepted: accept }
      },
    )
  }

  pause(courseId: string, requestId: string) {
    return this.repository.transact(courseId, { requestId, input: { pause: true } }, (state) => {
      const active = this.activity(state)
      if (active && active.record.status === 'active') active.record.status = 'paused'
      state.tutorStatus = 'paused'
      addEvent(state, 'session_paused', { activityId: active?.record.id ?? null })
      return { paused: true }
    })
  }

  finishTurn(
    courseId: string,
    turnId: string,
    options: { error?: string; paused?: boolean; usage?: ModelUsageEntry[] } = {},
  ) {
    return this.repository.transact(
      courseId,
      { requestId: 'finish:' + turnId + ':' + randomUUID(), input: options },
      (state) => {
        const turn = state.turns[turnId]
        if (turn) {
          turn.status = options.error ? 'failed' : options.paused && !turn.yielded ? 'pending' : 'completed'
          if (options.error) turn.error = options.error
        }
        state.tutorStatus = options.paused ? 'paused' : options.error ? 'failed' : 'idle'
        if (options.error) state.tutorError = options.error
        else delete state.tutorError
        for (const entry of options.usage ?? [])
          if (!state.usage.some((item) => item.id === entry.id)) state.usage.push(entry)
        addEvent(state, options.error ? 'tutor_failed' : 'tutor_ready', {
          error: options.error ?? null,
          paused: options.paused ?? false,
        })
        return { status: state.tutorStatus }
      },
    )
  }

  saveDecision(
    courseId: string,
    input: { turnId: string; intent: LearningIntent; action: string; reason: string; evidenceIds?: string[] },
    requestId: string,
    expectedRevision: number,
  ) {
    return this.repository.transact(courseId, { requestId, expectedRevision, input }, (state) => {
      const decision = {
        id: 'decision-' + randomUUID(),
        basedOnRevision: expectedRevision,
        intent: input.intent,
        action: input.action,
        reason: input.reason,
        evidenceIds: input.evidenceIds ?? [],
        at: new Date().toISOString(),
        status: 'proposed' as const,
      }
      domainAssert(
        decision.evidenceIds.every((item) => state.evidence.some((evidence) => evidence.id === item)),
        'INVALID_EVIDENCE',
        '决策引用了不存在的证据',
      )
      state.decisions.push(decision)
      addEvent(state, 'decision_recorded', { decision })
      return { decisionId: decision.id }
    })
  }
}
