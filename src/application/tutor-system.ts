import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { localDate } from '../core/dates.ts'
import { ModelConfigStore, readModelEnvironment } from '../core/model-config.ts'
import { acquireCourseRunLock, CourseBusyError, type CourseLock } from '../core/course-lock.ts'
import { loadCostConfig, normalizeUsage, ratesForModel, estimateCost } from '../core/cost.ts'
import { CourseRepository } from './repository.ts'
import { UsageLedger } from './usage-ledger.ts'
import { addEvent, CourseService } from './course-service.ts'
import {
  domainAssert,
  DomainError,
  type LearningIntent,
  type ModelUsageEntry,
  type TeachingEvent,
  type CourseState,
} from '../domain/model.ts'
import { digest, integer, object, text } from '../domain/validation.ts'
import {
  ChatRuntime,
  ModelBudgetError,
  type ChatRuntimeOptions,
  type AttemptObservation,
} from '../runtime/chat.ts'
import { searchSettingsFromEnv } from '../runtime/tools.ts'
import { normalizeReasoning } from '../core/reasoning.ts'
import { judgmentEnvironment } from '../core/judgment-config.ts'
import { ModelService } from '../capabilities/model-service.ts'
import { TeachingCapabilities } from '../capabilities/teaching.ts'
import { TutorAgent } from '../agents/tutor.ts'

export const INTENTS: LearningIntent[] = [
  'learn',
  'review',
  'practice',
  'assess',
  'exam',
  'research',
  'repair',
]
export interface TutorSystemOptions {
  root: string
  coursesRoot?: string
  dataRoot?: string
  modelConfigFile?: string
  env?: NodeJS.ProcessEnv
  today?: () => string
  runtimeFactory?: (options: ChatRuntimeOptions) => ChatRuntime
  judgmentFetch?: typeof fetch
}

export interface TutorJob {
  id: string
  courseId: string
  requestId: string
  kind: 'turn' | 'answer'
  phase: string
  controller: AbortController
  promise: Promise<void>
  runLock: CourseLock
}

export interface TutorCommandResult {
  job: { id: string; courseId: string; requestId: string; phase: string; kind?: TutorJob['kind'] } | null
  resumed?: boolean
  completed?: boolean
  duplicate?: boolean
  result?: unknown
}

export class TutorSystem {
  readonly root: string
  readonly dataRoot: string
  readonly repository: CourseRepository
  readonly service: CourseService
  readonly models: ModelConfigStore
  readonly today: () => string
  readonly usageLedger: UsageLedger
  private readonly options: TutorSystemOptions
  private readonly jobs = new Map<string, TutorJob>()
  private readonly listeners = new Set<
    (courseId: string, operation?: { phase: string; running: boolean }) => void
  >()
  private readonly costConfig: ReturnType<typeof loadCostConfig>

  constructor(options: TutorSystemOptions) {
    this.options = options
    this.root = path.resolve(options.root)
    this.dataRoot = path.resolve(
      options.dataRoot ?? options.env?.TUTOR_DATA_ROOT ?? path.join(this.root, 'data'),
    )
    this.models = new ModelConfigStore(this.root, { file: options.modelConfigFile, env: options.env })
    this.repository = new CourseRepository(
      options.coursesRoot ?? options.env?.TUTOR_COURSES_ROOT ?? path.join(this.root, 'courses'),
    )
    const environment = readModelEnvironment(this.root, options.env)
    this.today = options.today ?? (() => localDate(new Date(), environment.TUTOR_TIMEZONE))
    this.service = new CourseService(this.repository, this.today)
    this.usageLedger = new UsageLedger(this.dataRoot)
    this.costConfig = loadCostConfig(
      fs.existsSync(path.join(this.root, 'config/cost.yaml'))
        ? fs.readFileSync(path.join(this.root, 'config/cost.yaml'), 'utf8')
        : undefined,
    )
    this.recover()
  }

  subscribe(
    listener: (courseId: string, operation?: { phase: string; running: boolean }) => void,
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(courseId: string, operation?: { phase: string; running: boolean }): void {
    for (const listener of this.listeners) listener(courseId, operation)
  }

  activeJobs() {
    return [...this.jobs.values()].map((job) => ({
      id: job.id,
      courseId: job.courseId,
      requestId: job.requestId,
      kind: job.kind,
      phase: job.phase,
    }))
  }

  private recover(): void {
    for (const courseId of this.repository.list()) {
      try {
        const state = this.repository.read(courseId)
        if (state.tutorStatus !== 'working') continue
        this.withCourseRun(courseId, () => {
          if (this.repository.read(courseId).tutorStatus !== 'working') return
          this.repository.transact(
            courseId,
            { requestId: 'recover:' + randomUUID(), input: { recover: true } },
            (next) => {
              next.tutorStatus = 'paused'
              const current = this.service.activity(next)
              if (current?.record.status === 'active') current.record.status = 'paused'
              addEvent(next, 'session_paused', {
                recovered: true,
                message: '上次运行已中断，作答和完成步骤已保存',
              })
              return { recovered: true }
            },
          )
        })
      } catch {
        /* 活跃执行者继续运行；损坏课程通过查询接口明确显示。 */
      }
    }
  }

  private withCourseRun<T>(courseId: string, work: (lock: CourseLock) => T): T {
    let lock: CourseLock
    try {
      lock = acquireCourseRunLock(this.repository.root, courseId)
    } catch (error) {
      if (error instanceof CourseBusyError)
        throw new DomainError('COURSE_BUSY', '本课程正在另一入口中处理，请等待或在该入口暂停', 409)
      throw error
    }
    try {
      return work(lock)
    } finally {
      if (this.jobs.get(courseId)?.runLock !== lock) lock.release()
    }
  }

  private available(): NodeJS.ProcessEnv {
    try {
      return this.models.environment()
    } catch (error) {
      throw new DomainError(
        'MODEL_NOT_CONFIGURED',
        error instanceof Error ? error.message : '请先配置模型',
        503,
      )
    }
  }

  private budgetAvailable(env: NodeJS.ProcessEnv): void {
    const limit = Number(env.TUTOR_DAILY_COST_LIMIT || 10)
    domainAssert(Number.isFinite(limit) && limit > 0, 'INVALID_BUDGET', '每日模型预算配置不合法', 500)
    const used = this.usageLedger.daily(this.today())
    const requests = Number(env.TUTOR_DAILY_REQUEST_LIMIT || 100)
    domainAssert(
      used.estimatedCost < limit && used.requests < requests,
      'BUDGET_EXCEEDED',
      '今天的模型调用已达到预算，学习记录已保存',
      429,
    )
  }

  private usageObserver(
    env: NodeJS.ProcessEnv,
    courseId: string,
    roleFor: (sessionId: string) => string,
    usage: ModelUsageEntry[] = [],
  ) {
    const turnLimit = Number(env.TUTOR_SESSION_COST_LIMIT || 2)
    domainAssert(Number.isFinite(turnLimit) && turnLimit > 0, 'INVALID_BUDGET', '回合模型预算不合法', 500)
    return (event: AttemptObservation) => {
      if (event.type === 'attempt-start') {
        this.budgetAvailable(env)
        this.usageLedger.record({
          id: event.attemptId,
          at: event.time,
          model: event.model ?? env.TUTOR_LLM_MODEL ?? 'unknown',
          role: roleFor(event.sessionId),
          courseId,
          day: this.today(),
          inputTokens: 0,
          outputTokens: 0,
          estimatedCost: 0,
          unknown: true,
        })
      }
      if (event.type !== 'attempt') return
      const sample = normalizeUsage(event.usage)
      const rates = ratesForModel(this.costConfig, event.model)
      const entry: ModelUsageEntry = {
        id: event.attemptId,
        at: new Date().toISOString(),
        model: event.model,
        role: roleFor(event.sessionId),
        inputTokens: sample?.inputTokens ?? 0,
        outputTokens: sample?.outputTokens ?? 0,
        estimatedCost: sample
          ? estimateCost(sample, event.provider === 'typesafe' ? { ...rates, output: 0 } : rates)
          : 0,
        unknown: !sample,
      }
      usage.push(entry)
      this.usageLedger.record({ ...entry, courseId, day: this.today() })
      if (usage.reduce((sum, item) => sum + item.estimatedCost, 0) > turnLimit)
        throw new ModelBudgetError('本回合模型预算已用完，完成的学习结果已保存')
    }
  }

  async testJudgment(input: unknown, signal?: AbortSignal) {
    const config = this.models.draft(input)
    domainAssert(config.judgment.provider === 'typesafe', 'INVALID_INPUT', '请先选择 TypeSafe 快速辅助判断')
    const env = {
      ...readModelEnvironment(this.root, this.options.env),
      ...judgmentEnvironment(config.judgment),
    }
    this.budgetAvailable(env)
    const options: ChatRuntimeOptions = {
      model: {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        thinking: config.thinking,
        contextWindow: config.contextWindow,
        maxOutputTokens: config.maxOutputTokens,
        requestsPerMinute: config.requestsPerMinute,
        researchDeadlineMs: config.researchDeadlineMs,
      },
      sessionsRoot: path.join(this.dataRoot, 'sessions'),
      workspace: this.root,
      env,
      signal,
      typedFetch: this.options.judgmentFetch,
      maxModelRequests: 1,
      observe: this.usageObserver(env, 'configuration', () => 'judge-connection-test'),
    }
    const runtime = this.options.runtimeFactory?.(options) ?? new ChatRuntime(options)
    const model = new ModelService(runtime)
    const started = Date.now()
    try {
      const result = await model.judgments.query(
        config.judgment,
        { original: '我喜欢先看例子。', preference: '先看例子' },
        [{ id: 'preference', instructions: 'preference 是否得到 original 原话的明确支持？', failure: '' }],
      )
      const answer = result.answers.preference
      return {
        provider: 'typesafe',
        model: result.model,
        elapsedMs: Date.now() - started,
        questionType: answer.type,
        choice: answer.choice,
        probability: answer.probabilities[answer.choice],
        ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
        ...(answer.noul !== undefined ? { noul: answer.noul } : {}),
      }
    } catch (error) {
      if (error instanceof DomainError || error instanceof ModelBudgetError) throw error
      throw new DomainError('JUDGMENT_UNAVAILABLE', model.error(error), 502)
    }
  }

  start(
    courseId: string,
    input: {
      requestId: string
      message?: string
      intent?: LearningIntent
      expectedRevision?: number
      activeMs?: number
    },
  ): TutorCommandResult {
    const intent = input.intent ?? 'learn'
    domainAssert(INTENTS.includes(intent), 'INVALID_INPUT', '学习意图不合法')
    const message = text(input.message ?? '', '学习反馈', 20000, true)
    const state = this.repository.read(courseId)
    const inputHash = digest({ message, intent, trigger: 'user' })
    const checkReceipt = (state: CourseState) => {
      const receipt = state.receipts[input.requestId]
      if (receipt)
        domainAssert(
          receipt.inputHash === inputHash,
          'ALREADY_SUBMITTED',
          '该次请求已提交，不能更改反馈或意图',
          409,
        )
      return receipt
    }
    const receipt = checkReceipt(state)
    const existing = state.turns[input.requestId]
    if (existing?.status === 'completed') return { job: null, completed: true, duplicate: true }
    const current = this.jobs.get(courseId)
    if (current?.requestId === input.requestId) {
      domainAssert(
        current.kind === 'turn' && receipt?.inputHash === inputHash,
        'ALREADY_SUBMITTED',
        '该请求标识已用于其他操作',
        409,
      )
      return {
        job: {
          id: current.id,
          courseId,
          requestId: current.requestId,
          kind: current.kind,
          phase: current.phase,
        },
        resumed: true,
      }
    }
    domainAssert(!current, 'COURSE_BUSY', '导师正在处理本课程，请等待或暂停后继续', 409)
    return this.withCourseRun(courseId, (runLock) => {
      const state = this.repository.read(courseId)
      checkReceipt(state)
      const existing = state.turns[input.requestId]
      if (existing?.status === 'completed') return { job: null, completed: true, duplicate: true }
      const env = this.available()
      this.budgetAvailable(env)
      domainAssert(!state.pendingAnswer, 'PENDING_ANSWER', '已有作答等待评分，请点击恢复', 409)
      const result = this.service.beginTurn(courseId, { ...input, message, intent, trigger: 'user' })
      if (existing && result.duplicate)
        this.repository.transact(
          courseId,
          { requestId: 'retry-turn:' + randomUUID(), input: { requestId: input.requestId } },
          (next) => {
            next.turns[input.requestId].status = 'pending'
            next.tutorStatus = 'working'
            delete next.tutorError
            return { resumed: true }
          },
        )
      const job = this.launch(
        courseId,
        input.requestId,
        'turn',
        env,
        runLock,
        async (runtime, model, signal, register) =>
          new TutorAgent({ service: this.service, runtime, model, role: register }).run(
            courseId,
            input.requestId,
            signal,
          ),
      )
      this.notify(courseId)
      return {
        job: { id: job.id, courseId, requestId: input.requestId, kind: job.kind, phase: job.phase },
        resumed: result.duplicate,
      }
    })
  }

  answer(
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
  ): TutorCommandResult {
    const answer = text(input.answer, '作答', 50000)
    const inputHash = digest({
      activityId: input.activityId,
      questionId: input.questionId,
      contentHash: input.contentHash,
      answer,
    })
    const checkReceipt = (state: CourseState) =>
      domainAssert(
        state.receipts['begin:' + input.requestId]?.inputHash === inputHash,
        'ALREADY_SUBMITTED',
        '该次作答已提交，不能更改',
        409,
      )
    const state = this.repository.read(courseId)
    const existing = state.receipts['answer:' + input.requestId]
    const job = this.jobs.get(courseId)
    if (existing || job?.requestId === input.requestId) checkReceipt(state)
    if (existing) return { job: null, completed: true, duplicate: true, result: existing.result }
    if (job?.requestId === input.requestId) {
      domainAssert(job.kind === 'answer', 'ALREADY_SUBMITTED', '该请求标识已用于其他操作', 409)
      return { job: { id: job.id, courseId, requestId: job.requestId, phase: job.phase }, resumed: true }
    }
    domainAssert(!job, 'COURSE_BUSY', '导师正在处理当前回合', 409)
    return this.withCourseRun(courseId, (runLock) => {
      const state = this.repository.read(courseId)
      const existing = state.receipts['answer:' + input.requestId]
      if (existing) {
        checkReceipt(state)
        return { job: null, completed: true, duplicate: true, result: existing.result }
      }
      const active = this.service.activity(state)
      domainAssert(active, 'INVALID_ACTIVITY', '没有可作答的活动')
      const question = active.content.questions[active.record.index]
      const env =
        question?.type === 'choice' || question?.type === 'numeric'
          ? (() => {
              try {
                return this.models.environment()
              } catch {
                return { ...(this.options.env ?? process.env) }
              }
            })()
          : this.available()
      this.service.beginAnswer(courseId, { ...input, answer })
      const launched = this.launchAnswer(courseId, input.requestId, env, runLock)
      this.notify(courseId)
      return {
        job: { id: launched.id, courseId, requestId: input.requestId, kind: 'answer', phase: launched.phase },
      }
    })
  }

  resume(courseId: string, requestId: string): TutorCommandResult {
    domainAssert(!this.jobs.has(courseId), 'COURSE_BUSY', '当前任务尚未结束', 409)
    const restored = this.withCourseRun(courseId, (runLock) => {
      const state = this.repository.read(courseId)
      const env = this.available()
      if (state.pendingAnswer) {
        const pending = state.pendingAnswer
        this.repository.transact(
          courseId,
          { requestId: 'resume-answer:' + requestId, input: { requestId } },
          (next) => {
            const active = this.service.activity(next, pending.activityId)
            if (active) active.record.status = 'active'
            next.tutorStatus = 'working'
            delete next.tutorError
            return { resumed: true }
          },
        )
        const job = this.launchAnswer(courseId, pending.requestId, env, runLock)
        this.notify(courseId)
        return { job: { id: job.id, courseId, requestId: pending.requestId, phase: job.phase } }
      }
      const unfinished = Object.entries(state.turns)
        .reverse()
        .find(([, turn]) => turn.status !== 'completed')
      const pausedActivity = this.service.activity(state)
      if (pausedActivity?.record.status === 'paused' && (!unfinished || unfinished[1].yielded)) {
        this.service.beginTurn(courseId, {
          requestId,
          intent: state.turns[pausedActivity.record.decisionId]?.intent ?? 'learn',
          message: '',
          trigger: 'resume',
        })
        const job = this.launch(
          courseId,
          requestId,
          'turn',
          env,
          runLock,
          async (_runtime, model, signal) => {
            const current = this.repository.read(courseId)
            await new TeachingCapabilities(this.service, model).validation.activity(
              current,
              pausedActivity.content,
            )
            signal.throwIfAborted()
            this.service.resumeActivity(
              courseId,
              pausedActivity.record.id,
              'restore:' + requestId,
              current.revision,
              requestId,
            )
            return { paused: false }
          },
        )
        this.notify(courseId)
        return { job: { id: job.id, courseId, requestId, phase: job.phase } }
      }
      if (unfinished && !unfinished[1].yielded) {
        this.repository.transact(
          courseId,
          { requestId: 'resume-turn:' + requestId, input: { requestId } },
          (next) => {
            next.tutorStatus = 'working'
            next.turns[unfinished[0]].status = 'pending'
            next.turns[unfinished[0]].trigger = 'resume'
            delete next.tutorError
            return { resumed: true }
          },
        )
        const job = this.launch(
          courseId,
          unfinished[0],
          'turn',
          env,
          runLock,
          (runtime, model, signal, register) =>
            new TutorAgent({ service: this.service, runtime, model, role: register }).run(
              courseId,
              unfinished[0],
              signal,
            ),
        )
        this.notify(courseId)
        return { job: { id: job.id, courseId, requestId: unfinished[0], phase: job.phase } }
      }
      return null
    })
    return restored ?? this.start(courseId, { requestId, intent: 'learn', message: '' })
  }

  private launchAnswer(
    courseId: string,
    requestId: string,
    env: NodeJS.ProcessEnv,
    runLock: CourseLock,
  ): TutorJob {
    return this.launch(
      courseId,
      requestId,
      'answer',
      env,
      runLock,
      async (runtime, model, signal, register) => {
        const state = this.repository.read(courseId)
        if (state.pendingAnswer?.requestId === requestId) {
          const grade = await new TeachingCapabilities(this.service, model).gradeAnswer(state, signal)
          signal.throwIfAborted()
          this.service.commitAnswer(courseId, requestId, grade)
          this.notify(courseId)
        }
        const followupId = requestId + ':feedback'
        const latest = this.repository.read(courseId)
        if (latest.turns[followupId]?.status === 'completed' || latest.turns[followupId]?.yielded)
          return { paused: false }
        const evidence = latest.evidence.find(
          (item) =>
            item.kind === 'answer' &&
            latest.receipts['answer:' + requestId] &&
            item.id === (latest.receipts['answer:' + requestId].result as { evidenceId: string }).evidenceId,
        )
        const activity =
          evidence?.kind === 'answer'
            ? latest.activities.find((item) => item.id === evidence.activityId)
            : undefined
        const intent = activity ? (latest.turns[activity.decisionId]?.intent ?? 'learn') : 'learn'
        // 评分是事实，下一步教学由 agent 再判断；不伪造学员反馈。
        try {
          try {
            this.available()
          } catch {
            return { paused: false }
          }
          this.service.beginTurn(courseId, {
            requestId: followupId,
            intent,
            message: '',
            trigger: 'answer_result',
          })
          const result = await new TutorAgent({ service: this.service, runtime, model, role: register }).run(
            courseId,
            followupId,
            signal,
          )
          this.service.finishTurn(courseId, followupId, result)
          return result
        } catch (error) {
          if (signal.aborted) throw error
          const remaining = this.repository.read(courseId)
          if (remaining.turns[followupId])
            this.service.finishTurn(courseId, followupId, {
              error: error instanceof Error ? error.message : String(error),
            })
          throw error
        }
      },
    )
  }

  private launch(
    courseId: string,
    requestId: string,
    kind: TutorJob['kind'],
    env: NodeJS.ProcessEnv,
    runLock: CourseLock,
    work: (
      runtime: ChatRuntime,
      model: ModelService,
      signal: AbortSignal,
      register: (sessionId: string, role: string) => void,
    ) => Promise<{ paused: boolean }>,
  ): TutorJob {
    const job: TutorJob = {
      id: 'job-' + randomUUID(),
      courseId,
      requestId,
      kind,
      phase: kind === 'answer' ? '评阅作答' : '准备下一步',
      controller: new AbortController(),
      promise: Promise.resolve(),
      runLock,
    }
    this.jobs.set(courseId, job)
    try {
      const roles = new Map<string, string>()
      const usage: ModelUsageEntry[] = []
      const register = (sessionId: string, role: string) => roles.set(sessionId, role)
      const observe = this.usageObserver(env, courseId, (id) => roles.get(id) ?? 'tutor', usage)
      const settings = () => {
        const current = this.models.environment()
        return {
          baseUrl: current.TUTOR_LLM_BASE_URL!,
          apiKey: current.TUTOR_LLM_API_KEY!,
          model: current.TUTOR_LLM_MODEL!,
          thinking: normalizeReasoning(current.TUTOR_LLM_THINKING),
          contextWindow: Number(current.TUTOR_LLM_CONTEXT_WINDOW || 262144),
          maxOutputTokens: Number(current.TUTOR_LLM_MAX_OUTPUT_TOKENS || 16384),
          requestsPerMinute: Number(current.TUTOR_LLM_REQUESTS_PER_MINUTE || 8),
          researchDeadlineMs: Number(current.TUTOR_RESEARCH_DEADLINE_MS || 240000),
        }
      }
      const progress = (phase: string) => {
        job.phase = phase
        this.notify(courseId, { phase, running: true })
      }
      const runtimeOptions: ChatRuntimeOptions = {
        model: (() => {
          try {
            return settings()
          } catch {
            return {
              baseUrl: '',
              apiKey: '',
              model: '',
              thinking: 'default' as const,
              contextWindow: 262144,
              maxOutputTokens: 16384,
              requestsPerMinute: 8,
              researchDeadlineMs: 240000,
            }
          }
        })(),
        sessionsRoot: env.TUTOR_SESSIONS_ROOT ?? path.join(this.dataRoot, 'sessions'),
        workspace: this.root,
        env,
        persona: fs.readFileSync(path.join(this.root, 'config/persona/tutor.md'), 'utf8'),
        resolveModel: settings,
        resolveSearch: () => {
          try {
            return searchSettingsFromEnv(this.models.environment())
          } catch {
            return undefined
          }
        },
        signal: job.controller.signal,
        observe,
        typedFetch: this.options.judgmentFetch,
        maxModelRequests: Number(env.TUTOR_AGENT_MAX_REQUESTS || 16),
        out: () => {},
        err: () => {},
        status: (status) => progress(status.message),
      }
      const runtime = this.options.runtimeFactory?.(runtimeOptions) ?? new ChatRuntime(runtimeOptions)
      const model = new ModelService(runtime, { progress, onChatCreated: register })
      const timer = setTimeout(
        () => job.controller.abort(new ModelBudgetError('本次教学处理达到总时限，进度已保存，请继续')),
        Number(env.TUTOR_TURN_DEADLINE_MS || 420000),
      )
      job.promise = (async () => {
        let error: string | undefined,
          paused = false
        try {
          const result = await work(runtime, model, job.controller.signal, register)
          paused = result.paused
        } catch (failure) {
          paused = job.controller.signal.aborted
          if (!paused) error = model.error(failure)
        } finally {
          clearTimeout(timer)
          try {
            if (this.repository.exists(courseId))
              this.service.finishTurn(courseId, requestId, { error, paused, usage })
          } finally {
            if (this.jobs.get(courseId) === job) this.jobs.delete(courseId)
            runLock.release()
            this.notify(courseId, {
              phase: error ? '本轮未完成，可恢复' : paused ? '已暂停' : '轮到你了',
              running: false,
            })
          }
        }
      })()
      return job
    } catch (failure) {
      try {
        if (this.repository.exists(courseId))
          this.service.finishTurn(courseId, requestId, {
            error: failure instanceof Error ? failure.message : String(failure),
          })
      } finally {
        if (this.jobs.get(courseId) === job) this.jobs.delete(courseId)
        runLock.release()
      }
      throw failure
    }
  }

  pause(courseId: string, requestId: string) {
    const pause = () => {
      this.jobs.get(courseId)?.controller.abort(new Error('学员暂停'))
      const result = this.service.pause(courseId, requestId)
      this.notify(courseId)
      return result
    }
    return this.jobs.has(courseId) ? pause() : this.withCourseRun(courseId, pause)
  }

  resolveGoal(
    courseId: string,
    proposalId: string,
    accept: boolean,
    requestId: string,
    expectedRevision: number,
  ) {
    return this.withCourseRun(courseId, () => {
      const result = this.service.resolveGoal(courseId, proposalId, accept, requestId, expectedRevision)
      this.notify(courseId)
      return result
    })
  }

  async remove(courseId: string): Promise<void> {
    if (this.jobs.has(courseId)) {
      this.pause(courseId, 'remove:' + randomUUID())
      await this.wait(courseId)
    }
    this.withCourseRun(courseId, () => this.repository.remove(courseId))
  }

  async wait(courseId: string): Promise<void> {
    await this.jobs.get(courseId)?.promise
  }

  async close(): Promise<void> {
    for (const job of this.jobs.values()) job.controller.abort(new Error('服务关闭'))
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise))
  }

  events(courseId: string, after: number): TeachingEvent[] {
    const state = this.repository.read(courseId)
    return state.events
      .filter((event) => event.seq > after)
      .map((event) => {
        if (typeof event.data.asset === 'string') {
          const value = this.repository.asset<{ text?: string }>(courseId, event.data.asset)
          if (value.text !== undefined) return { ...event, data: { ...event.data, text: value.text } }
          if (event.type === 'activity_presented') {
            const content = value as unknown as import('../domain/model.ts').ActivityContent
            return {
              ...event,
              data: {
                ...event.data,
                body: content.body,
                rationale: content.rationale,
                title: content.title,
                kind: content.kind,
              },
            }
          }
        }
        return event
      })
  }

  async recommendToday(availableMinutes: number, signal?: AbortSignal) {
    availableMinutes = integer(availableMinutes, '今日可用分钟', 5, 600)
    const courses = this.service.list().filter((course) => !('error' in course))
    if (!courses.length) return { recommendation: null }
    const fingerprint = digest(courses.map((course) => ({ id: course.id, updatedAt: course.updatedAt })))
    const file = path.join(this.dataRoot, 'today.json')
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (
        saved.day === this.today() &&
        saved.fingerprint === fingerprint &&
        saved.availableMinutes === availableMinutes
      )
        return saved
    } catch {
      /* 首次请求或决策过期 */
    }
    const env = this.available()
    this.budgetAvailable(env)
    const observation = courses.map((course) => ({
      ...course,
      goal: this.repository.read(course.id).goal,
      hypotheses: this.repository.read(course.id).hypotheses.slice(-3),
    }))
    const options: ChatRuntimeOptions = {
      model: {
        baseUrl: env.TUTOR_LLM_BASE_URL!,
        apiKey: env.TUTOR_LLM_API_KEY!,
        model: env.TUTOR_LLM_MODEL!,
        thinking: normalizeReasoning(env.TUTOR_LLM_THINKING),
        contextWindow: Number(env.TUTOR_LLM_CONTEXT_WINDOW || 262144),
        maxOutputTokens: 16384,
        requestsPerMinute: Number(env.TUTOR_LLM_REQUESTS_PER_MINUTE || 8),
        researchDeadlineMs: 240000,
      },
      sessionsRoot: env.TUTOR_SESSIONS_ROOT ?? path.join(this.dataRoot, 'sessions'),
      workspace: this.root,
      env,
      maxModelRequests: 2,
      signal,
      observe: (event) => {
        if (event.type === 'attempt-start') {
          this.budgetAvailable(env)
          this.usageLedger.record({
            id: event.attemptId,
            at: event.time,
            model: env.TUTOR_LLM_MODEL!,
            role: 'daily-planning',
            courseId: 'daily',
            day: this.today(),
            inputTokens: 0,
            outputTokens: 0,
            estimatedCost: 0,
            unknown: true,
          })
        }
        if (event.type === 'attempt') {
          const sample = normalizeUsage(event.usage)
          this.usageLedger.record({
            id: event.attemptId,
            at: new Date().toISOString(),
            model: event.model,
            role: 'daily-planning',
            courseId: 'daily',
            day: this.today(),
            inputTokens: sample?.inputTokens ?? 0,
            outputTokens: sample?.outputTokens ?? 0,
            estimatedCost: sample ? estimateCost(sample, ratesForModel(this.costConfig, event.model)) : 0,
            unknown: !sample,
          })
        }
      },
    }
    const runtime = this.options.runtimeFactory?.(options) ?? new ChatRuntime(options)
    const recommendation = await new ModelService(runtime).json(
      '安排今天',
      '依据多门课程的目标、期限、优先级、正在进行的活动、记忆参考和可用时间，推荐今天先做的一件事。' +
        '不要固定将复习放在新课之前。已完成目标可安排回访；时间不够时选具体可执行步骤。' +
        '只输出 JSON：{"courseId":"课程标识","intent":"learn|review|practice|assess|exam|research|repair","label":"面向学员的动作","reason":"具体原因","minutes":10}',
      { today: this.today(), availableMinutes, courses: observation },
      (value) => {
        const raw = object(value)
        const courseId = text(raw.courseId, '课程标识', 64)
        domainAssert(
          courses.some((course) => course.id === courseId),
          'INVALID_MODEL_OUTPUT',
          '推荐了不存在的课程',
        )
        domainAssert(INTENTS.includes(raw.intent as LearningIntent), 'INVALID_MODEL_OUTPUT', '推荐意图不合法')
        return {
          courseId,
          intent: raw.intent as LearningIntent,
          label: text(raw.label, '今日行动', 300),
          reason: text(raw.reason, '推荐原因', 1200),
          minutes: integer(raw.minutes, '预计分钟', 1, availableMinutes),
        }
      },
    )
    const saved = { day: this.today(), fingerprint, availableMinutes, recommendation }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = file + '.' + randomUUID() + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 })
    fs.renameSync(temporary, file)
    return saved
  }

  readToday() {
    let recommendation: unknown = null
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.dataRoot, 'today.json'), 'utf8'))
      const fingerprint = digest(
        this.service
          .list()
          .filter((course) => !('error' in course))
          .map((course) => ({ id: course.id, updatedAt: course.updatedAt })),
      )
      if (saved.day === this.today() && saved.fingerprint === fingerprint)
        recommendation = saved.recommendation
    } catch {
      /* 查看不触发模型 */
    }
    const courses = this.service.list()
    return {
      today: this.today(),
      courses,
      recommendation,
      activeMinutes:
        courses.reduce(
          (sum, course) => sum + ('todayActiveMs' in course ? (course.todayActiveMs ?? 0) : 0),
          0,
        ) / 60000,
      configured: this.models.publicConfig().configured,
    }
  }
}
