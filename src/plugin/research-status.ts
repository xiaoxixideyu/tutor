// 只公开运行状态；不包含提示词、模型正文、推理或密钥。旧 HTTP/SSE 宿主也能透传。
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
  code?: string
}

let current: Pick<ResearchStatusEvent, 'node' | 'title' | 'completed' | 'total'> = {}

export function researchStatus(event: ResearchStatusEvent): void {
  if (process.env.TUTOR_RESEARCH_PROGRESS === '1') {
    if (event.node) current = { node: event.node, title: event.title, completed: event.completed, total: event.total }
    process.stdout.write(`@@tutor-progress ${JSON.stringify({ ...current, ...event, at: Date.now() })}\n`)
  }
}
