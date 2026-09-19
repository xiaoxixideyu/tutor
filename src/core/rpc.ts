import { COURSE_ID_PATTERN, type CourseStore } from './store.ts'
import { dueReviews } from './review.ts'
import { courseProgress, listCourseSummaries, listDueReviews } from './summary.ts'
import { applyReviewResult } from './assessment.ts'
import type { DocKind } from './schema.ts'

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
  if (typeof value !== 'number' || value < 0 || value > 1) {
    throw rpcError(RPC_ERRORS.invalidParams, '参数 score 必须是 0-1 的数字')
  }
  return value
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
    listCourses: () => listCourseSummaries(store),
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
      const day = typeof params?.today === 'string' && params.today.trim() !== '' ? params.today : today()
      requireCourse(store, id)
      if (!store.has(id, 'mastery')) {
        throw rpcError(RPC_ERRORS.invalidParams, `课程 "${id}" 尚未产生掌握度记录`)
      }
      const mastery = store.read(id, 'mastery') as Record<string, unknown>
      if (!(node in mastery)) {
        throw rpcError(RPC_ERRORS.invalidParams, `课程 "${id}" 没有知识点 "${node}" 的掌握度记录`)
      }
      const updated = applyReviewResult(mastery as never, node, score, day)
      store.write(id, 'mastery', updated)
      return updated[node]
    },
  }
}

export function handleRpcRequest(store: CourseStore, request: RpcRequest, today: () => string): RpcResponse {
  const id = request.id ?? null
  if (typeof request.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { ...RPC_ERRORS.invalidRequest } }
  }
  const handler = createRpcMethods(store, today)[request.method]
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
