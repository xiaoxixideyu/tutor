import type { CourseStore } from '../core/store.ts'
import type { AgentChat, CreateChatOptions } from '../runtime/chat.ts'
import type { ResearchStatusSink } from '../runtime/status.ts'
import type { FlowIO } from './io.ts'

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
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface FlowInput {
  kind: string
  courseId: string
  milestoneId?: string
  nodeId?: string
}
