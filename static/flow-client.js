// 每个页面只订阅、操作自己采用的流程，过期页面不能向后来启动的流程发送输入。
class TutorFlowClient {
  constructor(onError) {
    this.flowId = null
    this.source = null
    this.onError = onError
  }

  attach(flow) {
    if (flow.flowId !== this.flowId) this.source?.close()
    this.flowId = flow.flowId
  }

  connect() {
    this.source?.close()
    if (!this.flowId) return null
    this.source = new EventSource(`/flow/stream?flowId=${encodeURIComponent(this.flowId)}`)
    return this.source
  }

  async request(path, body = {}) {
    try {
      const params = path === '/flow/input' || path === '/flow/stop' ? { ...body, flowId: this.flowId } : body
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) })
      const result = await response.json()
      if (!response.ok || result.ok === false) throw new Error(result.error || '请求失败')
      if (path === '/flow/start') this.attach(result)
      return result
    } catch (error) {
      this.onError(error.message)
      return { ok: false, error: error.message }
    }
  }
}
