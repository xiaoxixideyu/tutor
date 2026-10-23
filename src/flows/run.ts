// 流程调度：按 kind 组装依赖（课程状态、模型运行时、人格提示词、IO）并执行。
// CLI 与网页宿主共用这一个入口；单进程内直接调用，无子进程。
import fs from 'node:fs'
import path from 'node:path'
import { CourseStore } from '../core/store.ts'
import { localDate } from '../core/dates.ts'
import { acquireCourseLock, type CourseLock } from '../core/course-lock.ts'
import { ModelConfigStore } from '../core/model-config.ts'
import { ChatRuntime, type AgentChat, type AttemptObservation, type CreateChatOptions, type ModelSettings } from '../runtime/chat.ts'
import type { SearchSettings } from '../runtime/tools.ts'
import { createResearchStatus } from '../runtime/status.ts'
import { CostLedger } from './cost-ledger.ts'
import { FlowExit, type FlowIO } from './io.ts'
import type { FlowDeps, FlowInput } from './deps.ts'
import { runInterview } from './interview.ts'
import { runAssess } from './assess.ts'
import { runPlan } from './plan.ts'
import { runLearn } from './learn.ts'
import { runResearch } from './research.ts'
import { runPracticeGen } from './practice-gen.ts'
import { runExam } from './exam.ts'
import { runPractice } from './practice.ts'
import { runAuditContent } from './audit-content.ts'

export const RUNNERS = new Set(['new', 'assess', 'plan', 'research', 'learn', 'exam', 'practice-gen', 'practice', 'audit-content'])

const MODEL_KINDS = new Set(['new', 'assess', 'plan', 'research', 'learn', 'exam', 'practice-gen', 'audit-content'])

const PERSONA_FILES: Record<string, string> = {
  new: 'interview.md', assess: 'assess.md', plan: 'plan.md', learn: 'teach.md',
  research: 'research.md', 'practice-gen': 'practice-gen.md', exam: 'exam-grade.md',
}

export interface RunFlowOptions {
  root: string
  env: NodeJS.ProcessEnv
  workspace?: string
  // 验收/评测注入：观察每次传输尝试、限制单阶段模型请求次数。
  observe?: (event: AttemptObservation) => void
  maxModelRequests?: number
  // 每回合重新解析模型渠道（网页宿主：保存设置后进行中的流程下个回合生效）；缺省沿用启动快照。
  resolveModel?: () => ModelSettings
  // 每回合重新解析教研搜索服务（MCP）；缺省沿用启动环境快照。
  resolveSearch?: () => SearchSettings | undefined
  // 宿主注入的"今天"（网页宿主可与 RPC 使用同一来源）；缺省用本机时区的日历日。
  today?: () => string
}

export function personaFor(root: string, kind: string): string {
  if (kind === 'audit-content') return '独立审查已有课程的范围与正确性。'
  const file = PERSONA_FILES[kind]
  if (!file) throw new Error(`未知流程 "${kind}"`)
  return fs.readFileSync(path.join(root, 'config', 'persona', file), 'utf8').trim()
}

export function modelSettingsFromEnv(env: NodeJS.ProcessEnv): ModelSettings {
  return {
    baseUrl: (env.TUTOR_LLM_BASE_URL ?? '').replace(/\/+$/, ''),
    apiKey: env.TUTOR_LLM_API_KEY ?? '',
    model: env.TUTOR_LLM_MODEL ?? '',
    thinking: env.TUTOR_LLM_THINKING === 'on' ? 'on' : env.TUTOR_LLM_THINKING === 'off' ? 'off' : 'default',
    contextWindow: Number(env.TUTOR_LLM_CONTEXT_WINDOW || 262144),
    requestsPerMinute: Number(env.TUTOR_LLM_REQUESTS_PER_MINUTE || 8),
    researchDeadlineMs: Number(env.TUTOR_RESEARCH_DEADLINE_MS || env.TUTOR_LLM_DEADLINE_MS || 480_000),
  }
}

// 网页宿主已经冻结本次流程的配置（TUTOR_MODEL_CONFIG_RESOLVED=1）时不再读取保存文件。
export function resolveFlowEnv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.TUTOR_MODEL_CONFIG_RESOLVED === '1') return env
  return new ModelConfigStore(root, { env }).environment()
}

export async function runFlowInProcess(input: FlowInput, io: FlowIO, options: RunFlowOptions): Promise<number> {
  const root = options.root
  const env = options.env
  const workspace = options.workspace ?? env.TUTOR_WORKSPACE ?? root
  const store = new CourseStore(env.TUTOR_COURSES_ROOT ?? path.join(root, 'courses'))
  // 日历日以宿主注入为准；缺省时用环境里的时区（.env 中的 TUTOR_TIMEZONE 也能生效）。
  const day = options.today ?? (() => localDate(new Date(), env.TUTOR_TIMEZONE))
  const status = createResearchStatus(env, io.out)
  // 教研流程可选记录 HTTP 层运输诊断（仅状态码与白名单响应头，不含正文与密钥）。
  if (input.kind === 'research' && env.TUTOR_CHANNEL_TRACE_FILE) {
    const { startChannelTrace } = await import('../core/model-transport.ts')
    startChannelTrace(env.TUTOR_CHANNEL_TRACE_FILE, env.TUTOR_LLM_BASE_URL ?? '')
  }
  let runtime: ChatRuntime | undefined
  if (MODEL_KINDS.has(input.kind)) {
    runtime = new ChatRuntime({
      model: modelSettingsFromEnv(env),
      sessionsRoot: env.TUTOR_SESSIONS_ROOT ?? path.join(root, 'data', 'sessions'),
      workspace,
      persona: personaFor(root, input.kind),
      env, out: io.out, err: io.err, status,
      signal: io.signal,
      ...(options.observe ? { observe: options.observe } : {}),
      ...(options.maxModelRequests !== undefined ? { maxModelRequests: options.maxModelRequests } : {}),
      ...(options.resolveModel ? { resolveModel: options.resolveModel } : {}),
      ...(options.resolveSearch ? { resolveSearch: options.resolveSearch } : {}),
    })
  }
  const createChat = async (chatOptions: CreateChatOptions = {}): Promise<AgentChat | null> => {
    if (!runtime) throw new Error('本流程不需要模型会话')
    return runtime.createChat(chatOptions)
  }
  const deps: FlowDeps = {
    store, io, status, env, workspace, today: day,
    createChat: createChat as FlowDeps['createChat'],
    costs: new CostLedger(),
  }
  let lock: CourseLock
  try {
    lock = acquireCourseLock(store.root, input.courseId)
  } catch (error) {
    io.err(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  try {
    switch (input.kind) {
      case 'new': await runInterview(deps, { courseId: input.courseId }); break
      case 'assess': await runAssess(deps, { courseId: input.courseId, ...(input.reset ? { reset: true } : {}) }); break
      case 'plan': await runPlan(deps, { courseId: input.courseId }); break
      case 'learn': await runLearn(deps, { courseId: input.courseId }); break
      case 'research': await runResearch(deps, { courseId: input.courseId, ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}) }); break
      case 'practice-gen': await runPracticeGen(deps, { courseId: input.courseId, ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}) }); break
      case 'exam': await runExam(deps, { courseId: input.courseId, ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}), ...(input.discard ? { discard: true } : {}) }); break
      case 'practice': await runPractice(deps, { courseId: input.courseId, ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}) }); break
      case 'audit-content': return await runAuditContent(deps, { courseId: input.courseId })
      default: throw new Error(`未知流程 "${input.kind}"`)
    }
    return 0
  } catch (error) {
    if (error instanceof FlowExit) return error.code
    io.err(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    lock.release()
  }
}

export { FlowExit } from './io.ts'
