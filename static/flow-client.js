// 每个页面只订阅、操作自己采用的流程，过期页面不能向后来启动的流程发送输入。
class TutorFlowClient {
  constructor(onError) {
    this.flowId = null
    this.source = null
    this.onError = onError
    this.lastError = ''
  }

  attach(flow) {
    if (!flow || typeof flow.flowId !== 'string' || !flow.flowId.trim()
      || !['running', 'stopping', 'completed', 'failed'].includes(flow.status)) {
      this.source?.close()
      this.source = null
      this.flowId = null
      this.fail('后台服务与页面版本不兼容，请重启 tutor 服务后刷新页面。模型回复不会在此页面正常显示。')
      return false
    }
    if (flow.flowId !== this.flowId) this.source?.close()
    this.flowId = flow.flowId
    return true
  }

  fail(message) {
    this.lastError = message
    this.onError(message)
    return { ok: false, error: message }
  }

  async state(flowId = this.flowId) {
    try {
      const response = await fetch(`/flow/state?flowId=${encodeURIComponent(flowId ?? '')}`, { signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error('无法读取后台状态，请确认服务已启动并刷新页面')
      const result = await response.json()
      if (result?.protocolVersion !== 1) throw new Error('后台服务与页面版本不兼容，请重启 tutor 服务后刷新页面')
      return result
    } catch (error) {
      this.fail(error.name === 'TimeoutError' ? '连接后台超时，请检查服务后刷新页面' : error.message)
      return null
    }
  }

  connect() {
    this.source?.close()
    if (!this.flowId) return null
    this.source = new EventSource(`/flow/stream?flowId=${encodeURIComponent(this.flowId)}`)
    return this.source
  }

  async request(path, body = {}) {
    try {
      // 在启动模型进程前发现旧服务，避免产生已有回复却收不到的“假等待”。
      if (path === '/flow/start' && !await this.state()) return { ok: false, error: this.lastError }
      if ((path === '/flow/input' || path === '/flow/stop') && !this.flowId) throw new Error('没有可操作的流程，请刷新页面后重试')
      const params = path === '/flow/input' || path === '/flow/stop' ? { ...body, flowId: this.flowId } : body
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(10000) })
      const result = await response.json()
      if (!response.ok || result.ok === false) throw new Error(result.error || '请求失败')
      if (path === '/flow/start' && !this.attach(result)) return { ok: false, error: this.lastError }
      return result
    } catch (error) {
      return this.fail(error.name === 'TimeoutError' ? '后台请求超时，请刷新页面确认流程状态' : error.message)
    }
  }
}
