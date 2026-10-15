// 只公开运行状态；不包含提示词、模型正文、推理或密钥。
export interface ResearchStatusEvent {
  phase: 'request' | 'waiting' | 'retry' | 'node' | 'saved' | 'review'
  message: string
  node?: string
  title?: string
  completed?: number
  total?: number
  retry?: number
  maxRetries?: number
  retryAt?: number
  waitReason?: 'local-rate-limit' | 'channel-cooldown'
  requestsPerMinute?: number
  code?: string
}

export type ResearchStatusSink = (event: ResearchStatusEvent) => void

// 与旧壳一致：仅当 TUTOR_RESEARCH_PROGRESS=1 时输出 @@tutor-progress 结构化行。
export function createResearchStatus(env: NodeJS.ProcessEnv, out: (text: string) => void): ResearchStatusSink {
  let current: Pick<ResearchStatusEvent, 'node' | 'title' | 'completed' | 'total'> = {}
  return (event: ResearchStatusEvent): void => {
    if (env.TUTOR_RESEARCH_PROGRESS !== '1') return
    if (event.node) current = { node: event.node, title: event.title, completed: event.completed, total: event.total }
    out(`@@tutor-progress ${JSON.stringify({ ...current, ...event, at: Date.now() })}\n`)
  }
}
