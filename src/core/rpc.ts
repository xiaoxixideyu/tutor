import { COURSE_ID_PATTERN, type CourseStore } from './store.ts'
import { dueReviews, pickReviewQuestions, reviewAttemptId } from './review.ts'
import { courseProgress, listCourseSummaries, listDueReviews } from './summary.ts'
import { applyReviewResult, judgeQuizAnswer } from './assessment.ts'
import type { DocKind, Mastery, Question, QuestionBank, ReviewResult } from './schema.ts'
import { requireReviewedBank } from './quality-store.ts'

// JSON-RPC 方法表（设计 §4.3：业务在核心，壳只做传输——http/stdio/未来 Harness 档案都可复用）

export interface RpcRequest {
  id?: unknown
  method: string
  params?: Record<string, unknown>
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: unknown
  result?: unknown
  error?: { code: number; message: string }
}

export const RPC_ERRORS = {
  parse: { code: -32700, message: 'Parse error' },
  invalidRequest: { code: -32600, message: 'Invalid Request' },
  methodNotFound: { code: -32601, message: 'Method not found' },
  invalidParams: { code: -32602, message: 'Invalid params' },
  internal: { code: -32603, message: 'Internal error' },
} as const

const DOC_KINDS: readonly DocKind[] = [
  'profile',
  'knowledge-map',
  'learner-profile',
  'plan',
  'mastery',
  'question-bank',
  'assessment',
  'lesson',
]

function rpcError(error: { code: number; message: string }, message: string): Error {
  return Object.assign(new Error(message), { rpcCode: error.code })
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw rpcError(RPC_ERRORS.invalidParams, `参数 ${name} 必须是非空字符串`)
  }
  return value
}

function asCourseId(params: Record<string, unknown> | undefined): string {
  const id = asString(params?.id, 'id')
  if (!COURSE_ID_PATTERN.test(id)) {
    throw rpcError(RPC_ERRORS.invalidParams, `课程 id "${id}" 非法`)
  }
  return id
}

function asScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw rpcError(RPC_ERRORS.invalidParams, '参数 score 必须是 0-1 的数字')
  }
  return value
}

function asStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw rpcError(RPC_ERRORS.invalidParams, `参数 ${name} 必须是字符串数组`)
  }
  return value as string[]
}

// 复习题下发给前端时抹掉答案（answer/accept），只留作答所需字段——判分一律留服务端，前端拿不到标准答案。
function stripAnswer(question: Question): { id: string; type: Question['type']; difficulty: number; question: string; choices?: string[] } {
  return {
    id: question.id,
    type: question.type,
    difficulty: question.difficulty,
    question: question.question,
    ...(question.choices ? { choices: question.choices } : {}),
  }
}

function requireCourse(store: CourseStore, id: string): void {
  if (!store.exists(id)) {
    throw rpcError(RPC_ERRORS.invalidParams, `课程 "${id}" 不存在`)
  }
}

// 方法表：method 名 -> 处理函数（params -> result）。抛出的 Error 若带 rpcCode 则映射为对应 JSON-RPC 错误码。
export function createRpcMethods(
  store: CourseStore,
  today: () => string
): Record<string, (params: Record<string, unknown> | undefined) => unknown> {
  return {
    ping: () => ({ ok: true }),
    listCourses: () => listCourseSummaries(store, today()),
    courseStatus: (params) => {
      const id = asCourseId(params)
      requireCourse(store, id)
      return courseProgress(store, id)
    },
    dueReviews: (params) => {
      if (params?.id === undefined) return listDueReviews(store, today())
      const id = asCourseId(params)
      requireCourse(store, id)
      const mastery = store.has(id, 'mastery') ? (store.read(id, 'mastery') as Record<string, unknown>) : {}
      return dueReviews(mastery as never, today())
    },
    readDoc: (params) => {
      const id = asCourseId(params)
      const kind = asString(params?.kind, 'kind')
      if (!DOC_KINDS.includes(kind as DocKind)) {
        throw rpcError(RPC_ERRORS.invalidParams, `未知的文档类型 "${kind}"`)
      }
      return store.read(id, kind as DocKind)
    },
    applyReview: (params) => {
      const id = asCourseId(params)
      const node = asString(params?.node, 'node')
      const score = asScore(params?.score)
      const day = today()
      requireCourse(store, id)
      if (!store.has(id, 'mastery')) {
        throw rpcError(RPC_ERRORS.invalidParams, `课程 "${id}" 尚未产生掌握度记录`)
      }
      const mastery = store.read(id, 'mastery') as Mastery
      if (!(node in mastery)) {
        throw rpcError(RPC_ERRORS.invalidParams, `课程 "${id}" 没有知识点 "${node}" 的掌握度记录`)
      }
      if (!mastery[node].review_due || mastery[node].review_due! > day) {
        throw rpcError(RPC_ERRORS.invalidParams, '该知识点尚未到复习日期或已完成本次复习')
      }
      const updated = applyReviewResult(mastery, node, score, day)
      store.write(id, 'mastery', updated)
      return updated[node]
    },
    // 取到期复习题（判分留服务端，故下发抹掉答案）。返回每个到期节点及其题目；题库缺失的节点 questions 为空，
    // 前端据此提示「题库缺失」而非静默漏掉。
    reviewQuestions: (params) => {
      const id = asCourseId(params)
      requireCourse(store, id)
      const day = today()
      const mastery = store.has(id, 'mastery') ? (store.read(id, 'mastery') as Mastery) : {}
      const bank = store.has(id, 'question-bank') ? (store.read(id, 'question-bank') as QuestionBank) : {}
      for (const due of dueReviews(mastery, day)) if (pickReviewQuestions(bank, due.node).length) requireReviewedBank(store, id, bank, due.node)
      const items = dueReviews(mastery, day).map((due) => ({
        node: due.node,
        stage: due.stage,
        review_due: due.review_due,
        attemptId: reviewAttemptId(id, due.node, mastery[due.node], pickReviewQuestions(bank, due.node)),
        questions: pickReviewQuestions(bank, due.node).map(stripAnswer),
      }))
      return { id, today: day, items }
    },
    // 提交某节点的复习作答：服务端判分（judgeQuizAnswer）→ 平铺分 correct/total → applyReviewResult 回写 mastery。
    // attemptId 绑定题目与掌握状态；重复请求读持久化回执，不再次推进复习阶梯。
    submitReview: (params) => {
      const id = asCourseId(params)
      const node = asString(params?.node, 'node')
      const answers = asStringArray(params?.answers, 'answers')
      requireCourse(store, id)
      if (!store.has(id, 'mastery')) {
        throw rpcError(RPC_ERRORS.invalidParams, `课程 "${id}" 尚未产生掌握度记录`)
      }
      const mastery = store.read(id, 'mastery') as Mastery
      if (!(node in mastery)) {
        throw rpcError(RPC_ERRORS.invalidParams, `课程 "${id}" 没有知识点 "${node}" 的掌握度记录`)
      }
      const attemptId = asString(params?.attemptId, 'attemptId')
      const receipt = mastery[node].last_review
      if (receipt?.attempt_id === attemptId) {
        if (JSON.stringify(answers) !== JSON.stringify(receipt.answers)) {
          throw rpcError(RPC_ERRORS.invalidParams, '该次复习已提交，不能更改答案')
        }
        return receipt.result
      }
      const bank = store.has(id, 'question-bank') ? (store.read(id, 'question-bank') as QuestionBank) : {}
      const questions = pickReviewQuestions(bank, node)
      if (questions.length === 0) {
        throw rpcError(RPC_ERRORS.invalidParams, `课程 "${id}" 知识点 "${node}" 没有可复习的题目`)
      }
      const day = today()
      if (!mastery[node].review_due || mastery[node].review_due! > day
        || attemptId !== reviewAttemptId(id, node, mastery[node], questions)) {
        throw rpcError(RPC_ERRORS.invalidParams, '复习题目或进度已变化，请刷新后重新取题')
      }
      if (answers.length !== questions.length || answers.some((answer) => !answer.trim())) {
        throw rpcError(RPC_ERRORS.invalidParams, '请完成全部复习题后提交')
      }
      requireReviewedBank(store, id, bank, node)
      const perQuestion = questions.map((question, index) => {
        const your = answers[index] ?? ''
        return {
          id: question.id,
          question: question.question,
          your,
          correct: judgeQuizAnswer(question, your),
          answer: question.answer,
        }
      })
      const correct = perQuestion.filter((q) => q.correct).length
      const total = questions.length
      const score = correct / total
      const updated = applyReviewResult(mastery, node, score, day)
      const result: ReviewResult = { score, correct, total, perQuestion, entry: { ...updated[node] } }
      updated[node].last_review = { attempt_id: attemptId, answers: [...answers], result }
      store.write(id, 'mastery', updated)
      return result
    },
  }
}

export function handleRpcRequest(store: CourseStore, request: RpcRequest, today: () => string): RpcResponse {
  const id = request?.id ?? null
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { ...RPC_ERRORS.invalidRequest } }
  }
  const methods = createRpcMethods(store, today)
  const handler = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined
  if (!handler) {
    return { jsonrpc: '2.0', id, error: { ...RPC_ERRORS.methodNotFound } }
  }
  try {
    return { jsonrpc: '2.0', id, result: handler(request.params) }
  } catch (error) {
    const rpcCode = (error as { rpcCode?: number }).rpcCode
    if (typeof rpcCode === 'number') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: rpcCode, message: error instanceof Error ? error.message : String(error) },
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: RPC_ERRORS.internal.code, message: error instanceof Error ? error.message : String(error) },
    }
  }
}
