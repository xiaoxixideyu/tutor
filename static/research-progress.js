// 读取已保存课程和已有流程，查看状态不会启动模型或替学员作答。
class TutorResearchProgress {
  constructor(root, onSaved = () => {}) {
    this.root = root
    this.onSaved = onSaved
    this.course = null
    this.flow = null
    this.event = null
    this.progress = null
    this.source = null
    this.pending = ''
    this.refreshing = false
    this.disconnected = false
    root.classList.add('research-live')
    root.innerHTML = '<h2 data-part="heading"></h2><p data-part="counts"></p><progress data-part="bar" max="1" value="0"></progress><p data-part="node"></p><p data-part="message" role="status"></p><p class="research-meta" data-part="time"></p><a data-part="link">查看教研过程 →</a>'
    this.parts = Object.fromEntries([...root.querySelectorAll('[data-part]')].map(part => [part.dataset.part, part]))
    this.poll = setInterval(() => this.refresh(), 10_000)
    this.clock = setInterval(() => this.render(), 1000)
  }

  connect(course) {
    if (this.course === course) return
    this.source?.close()
    this.source = null
    this.course = course
    this.flow = null
    this.event = null
    this.progress = null
    this.pending = ''
    this.root.hidden = true
    if (course) this.refresh()
  }

  async refresh() {
    if (!this.course || this.refreshing) return
    this.refreshing = true
    const course = this.course
    try {
      const [stateResponse, courseResponse] = await Promise.all([
        fetch(`/flow/state?flowId=${encodeURIComponent(this.flow?.flowId ?? '')}`, { signal: AbortSignal.timeout(8000) }),
        fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 'research-status', method: 'courseStatus', params: { id: course } }) }),
      ])
      if (!stateResponse.ok || !courseResponse.ok) throw new Error('状态读取失败')
      const [state, saved] = await Promise.all([stateResponse.json(), courseResponse.json()])
      if (this.course !== course) return
      const previous = this.progress?.completed
      this.progress = saved.result?.research ?? this.progress
      if (previous !== undefined && this.progress?.completed !== previous) this.onSaved(course)
      const flow = state.active?.kind === 'research' && state.active.courseId === course ? state.active : state.flow
      if (flow?.kind === 'research' && flow.courseId === course) {
        if (flow.flowId !== this.flow?.flowId) this.subscribe(flow)
        this.flow = flow
      } else if (this.flow && !state.flow) {
        this.flow = { ...this.flow, status: 'unavailable' }
      }
      this.disconnected = false
      this.render()
    } catch {
      if (this.course === course) { this.disconnected = true; this.render() }
    } finally {
      this.refreshing = false
      if (this.course && this.course !== course) this.refresh()
    }
  }

  subscribe(flow) {
    this.source?.close()
    this.flow = flow
    this.event = null
    this.pending = ''
    const source = this.source = new EventSource(`/flow/stream?flowId=${encodeURIComponent(flow.flowId)}`)
    source.onmessage = ({ data }) => {
      if (source !== this.source) return
      let value
      try { value = JSON.parse(data) } catch { return }
      if (value.flowId !== this.flow?.flowId) return
      this.disconnected = false
      if (value.status) this.flow.status = value.status
      if (value.type === 'out') this.feed(String(value.text ?? ''))
      if (value.type === 'exit') { source.close(); this.refresh() }
      this.render()
    }
    source.onerror = () => {
      if (source === this.source && this.flow?.status === 'running') { this.disconnected = true; this.render() }
    }
  }

  feed(text) {
    this.pending += text
    let end
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end)
      this.pending = this.pending.slice(end + 1)
      if (!line.startsWith('@@tutor-progress ')) continue
      let event
      try { event = JSON.parse(line.slice('@@tutor-progress '.length)) } catch { continue }
      if (!['request', 'waiting', 'retry', 'node', 'saved', 'review'].includes(event.phase)
        || typeof event.message !== 'string' || !Number.isFinite(event.at)) continue
      this.event = event
      // 完成数始终从正式保存的课程读取，不信任日志中的完成数。
      if (event.phase === 'saved') this.refresh()
    }
    if (this.pending.length > 100_000) this.pending = this.pending.slice(-100_000)
  }

  render() {
    const flow = this.flow
    this.root.hidden = !flow
    if (!flow) return
    const p = this.parts, event = this.event, saved = this.progress
    p.heading.textContent = this.disconnected ? '教研状态连接中断，正在重新连接'
      : flow.status === 'running' ? '自动教研进行中' : flow.status === 'stopping' ? '正在停止教研'
        : flow.status === 'completed' ? '本次教研已结束' : '教研已暂停，已保存进度保留'
    p.counts.textContent = saved ? `已保存 ${saved.completed}/${saved.total} 个知识点 · 来源已验证 ${saved.verified} 个 · 待研 ${saved.pending} 个` : '正在读取已保存进度…'
    p.bar.max = Math.max(1, saved?.total ?? 1)
    p.bar.value = saved?.completed ?? 0
    p.node.textContent = event?.node ? `当前知识点：${event.title || event.node}（${event.node}）` : ''
    const active = flow.status === 'running'
    p.message.textContent = active ? event?.message ?? '流程已启动，正在准备教研。' : flow.status === 'completed'
      ? '请按上方已保存数量核对结果；未完成或待交叉验证的内容仍保持原状态。' : '可以查看记录，并从已保存的断点继续。'
    const seconds = event?.retryAt ? Math.max(0, Math.ceil((event.retryAt - Date.now()) / 1000)) : 0
    p.time.textContent = active && event?.retryAt ? `${event.retry ? `第 ${event.retry}/${event.maxRetries} 次恢复 · ` : ''}${seconds ? `约 ${seconds} 秒后尝试继续` : '正在重新检查共享额度'}；等待期间完成数不会增加。`
      : event ? `最近状态更新：${new Date(event.at).toLocaleTimeString()}` : ''
    p.link.href = `/wizard.html?course=${encodeURIComponent(this.course)}&resume=research&flowId=${encodeURIComponent(flow.flowId)}`
  }
}
