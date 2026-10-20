import type { CourseStore } from '../core/store.ts'
import { localDate } from '../core/dates.ts'
import type { AgentChat, CreateChatOptions } from '../runtime/chat.ts'
import type { ResearchStatusSink } from '../runtime/status.ts'
import type { FlowIO } from './io.ts'
import type { CostLedger } from './cost-ledger.ts'

// 流程依赖：业务代码只通过这里取课程状态、模型会话、输出与配置，不依赖进程全局。
export interface FlowDeps {
  store: CourseStore
  io: FlowIO
  createChat(options: CreateChatOptions & { resumeSessionId: string }): Promise<AgentChat | null>
  createChat(options?: CreateChatOptions): Promise<AgentChat>
  status: ResearchStatusSink
  env: NodeJS.ProcessEnv
  workspace: string
  today(): string
  // 整课成本台账：生产运行时注入；测试/旧壳可缺省。
  costs?: CostLedger
}

export function today(): string {
  return localDate()
}

export interface FlowInput {
  kind: string
  courseId: string
  milestoneId?: string
  nodeId?: string
  reset?: boolean
  discard?: boolean
}
