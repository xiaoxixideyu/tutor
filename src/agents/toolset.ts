import { randomUUID } from 'node:crypto'
import { domainAssert, DomainError, type LearningIntent } from '../domain/model.ts'
import { date, digest, object, strings, text } from '../domain/validation.ts'
import { goalSupported } from '../domain/evidence.ts'
import { addEvent, CourseService } from '../application/course-service.ts'
import type { ApiToolDef } from '../runtime/llm.ts'
import type { RuntimeToolset, RuntimeToolResult } from '../runtime/agent-tools.ts'
import { ModelBudgetError, ModelRequestError } from '../runtime/chat.ts'
import { TeachingCapabilities } from '../capabilities/teaching.ts'

const string = { type: 'string' }
const stringArray = { type: 'array', items: string }
const criterion = {
  type: 'object',
  properties: { id: string, description: string, critical: { type: 'boolean' } },
  required: ['id', 'description', 'critical'],
  additionalProperties: false,
}
const skill = {
  type: 'object',
  properties: {
    id: string,
    title: string,
    description: string,
    unit: string,
    prerequisites: stringArray,
    related: stringArray,
    criteria: { type: 'array', items: criterion },
    evidencePolicy: {
      type: 'object',
      properties: {
        independentSamples: { type: 'integer', minimum: 1, maximum: 5 },
        requireApplication: { type: 'boolean' },
      },
      required: ['independentSamples', 'requireApplication'],
      additionalProperties: false,
    },
    required: { type: 'boolean' },
  },
  required: ['id', 'title', 'description', 'unit', 'criteria', 'evidencePolicy', 'required'],
  additionalProperties: false,
}
const question = {
  type: 'object',
  properties: {
    id: string,
    type: { type: 'string', enum: ['choice', 'numeric', 'open', 'code'] },
    prompt: string,
    answer: string,
    choices: stringArray,
    accept: stringArray,
    criterionIds: stringArray,
    dimension: { type: 'string', enum: ['recognition', 'application'] },
    difficulty: { type: 'integer', minimum: 1, maximum: 3 },
    language: { type: 'string', enum: ['javascript', 'python', 'go'] },
    starterCode: string,
    tests: {
      type: 'array',
      items: {
        type: 'object',
        properties: { input: string, output: string },
        required: ['input', 'output'],
        additionalProperties: false,
      },
    },
  },
  required: ['id', 'type', 'prompt', 'answer', 'criterionIds', 'dimension', 'difficulty'],
  additionalProperties: false,
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): ApiToolDef {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  }
}

export const TUTOR_TOOLS: ApiToolDef[] = [
  tool(
    'record_learning_update',
    '一次记录当前学习诊断与多个技能评定，全部引用真实证据并原子提交。优先使用它，保留步骤用于下一活动或内容修复。',
    {
      hypotheses: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: { description: string, nextCheck: string, evidenceIds: stringArray },
          required: ['description', 'nextCheck', 'evidenceIds'],
          additionalProperties: false,
        },
      },
      judgments: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            skillId: string,
            status: { type: 'string', enum: ['needs_evidence', 'developing', 'supported'] },
            evidenceIds: stringArray,
            reason: string,
          },
          required: ['skillId', 'status', 'evidenceIds', 'reason'],
          additionalProperties: false,
        },
      },
      reason: string,
    },
  ),
  tool(
    'inspect_learning_state',
    '读取精简的目标、证据、画像与活动。初始消息已经包含，不要重复读取。',
    {},
    [],
  ),
  tool(
    'update_curriculum',
    '在原目标内增加或细化近期技能。需可观察标准，不删除已有证据、不降低已定义要求。',
    {
      skills: { type: 'array', items: skill, minItems: 1, maxItems: 24 },
      reason: string,
    },
  ),
  tool('present_activity', '展示已核对的教学活动并交回学员。用于讲解、诊断、练习、独立测评、回忆和迁移。', {
    kind: {
      type: 'string',
      enum: ['explanation', 'diagnostic', 'practice', 'assessment', 'recall', 'transfer'],
    },
    title: string,
    body: string,
    skillIds: stringArray,
    questions: { type: 'array', items: question, maxItems: 10 },
    sourceIds: stringArray,
    rationale: string,
  }),
  tool('ask_learner', '只澄清目标、基础和偏好，然后交回学员。对题目提供帮助应使用 give_hint。', {
    question: string,
    reason: string,
  }),
  tool('give_hint', '为当前题提供思路或提示，记录帮助后交回学员；该题不再计为独立证据。', {
    hint: string,
    reason: string,
  }),
  tool('resume_activity', '恢复已经暂停的活动和未完成题目，交回学员。', {
    activityId: string,
    reason: string,
  }),
  tool(
    'continue_activity',
    '依据最新作答，继续已准备活动的下一题，交回学员。需要换策略时可改用其他教学能力。',
    {
      reason: string,
    },
  ),
  tool('record_hypothesis', '依据真实作答或反馈记录待验证的能力缺口、误解或偏好假设。', {
    description: string,
    evidenceIds: stringArray,
    nextCheck: string,
    reason: string,
  }),
  tool('resolve_hypothesis', '用新的验证证据确认原因或标记已解决，保留原观察记录。', {
    hypothesisId: string,
    evidenceIds: stringArray,
    status: { type: 'string', enum: ['confirmed', 'resolved'] },
    reason: string,
  }),
  tool('record_judgment', '依据已有实测证据记录技能评定。supported 要满足独立样本、关键标准和应用要求。', {
    skillId: string,
    status: { type: 'string', enum: ['needs_evidence', 'developing', 'supported'] },
    evidenceIds: stringArray,
    reason: string,
  }),
  tool('update_learner', '根据学员原话更新自述背景与学习偏好，不能作为掌握证明。', {
    background: string,
    preferences: stringArray,
    evidenceIds: stringArray,
    reason: string,
  }),
  tool('plan_review', '结合记忆参考、目标、可用时间安排复习。复习顺序不是固定优先级。', {
    skillIds: stringArray,
    date: string,
    reason: string,
  }),
  tool('propose_goal', '期限不可行或需要改变目标时提出建议，由用户选择是否接受，然后交回用户。', {
    goal: {
      type: 'object',
      properties: {
        text: string,
        exclusions: stringArray,
        deadline: string,
        dailyMinutes: { type: 'integer', minimum: 5, maximum: 600 },
        priority: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['text', 'exclusions', 'dailyMinutes', 'priority'],
      additionalProperties: false,
    },
    explanation: string,
    reason: string,
  }),
  tool(
    'verify_goal_coverage',
    '独立核对当前技能与验收标准是否覆盖完整用户目标。近期局部安排不能冒充课程完成。',
    {
      reason: string,
    },
  ),
  tool(
    'fetch_source',
    '读取并保存真实资料正文。只允许公共 HTTP/HTTPS 来源。',
    { url: string, title: string, refresh: { type: 'boolean' }, reason: string },
    ['url', 'title', 'reason'],
  ),
  tool('research_topic', '使用受限搜索取得与当前目标有关的一手资料，保存可核对正文。', {
    query: string,
    reason: string,
  }),
  tool('repair_content', '按独立审查意见实际修复失败任务，再核对新版本。', {
    taskId: string,
    reason: string,
  }),
  tool(
    'finish_session',
    '结束或暂停本次学习，给出明确的下次行动。goal_met 必须已验证完整目标。',
    {
      outcome: { type: 'string', enum: ['session_complete', 'time_up', 'paused', 'goal_met'] },
      reason: string,
      nextLabel: string,
      nextIntent: {
        type: 'string',
        enum: ['learn', 'review', 'practice', 'assess', 'exam', 'research', 'repair'],
      },
      nextDate: string,
    },
    ['outcome', 'reason', 'nextLabel', 'nextIntent'],
  ),
]

export class TutorToolset implements RuntimeToolset {
  readonly service: CourseService
  readonly capabilities: TeachingCapabilities
  readonly courseId: string
  readonly turnId: string
  readonly intent: LearningIntent
  revision: number
  yielded = false
  paused = false

  constructor(
    service: CourseService,
    capabilities: TeachingCapabilities,
    context: {
      courseId: string
      turnId: string
      intent: LearningIntent
      revision: number
    },
  ) {
    this.service = service
    this.capabilities = capabilities
    this.courseId = context.courseId
    this.turnId = context.turnId
    this.intent = context.intent
    this.revision = context.revision
  }

  async definitions(): Promise<ApiToolDef[]> {
    return TUTOR_TOOLS
  }

  async call(
    name: string,
    argumentsText: string,
    signal: AbortSignal,
    callId: string,
  ): Promise<RuntimeToolResult> {
    if (this.yielded)
      return {
        text: JSON.stringify({ error: 'TURN_YIELDED', message: '本回合已交回用户' }),
        isError: true,
        yield: true,
      }
    let decisionId: string | undefined
    try {
      signal.throwIfAborted()
      domainAssert(
        TUTOR_TOOLS.some((tool) => tool.name === name),
        'UNKNOWN_TOOL',
        '未注册的教学能力',
      )
      let parsed: unknown
      try {
        parsed = JSON.parse(argumentsText || '{}')
      } catch {
        throw new DomainError('INVALID_INPUT', '工具参数须为完整 JSON 对象')
      }
      const raw = object(parsed)
      const state = this.service.repository.read(this.courseId)
      domainAssert(
        state.revision === this.revision,
        'STALE_REVISION',
        '学习状态已变化，请重新观察当前状态',
        409,
      )
      const requestId = this.turnId + ':' + (callId || randomUUID())
      if (name !== 'inspect_learning_state') {
        const reason = text(raw.reason ?? raw.rationale, '教学决策依据', 1600)
        const decision = this.service.saveDecision(
          this.courseId,
          {
            turnId: this.turnId,
            intent: this.intent,
            action: name,
            reason,
            evidenceIds: strings(raw.evidenceIds, '决策证据', 40),
          },
          'decision:' + requestId,
          this.revision,
        )
        decisionId = decision.result.decisionId
        this.revision = decision.state.revision
      }
      const result = await this.execute(name, raw, requestId, signal)
      this.revision = this.service.repository.read(this.courseId).revision
      if (decisionId) {
        const completed = this.service.repository.transact(
          this.courseId,
          {
            requestId: 'decision-done:' + requestId,
            expectedRevision: this.revision,
            input: { decisionId, status: 'executed' },
          },
          (next) => {
            next.decisions.find((item) => item.id === decisionId)!.status = 'executed'
            return { decisionId }
          },
        )
        this.revision = completed.state.revision
      }
      return { text: JSON.stringify(result), isError: false, ...(this.yielded ? { yield: true } : {}) }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ModelBudgetError || error instanceof ModelRequestError) throw error
      this.revision = this.service.repository.read(this.courseId).revision
      if (decisionId) {
        const rejected = this.service.repository.transact(
          this.courseId,
          { requestId: 'decision-rejected:' + decisionId, input: { decisionId } },
          (next) => {
            next.decisions.find((item) => item.id === decisionId)!.status = 'rejected'
            return { decisionId }
          },
        )
        this.revision = rejected.state.revision
      }
      return {
        text: JSON.stringify({
          error: error instanceof DomainError ? error.code : 'CAPABILITY_FAILED',
          message: this.capabilities.model.error(error),
          revision: this.revision,
          taskId: (error as { taskId?: string }).taskId,
        }),
        isError: true,
      }
    }
  }

  private async execute(
    name: string,
    raw: Record<string, unknown>,
    requestId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const state = this.service.repository.read(this.courseId)
    switch (name) {
      case 'record_learning_update':
        return this.service.recordLearningUpdate(this.courseId, raw, requestId, this.revision).result
      case 'inspect_learning_state':
        return this.service.observation(this.courseId)
      case 'update_curriculum': {
        const input = await this.capabilities.prepareCurriculum(state, raw, signal)
        return this.service.updateCurriculum(this.courseId, input, requestId, this.revision).result
      }
      case 'present_activity': {
        const content = await this.capabilities.prepareActivity(state, raw, signal)
        const result = this.service.presentActivity(
          this.courseId,
          content,
          requestId,
          this.revision,
          this.turnId,
        ).result
        this.yielded = true
        return result
      }
      case 'ask_learner': {
        const question = text(raw.question, '导师回复', 6000)
        // 询问与提示也核对目标范围；不依赖文字解析驱动业务状态。
        await this.capabilities.validation.message(state, question, 'clarification')
        signal.throwIfAborted()
        const result = this.service.message(
          this.courseId,
          question,
          requestId,
          this.turnId,
          this.revision,
          text(raw.reason, '依据', 1600),
        ).result
        this.yielded = true
        return result
      }
      case 'give_hint': {
        const hint = text(raw.hint, '提示', 8000)
        await this.capabilities.validation.message(state, hint, 'hint')
        signal.throwIfAborted()
        const result = this.service.message(
          this.courseId,
          hint,
          requestId,
          this.turnId,
          this.revision,
          text(raw.reason, '提示依据', 1600),
          true,
        ).result
        this.yielded = true
        return result
      }
      case 'resume_activity': {
        const activityId = text(raw.activityId, '活动标识', 100)
        const active = this.service.activity(state, activityId)
        domainAssert(active, 'INVALID_ACTIVITY', '恢复的活动不存在')
        await this.capabilities.validation.activity(state, active.content)
        signal.throwIfAborted()
        const result = this.service.resumeActivity(
          this.courseId,
          activityId,
          requestId,
          this.revision,
          this.turnId,
        ).result
        this.yielded = true
        return result
      }
      case 'record_hypothesis':
        return this.service.recordHypothesis(this.courseId, raw, requestId, this.revision).result
      case 'resolve_hypothesis':
        return this.service.repository.transact(
          this.courseId,
          { requestId, expectedRevision: this.revision, input: raw },
          (next) => {
            const hypothesis = next.hypotheses.find((item) => item.id === raw.hypothesisId)
            domainAssert(hypothesis, 'UNKNOWN_HYPOTHESIS', '观察记录不存在')
            const evidenceIds = strings(raw.evidenceIds, '验证证据', 30)
            domainAssert(
              ['confirmed', 'resolved'].includes(raw.status as string),
              'INVALID_INPUT',
              '观察状态不合法',
            )
            domainAssert(
              evidenceIds.length > 0 &&
                evidenceIds.every((id) => next.evidence.some((item) => item.id === id)) &&
                evidenceIds.some((id) => !hypothesis.evidenceIds.includes(id)),
              'INVALID_EVIDENCE',
              '需要新的真实证据验证观察',
            )
            hypothesis.status = raw.status as 'confirmed' | 'resolved'
            hypothesis.evidenceIds = [...new Set([...hypothesis.evidenceIds, ...evidenceIds])]
            addEvent(next, 'hypothesis_updated', {
              id: hypothesis.id,
              status: hypothesis.status,
              description: hypothesis.description,
              reason: raw.reason,
            })
            return { hypothesisId: hypothesis.id, status: hypothesis.status }
          },
        ).result
      case 'continue_activity': {
        const current = this.service.activity(state)
        domainAssert(
          current && current.record.status === 'active' && current.content.questions[current.record.index],
          'INVALID_ACTIVITY',
          '没有可继续的题目',
        )
        await this.capabilities.validation.activity(state, current.content)
        signal.throwIfAborted()
        this.markYielded(requestId, true)
        this.yielded = true
        return { activityId: current.record.id, index: current.record.index }
      }
      case 'record_judgment':
        return this.service.recordJudgment(this.courseId, raw, requestId, this.revision).result
      case 'update_learner': {
        const cited = strings(raw.evidenceIds, '画像依据', 30)
        domainAssert(
          cited.length > 0 &&
            cited.every((id) => state.evidence.some((item) => item.id === id && item.kind === 'feedback')),
          'INVALID_EVIDENCE',
          '背景和偏好需引用学员原话',
        )
        await this.capabilities.validation.review(state, 'message', {
          purpose: 'profile_update',
          background: raw.background,
          preferences: raw.preferences,
          original: cited.map((id) =>
            this.service.repository.asset(
              this.courseId,
              state.evidence.find((item) => item.id === id)!.asset,
            ),
          ),
        })
        signal.throwIfAborted()
        return this.service.repository.transact(
          this.courseId,
          { requestId, expectedRevision: this.revision, input: raw },
          (next) => {
            const evidenceIds = strings(raw.evidenceIds, '画像依据', 30)
            domainAssert(
              evidenceIds.length > 0 &&
                evidenceIds.every((item) =>
                  next.evidence.some((evidence) => evidence.id === item && evidence.kind === 'feedback'),
                ),
              'INVALID_EVIDENCE',
              '背景和偏好需引用学员原话',
            )
            next.learner = {
              background: text(raw.background, '自述背景', 4000, true),
              preferences: strings(raw.preferences, '偏好', 12),
            }
            return { learner: next.learner }
          },
        ).result
      }
      case 'plan_review':
        return this.service.repository.transact(
          this.courseId,
          { requestId, expectedRevision: this.revision, input: raw },
          (next) => {
            const skillIds = strings(raw.skillIds, '复习目标', 20)
            domainAssert(
              skillIds.length > 0 && skillIds.every((item) => next.skills.some((skill) => skill.id === item)),
              'UNKNOWN_SKILL',
              '复习目标不合法',
            )
            const day = date(raw.date, '复习日期')
            domainAssert(day, 'INVALID_INPUT', '需提供复习日期')
            next.reviewPlan = [
              ...(next.reviewPlan ?? []).filter(
                (item) => !item.skillIds.some((skill) => skillIds.includes(skill)),
              ),
              { skillIds, date: day, reason: text(raw.reason, '复习依据', 1200) },
            ]
            return { planned: skillIds, date: day }
          },
        ).result
      case 'propose_goal': {
        const result = this.service.proposeGoal(this.courseId, raw, requestId, this.revision).result
        this.markYielded(requestId)
        this.yielded = true
        return result
      }
      case 'verify_goal_coverage': {
        const result = await this.capabilities.model.json(
          '核对整体学习目标',
          '独立核对技能及量规是否完整覆盖用户原始目标和排除项。只有近期局部安排时必须 complete=false。' +
            '不能把目标缩写为当前技能的子集，不把选择题能力当作独立应用。只输出 JSON：{"complete":true,"reason":"具体覆盖或缺失依据"}',
          { goal: state.goal, skills: state.skills },
          (value) => {
            const raw = object(value)
            domainAssert(typeof raw.complete === 'boolean', 'INVALID_MODEL_OUTPUT', '目标覆盖核查结果不合法')
            return { complete: raw.complete, reason: text(raw.reason, '覆盖依据', 2400) }
          },
        )
        signal.throwIfAborted()
        return this.service.repository.transact(
          this.courseId,
          { requestId, expectedRevision: this.revision, input: result },
          (next) => {
            next.goalCoverage = { goalHash: digest(next.goal), skillsHash: digest(next.skills), ...result }
            return result
          },
        ).result
      }
      case 'fetch_source':
        return this.capabilities.fetchSource(state, raw, signal)
      case 'research_topic':
        return this.capabilities.research(state, text(raw.query, '检索问题', 2000), signal)
      case 'repair_content': {
        const repaired = await this.capabilities.repair(state, text(raw.taskId, '失败任务标识', 64), signal)
        if (repaired.kind === 'curriculum')
          return this.service.updateCurriculum(this.courseId, repaired.content, requestId, this.revision)
            .result
        const result = this.service.presentActivity(
          this.courseId,
          repaired.content as import('../domain/model.ts').ActivityContent,
          requestId,
          this.revision,
          this.turnId,
        ).result
        this.yielded = true
        return result
      }
      case 'finish_session': {
        const outcome = text(raw.outcome, '结束方式', 40)
        domainAssert(
          ['session_complete', 'time_up', 'paused', 'goal_met'].includes(outcome),
          'INVALID_INPUT',
          '结束方式不合法',
        )
        if (outcome === 'goal_met')
          domainAssert(goalSupported(state), 'INSUFFICIENT_EVIDENCE', '尚未通过完整目标覆盖和能力证据检验')
        domainAssert(
          ['learn', 'review', 'practice', 'assess', 'exam', 'research', 'repair'].includes(
            raw.nextIntent as string,
          ),
          'INVALID_INPUT',
          '下次行动类型不合法',
        )
        const result = this.service.repository.transact(
          this.courseId,
          { requestId, expectedRevision: this.revision, input: raw },
          (next) => {
            const active = this.service.activity(next)
            if (active?.record.status === 'active') active.record.status = 'paused'
            if (next.turns[this.turnId]) next.turns[this.turnId].yielded = true
            next.learnerTurn = { kind: 'complete', at: new Date().toISOString(), day: this.service.today() }
            next.nextSuggestion = {
              label: text(raw.nextLabel, '下次行动', 300),
              reason: text(raw.reason, '安排依据', 1600),
              intent: raw.nextIntent as LearningIntent,
              basedOnRevision: next.revision + 1,
              date: date(raw.nextDate, '下次学习日期') ?? this.service.today(),
            }
            addEvent(next, 'tutor_message', {
              asset: this.service.repository.putAsset(this.courseId, {
                text:
                  text(raw.reason, '本次结果', 1600) + '\n下一步：' + text(raw.nextLabel, '下次行动', 300),
              }),
              outcome,
            })
            return { outcome, goalSupported: goalSupported(next) }
          },
        ).result
        this.yielded = true
        this.paused = outcome === 'paused' || outcome === 'time_up'
        return result
      }
      default:
        throw new DomainError('UNKNOWN_TOOL', '未注册的业务能力')
    }
  }

  private markYielded(requestId: string, activity = false): void {
    const result = this.service.repository.transact(
      this.courseId,
      { requestId: 'yield:' + requestId, input: { turnId: this.turnId } },
      (state) => {
        if (state.turns[this.turnId]) state.turns[this.turnId].yielded = true
        if (activity)
          state.learnerTurn = { kind: 'activity', at: new Date().toISOString(), day: this.service.today() }
        return { yielded: true }
      },
    )
    this.revision = result.state.revision
  }
}
