// 课堂视图：备课 → 讲授 → 小测 → 旧知识回访。独立页面与单壳共用同一份流程逻辑。
(function () {
  const V = (window.TutorViews = window.TutorViews || {})
  const KIND_LABEL = { new: '需求访谈', assess: '摸底测评', plan: '教学规划', research: '教研',
    learn: '课堂', exam: '里程碑大考', 'practice-gen': '实践任务生成', practice: '实践' }

  V.learn = function (options) {
    const root = options.root
    const courseId = options.courseId ?? new URLSearchParams(location.search).get('course')
    const flowClient = options.flowClient ?? new TutorFlowClient((message) => {
      chat.setBusy(false)
      root.querySelector('.chat-log').appendChild(TutorDom.el(`<div class="errline">${TutorDom.esc(message)}</div>`))
    })
    const onStatus = options.onStatus ?? (() => {})
    const setStopVisible = (visible) => { if ($stop) $stop.hidden = !visible }

    root.innerHTML = `
      <div class="chat-surface">
        <div class="chat-banner" hidden></div>
        <div class="chat-statusrow"><span class="busy chat-busy" style="display:none"><span class="dot"></span><span class="chat-busy-text">等待模型回复…</span></span></div>
        <div class="chat-log"></div>
        <div class="chat-foot">
          <div class="chat-quick">
            <button data-cmd="看不懂，换个讲法">换个讲法</button>
            <button data-cmd="给个提示">提示</button>
            <button data-cmd="/quiz">单元小测 /quiz</button>
            <button data-cmd="/check">内容核对 /check</button>
            <button class="chat-stop" hidden>暂停本课</button>
          </div>
          <div class="chat-opstatus"></div>
          <div class="chat-inputrow">
            <input placeholder="输入你的回答…（Enter 发送）" autocomplete="off">
            <button>发送</button>
          </div>
        </div>
      </div>`

    const $log = root.querySelector('.chat-log')
    const $input = root.querySelector('.chat-inputrow input')
    const $send = root.querySelector('.chat-inputrow button')
    const $banner = root.querySelector('.chat-banner')
    const $stop = root.querySelector('.chat-stop')
    let activeCourse = courseId

    const chat = new TutorChat({
      log: $log,
      input: $input,
      sendButton: $send,
      quickButtons: [...root.querySelectorAll('.chat-quick button')],
      busyEl: root.querySelector('.chat-busy'),
      busyText: root.querySelector('.chat-busy-text'),
      opStatus: root.querySelector('.chat-opstatus'),
      readyPlaceholder: '轮到你了，输入回答…（Enter 发送）',
      flowFinished: true,
      onSend: (line) => api('/flow/input', { line }),
    })

    // 上课以 code 0 退出（讲完一节或主动暂停）后的续接：给「继续上课 / 返回课程列表」两个入口，
    // 而不是显示死板的「已结束」。继续＝对同一门课重新起 learn，runner 会从 plan.current 续到下一节。
    function renderLearnContinue(failed = false) {
      const row = TutorDom.el('<div class="chips"></div>')
      const back = TutorDom.el('<button class="chip">← 课程列表</button>')
      back.addEventListener('click', () => { options.onExit?.({ kind: 'list' }) })
      if (activeCourse) {
        const cont = TutorDom.el(`<button class="chip">${failed ? '从已保存进度重试 →' : '继续上课 →'}</button>`)
        cont.addEventListener('click', async () => {
          if (chat.busy) return
          row.remove()
          chat.setBusy(true, '正在准备本课并核对内容')
          const result = await api('/flow/start', { kind: 'learn', courseId: activeCourse })
          if (!result.ok) {
            chat.setBusy(false)
            $log.appendChild(TutorDom.el(`<div class="errline">${TutorDom.esc(result.error || '继续失败')}</div>`))
            return
          }
          onStatus({ text: `课堂进行中：${activeCourse}`, busy: true })
        })
        row.appendChild(cont)
      }
      row.appendChild(back)
      $log.appendChild(row)
      chat.scrollToEnd()
    }

    let source = null
    async function startSse() {
      source = flowClient.connect()
      if (!source) return
      source.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'hello' && msg.replay === undefined) {
          // hello 后紧接重放历史：清空当前视图避免重复
          $log.innerHTML = ''
          chat.reset()
          activeCourse = msg.courseId ?? activeCourse
          chat.setFlowFinished(msg.status !== 'running' && msg.status !== 'stopping')
          chat.setBusy(!chat.flowFinished, '正在恢复课堂')
          onStatus({ text: msg.courseId ? `课堂进行中：${msg.courseId}` : '空闲', busy: !chat.flowFinished })
          setStopVisible(!chat.flowFinished)
          if (!msg.courseId) $banner.hidden = false
          return
        }
        if (msg.type === 'out') chat.feed(msg.text)
        else if (msg.type === 'err') {
          if (chat.isOpError(msg.text)) chat.noteOp(msg.text)
          else $log.appendChild(TutorDom.el(`<div class="errline">${TutorDom.esc(msg.text)}</div>`))
        } else if (msg.type === 'exit') {
          chat.feed('')
          const closed = chat.closeBubble()
          if (closed) chat.maybeChips(closed)
          chat.setFlowFinished(true)
          chat.clearOp()
          chat.setBusy(false)
          setStopVisible(false)
          onStatus({ text: '已结束', busy: false })
          if (msg.kind === 'learn' && msg.code === 0) {
            onStatus({ text: '本节告一段落', busy: false })
            renderLearnContinue()
          } else {
            $log.appendChild(TutorDom.el(`<div class="sysline">—— 课堂进程退出（code ${msg.code}）——</div>`))
            if (msg.kind === 'learn') renderLearnContinue(true)
          }
          options.onExit?.({ kind: 'done', code: msg.code })
        }
        chat.scrollToEnd()
      }
      source.onerror = () => {
        onStatus({ text: '连接中断，重连中…', busy: false })
        chat.setBusy(false)
      }
    }

    async function api(path, body) {
      const result = await flowClient.request(path, body)
      if (path === '/flow/start' && result.ok) { chat.setFlowFinished(false); startSse() }
      return result
    }

    async function findLessonFlow() {
      const state = await flowClient.state()
      if (!state) return undefined
      const flows = state.flows ?? []
      const learnFlows = flows.filter((flow) => flow.kind === 'learn')
      const mine = courseId ? learnFlows.find((flow) => flow.courseId === courseId) : learnFlows[0]
      if (mine) return { flow: mine, busy: null }
      // 同一门课被别的流程占用（同课程互斥）；其他课程的流程与本页无关，可并行运行。
      const busy = courseId ? flows.find((flow) => flow.courseId === courseId) : null
      return { flow: null, busy: busy ?? null }
    }

    function send() {
      if (chat.busy || chat.flowFinished) return
      const line = $input.value.trim()
      if (!line) return
      $input.value = ''
      chat.sendLine(line)
    }

    $stop?.addEventListener('click', () => { api('/flow/stop') })
    $send.addEventListener('click', send)
    $input.addEventListener('keydown', (event) => {
      // isComposing 守卫：中文输入法回车选字时不误发半成品
      if (event.key === 'Enter' && !event.isComposing) send()
    })
    for (const button of root.querySelectorAll('.chat-quick button')) {
      button.addEventListener('click', () => {
        if (chat.busy || chat.flowFinished) return
        chat.sendLine(button.dataset.cmd)
      })
    }

    // 同一门课程同时只能运行一个流程；不同课程的流程可以并行。
    function renderCourseMismatch(runningFlow) {
      if (!flowClient.attach(runningFlow)) return
      const running = runningFlow.courseId
      const kind = KIND_LABEL[runningFlow.kind] || '教学流程'
      onStatus({ text: `${kind}进行中：${running}`, busy: false })
      $banner.hidden = false
      $banner.textContent = ''
      $banner.appendChild(document.createTextNode(
        `「${running}」正在进行${kind}。同一门课程同时只能运行一个流程；开始本课课堂前，需要先结束它。`))
      const btn = TutorDom.el(`<button style="margin-top:8px;cursor:pointer">结束当前流程并开始「${TutorDom.esc(courseId ?? running)}」课堂</button>`)
      btn.addEventListener('click', async () => {
        btn.disabled = true
        btn.textContent = `正在结束${kind}…`
        const stopped = await api('/flow/stop')
        if (!stopped.ok) { btn.disabled = false; btn.textContent = '重试切换'; return }
        // 等旧流程真正结束（该课程的槽位释放）再起新课，否则会撞「已有进行中的流程」
        for (let i = 0; i < 40; i++) {
          const s = await flowClient.state()
          if (!s) { btn.disabled = false; return }
          if (!(s.flows ?? []).some((flow) => flow.courseId === running)) break
          await new Promise((r) => setTimeout(r, 500))
        }
        const result = await api('/flow/start', { kind: 'learn', courseId: courseId ?? running })
        if (!result.ok) { $banner.textContent = result.error || '切换失败'; btn.disabled = false; return }
        $banner.hidden = true
        onStatus({ text: `课堂进行中：${courseId ?? running}`, busy: true })
        chat.setBusy(true, '正在准备本课并核对内容')
        startSse()
      })
      $banner.appendChild(document.createElement('br'))
      $banner.appendChild(btn)
    }

    const ready = (async () => {
      const found = await findLessonFlow()
      if (found === undefined) return
      if (found.flow) {
        if (!flowClient.attach(found.flow)) return
        onStatus({ text: `课堂进行中：${found.flow.courseId}`, busy: true })
        startSse()
        return
      }
      if (found.busy) {
        renderCourseMismatch(found.busy)
        return
      }
      if (courseId) {
        const result = await api('/flow/start', { kind: 'learn', courseId })
        if (result.ok) {
          onStatus({ text: `课堂进行中：${courseId}`, busy: true })
          $banner.hidden = true
          chat.setBusy(true, '正在准备本课并核对内容')
        } else {
          $banner.hidden = false
          $banner.textContent = result.error
        }
        startSse()
        return
      }
      $banner.hidden = false
      $banner.textContent = '当前没有进行中的课堂——去课程列表点「上课」开始。'
      startSse()
    })().catch((error) => {
      $log.appendChild(TutorDom.el(`<div class="errline">${TutorDom.esc(error.message)}</div>`))
    })

    return {
      ready,
      chat,
      destroy() { try { source?.close() } catch { /* 已关闭 */ } },
    }
  }
})()
