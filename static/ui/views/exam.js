// 大考视图：试卷生成 → 作答 → 判分。独立页面与单壳共用同一份流程逻辑。
(function () {
  const V = (window.TutorViews = window.TutorViews || {})
  const KIND_LABEL = { new: '建档访谈', assess: '摸底', plan: '生成计划', research: '教研', learn: '课堂', exam: '大考', 'practice-gen': '生成实践', practice: '实践' }

  V.exam = function (options) {
    const root = options.root
    const courseId = options.courseId ?? new URLSearchParams(location.search).get('course')
    const milestoneId = options.milestoneId ?? new URLSearchParams(location.search).get('milestone') ?? ''
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
          <div class="chat-quick"><button class="chat-stop" hidden>暂停大考</button></div>
          <div class="chat-opstatus"></div>
          <div class="chat-inputrow">
            <textarea rows="1" placeholder="输入你的答案…（Enter 发送）" autocomplete="off"></textarea>
            <button>发送</button>
          </div>
        </div>
      </div>`

    const $log = root.querySelector('.chat-log')
    const $input = root.querySelector('.chat-inputrow input')
    const $send = root.querySelector('.chat-inputrow button')
    const $banner = root.querySelector('.chat-banner')
    const $stop = root.querySelector('.chat-stop')
    let examOutcome = null

    const chat = new TutorChat({
      log: $log,
      input: $input,
      sendButton: $send,
      busyEl: root.querySelector('.chat-busy'),
      busyText: root.querySelector('.chat-busy-text'),
      opStatus: root.querySelector('.chat-opstatus'),
      readyPlaceholder: '轮到你了，输入答案…（Enter 发送）',
      flowFinished: false,
      onSend: (line) => api('/flow/input', { line }),
      onLine: (line) => {
        if (/^大考成绩：.*（通过）/.test(line)) examOutcome = 'passed'
        else if (/^大考成绩：.*（未过/.test(line)) examOutcome = 'failed'
        else if (line.startsWith('考试暂停')) examOutcome = 'paused'
      },
    })

    // 暂停也会正常退出，必须根据实际成绩区分通过与尚未完成。
    function renderExamDone() {
      const row = TutorDom.el('<div class="chips"></div>')
      if (examOutcome !== 'passed' && examOutcome !== 'failed') {
        const resume = TutorDom.el('<button class="chip">继续考试</button>')
        resume.addEventListener('click', async () => {
          resume.disabled = true
          if (!await startExam(courseId, milestoneId)) resume.disabled = false
        })
        row.appendChild(resume)
      }
      const back = TutorDom.el('<button class="chip">← 课程列表</button>')
      back.addEventListener('click', () => { options.onExit?.({ kind: 'list' }) })
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
        if (msg.type === 'hello') {
          $log.innerHTML = ''
          chat.reset()
          examOutcome = null
          chat.setFlowFinished(msg.status !== 'running' && msg.status !== 'stopping')
          chat.setBusy(msg.status === 'running', '正在恢复考试')
          onStatus({ text: msg.courseId ? `大考进行中：${msg.courseId}` : '空闲', busy: msg.status === 'running' })
          setStopVisible(msg.status === 'running')
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
          const text = examOutcome === 'passed' ? '大考通过' : examOutcome === 'failed' ? '大考未通过' : '大考暂停，尚未产生成绩'
          onStatus({ text, busy: false })
          $log.appendChild(TutorDom.el(`<div class="sysline">—— 大考进程退出（code ${msg.code}）——</div>`))
          renderExamDone()
          try { source?.close() } catch { /* 已关闭 */ }
          options.onExit?.({ kind: 'done', code: msg.code, outcome: examOutcome })
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
      if (path === '/flow/start' && result.ok) {
        chat.setFlowFinished(false)
        rememberFlow(result)
        startSse()
      }
      return result
    }

    function rememberFlow(flow) {
      const url = new URL(location.href)
      url.searchParams.set('flowId', flow.flowId)
      history.replaceState(null, '', url)
    }

    // 多行输入：Enter 发送，Shift+Enter 换行（一条输入仍是一条消息）。
    chat.bindComposer(() => $input.value.trim())

    $stop?.addEventListener('click', () => { api('/flow/stop') })
    $send.addEventListener('click', () => {
      const line = $input.value.trim()
      if (!line) return
      $input.value = ''
      chat.sendLine(line)
    })

    // 起一场大考：milestone 可空——为空时 exam-runner 自选下一个可考里程碑。
    async function startExam(targetCourse, targetMilestone) {
      const result = await api('/flow/start', { kind: 'exam', courseId: targetCourse, milestoneId: targetMilestone })
      if (!result.ok) {
        $banner.hidden = false
        $banner.textContent = result.error || '开始大考失败'
        return false
      }
      onStatus({ text: `大考进行中：${targetCourse}`, busy: true })
      $banner.hidden = true
      chat.setBusy(true, '正在生成并核对试卷')
      return true
    }

    // 同一门课程同时只能跑一个流程（不同课程可并行）。同门课被别的流程占用时如实说明并给切换入口。
    function renderFlowMismatch(running) {
      if (!flowClient.attach(running)) return
      const runLabel = KIND_LABEL[running.kind] || running.kind
      onStatus({ text: `${runLabel}进行中：${running.courseId}`, busy: false })
      $banner.hidden = false
      $banner.textContent = ''
      $banner.appendChild(document.createTextNode(
        `「${running.courseId}」正在进行${runLabel}——同一门课程同时只能跑一个流程。要开始「${courseId}」的大考，得先结束它（进度已存，随时能回来续上）。`))
      const btn = TutorDom.el('<button style="margin-top:8px;cursor:pointer">结束当前流程并开始大考</button>')
      btn.addEventListener('click', async () => {
        btn.disabled = true
        btn.textContent = '正在结束当前流程…'
        await api('/flow/stop')
        for (let i = 0; i < 40; i++) {
          const s = await flowClient.state()
          if (!s) { btn.disabled = false; return }
          if (!(s.flows ?? []).some((flow) => flow.courseId === running.courseId)) break
          await new Promise((r) => setTimeout(r, 500))
        }
        if (await startExam(courseId, milestoneId)) startSse()
        else btn.disabled = false
      })
      $banner.appendChild(document.createElement('br'))
      $banner.appendChild(btn)
    }

    const ready = (async () => {
      if (!courseId) {
        $banner.hidden = false
        $banner.textContent = '缺少 course 参数——请从课程列表点「参加大考」进入。'
        startSse()
        return
      }
      const params = new URLSearchParams(location.search)
      const state = await flowClient.state(params.get('flowId'))
      if (!state) return
      if (state.flow && state.flow.kind === 'exam' && state.flow.courseId === courseId
        && (!milestoneId || state.flow.milestoneId === milestoneId)) {
        if (!flowClient.attach(state.flow)) return
        rememberFlow(state.flow)
        chat.setBusy(state.flow.status === 'running', '正在恢复考试')
        startSse()
        return
      }
      const flows = state.flows ?? []
      const matched = flows.find((flow) => flow.kind === 'exam' && flow.courseId === courseId
        && (!milestoneId || flow.milestoneId === milestoneId))
      if (matched) {
        if (!flowClient.attach(matched)) return
        rememberFlow(matched)
        onStatus({ text: `大考进行中：${matched.courseId}`, busy: true })
        startSse()
        return
      }
      // 同课程被别的流程占用才提示切换；其他课程的并行流程与本页无关。
      const busySameCourse = flows.find((flow) => flow.courseId === courseId)
      if (busySameCourse) {
        renderFlowMismatch(busySameCourse)
        return
      }
      if (params.has('flowId')) {
        chat.setFlowFinished(true)
        chat.setBusy(false)
        onStatus({ text: '考试回放已过期', busy: false })
        $log.appendChild(TutorDom.el('<div class="sysline">可从已保存的试卷和作答继续考试，或返回课程列表查看结果。</div>'))
        renderExamDone()
        return
      }
      await startExam(courseId, milestoneId)
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
