// 实践视图：终端式交互（跑测试 / 重跑 / 中止），独立页面与单壳共用。
(function () {
  const V = (window.TutorViews = window.TutorViews || {})
  const KIND_LABEL = { new: '需求访谈', assess: '摸底测评', plan: '教学规划', research: '教研', learn: '课堂', exam: '里程碑大考', 'practice-gen': '实践任务生成', practice: '实践' }
  // practice runner 的提示符是内联 `…> `（没有独占一行的 `>` 哨兵），因此这里不走哨兵机制，
  // 而是把 stdout 当终端流原样渲染，靠识别已知提示符切回「就绪」。
  const PROMPT_RE = /回车运行测试|选择任务序号/

  V.practice = function (options) {
    const root = options.root
    const courseId = options.courseId ?? new URLSearchParams(location.search).get('course')
    const nodeId = options.nodeId ?? new URLSearchParams(location.search).get('node') ?? ''
    const navigate = options.navigate ?? ((href) => { location.href = href })
    const onStatus = options.onStatus ?? (() => {})
    const flowClient = options.flowClient ?? new TutorFlowClient((message) => {
      setRunning(false)
      appendLine(String(message), 'no')
    })

    root.innerHTML = `
      <div class="chat-surface">
        <div class="chat-banner" hidden></div>
        <div class="chat-statusrow">
          <span class="busy chat-busy" style="display:none"><span class="dot"></span><span class="chat-busy-text">运行中</span></span>
        </div>
        <div class="chat-log"></div>
        <div class="chat-foot">
          <div class="chat-quick practice-actions">
            <label class="practice-node">知识点
              <select class="practice-select"></select>
            </label>
            <button class="practice-run">运行测试</button>
            <button class="practice-rerun">重跑</button>
            <button class="practice-quit">中止</button>
          </div>
          <div class="chat-opstatus"></div>
          <div class="chat-inputrow">
            <input placeholder="给实践流程输入内容（Enter 发送）" autocomplete="off">
            <button>发送</button>
          </div>
        </div>
      </div>`

    const $log = root.querySelector('.chat-log')
    const $input = root.querySelector('.chat-inputrow input')
    const $send = root.querySelector('.chat-inputrow button')
    const $banner = root.querySelector('.chat-banner')
    const $busy = root.querySelector('.chat-busy')
    const $busyText = root.querySelector('.chat-busy-text')
    const $select = root.querySelector('.practice-select')
    const $run = root.querySelector('.practice-run')
    const $rerun = root.querySelector('.practice-rerun')
    const $quit = root.querySelector('.practice-quit')
    const $inputRow = root.querySelector('.chat-inputrow')

    let wantedNode = nodeId
    let pending = ''
    let term = null
    let running = false
    let canSend = false
    let gateBlocked = false
    let busyTimer = null
    let busySeconds = 0
    let source = null

    const showBanner = (text) => { $banner.hidden = false; $banner.textContent = text }
    const hideBanner = () => { $banner.hidden = true; $banner.textContent = '' }
    const labelFor = (kind, id) => `${KIND_LABEL[kind] || kind}进行中：${id}`

    function ensureTerm() {
      if (!term) { term = document.createElement('div'); term.className = 'term'; $log.appendChild(term) }
      return term
    }

    function appendLine(text, cls) {
      ensureTerm()
      const span = document.createElement('span')
      if (cls) span.className = cls
      span.textContent = text
      term.appendChild(span)
      term.appendChild(document.createTextNode('\n'))
      TutorDom.scrollToEnd($log)
    }

    function renderStreamLine(line) {
      let cls = ''
      if (/^\s*✓/.test(line)) cls = 'ok'
      else if (/^\s*✗/.test(line)) cls = 'no'
      else if (/^【.*】/.test(line)) cls = 'hd'
      appendLine(line, cls)
    }

    function feed(text) {
      pending += text
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        renderStreamLine(pending.slice(0, index))
        pending = pending.slice(index + 1)
      }
      if (PROMPT_RE.test(pending)) {
        renderStreamLine(pending)
        pending = ''
        setRunning(false)
      }
    }

    function updateControls() {
      $run.hidden = !canSend
      $rerun.hidden = !canSend
      $quit.hidden = !(canSend || running)
      $inputRow.hidden = !canSend
    }

    function setRunning(on, label) {
      running = on
      if (busyTimer) { clearInterval(busyTimer); busyTimer = null }
      $input.disabled = on || !canSend
      $send.disabled = on || !canSend
      $run.disabled = on || !canSend
      $rerun.disabled = on || !canSend
      updateControls()
      if (on) {
        busySeconds = 0
        $busyText.textContent = `${label ?? '运行中'}… 0s`
        $busy.style.display = 'inline-flex'
        busyTimer = setInterval(() => {
          busySeconds++
          $busyText.textContent = `${label ?? '运行中'}… ${busySeconds}s`
        }, 1000)
      } else {
        $busy.style.display = 'none'
        if (canSend && !$inputRow.hidden) $input.focus()
      }
      onStatus({ text: label ?? (on ? '运行中' : ''), busy: on })
    }

    function sendLine(line, echo) {
      if (running || !canSend) return
      appendLine(echo ?? `> ${line}`, 'me')
      setRunning(true, '运行测试')
      api('/flow/input', { line }).then((result) => {
        if (!result || result.ok === false) {
          setRunning(false)
          appendLine('（没有进行中的实践，请先从课程列表进入）', 'no')
        }
      })
    }

    async function api(path, body) {
      const result = await flowClient.request(path, body)
      if (path === '/flow/start' && result.ok) startSse()
      return result
    }

    function renderDone() {
      const row = TutorDom.el('<div class="chips"></div>')
      const again = TutorDom.el('<button class="chip">重新进入实践</button>')
      again.addEventListener('click', async () => { $log.innerHTML = ''; term = null; pending = ''; await startPractice() })
      const back = TutorDom.el('<button class="chip">← 课程列表</button>')
      back.addEventListener('click', () => navigate('/'))
      row.appendChild(again); row.appendChild(back); $log.appendChild(row); TutorDom.scrollToEnd($log)
    }

    function renderRetry() {
      const row = TutorDom.el('<div class="chips"></div>')
      const retry = TutorDom.el('<button class="chip">重试生成</button>')
      retry.addEventListener('click', async () => { $log.innerHTML = ''; term = null; pending = ''; await startPracticeGen() })
      const back = TutorDom.el('<button class="chip">← 课程列表</button>')
      back.addEventListener('click', () => navigate('/'))
      row.appendChild(retry); row.appendChild(back); $log.appendChild(row); TutorDom.scrollToEnd($log)
    }

    function renderGenPrompt() {
      $log.innerHTML = ''; term = null
      canSend = false
      updateControls()
      const card = TutorDom.el('<div class="intro"></div>')
      card.appendChild(TutorDom.el('<div>这个知识点还没有实践任务。</div>'))
      card.appendChild(TutorDom.el('<div style="color:var(--muted);margin-top:6px">实践任务通过内容核对后即可开始练习。准备期间会显示进度，失败后可重试。</div>'))
      const btn = TutorDom.el('<button class="big">生成实践任务</button>')
      btn.addEventListener('click', async () => { btn.disabled = true; if (await startPracticeGen()) startSse(); else btn.disabled = false })
      card.appendChild(btn); $log.appendChild(card)
    }

    function renderGatePrompt(raw) {
      $log.innerHTML = ''; term = null
      canSend = false
      setRunning(false)
      $log.appendChild(TutorDom.gateNotice({ courseId, navigate, raw }))
    }

    function handleExit(kind, code) {
      if (pending) { renderStreamLine(pending); pending = '' }
      canSend = false
      setRunning(false)
      if (kind === 'practice-gen') {
        if (code === 0) {
          appendLine('', '')
          appendLine('✓ 实践任务已生成，正在进入练习…', 'ok')
          startPractice()
          return
        }
        onStatus({ text: '生成失败', busy: false })
        appendLine(`—— 生成实践任务失败（code ${code}）——`, 'no')
        if (!gateBlocked) renderRetry()
        return
      }
      onStatus({ text: code === 0 ? '已退出' : '实践结束', busy: false })
      appendLine(`—— 实践进程退出（code ${code}）——`, '')
      if (!gateBlocked) renderDone()
    }

    function startSse() {
      source = flowClient.connect()
      if (!source) return
      source.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'hello') {
          $log.innerHTML = ''; pending = ''; term = null
          gateBlocked = false
          canSend = msg.kind === 'practice' && msg.nodeId === wantedNode && msg.status === 'running'
          updateControls()
          onStatus({ text: msg.courseId ? labelFor(msg.kind, msg.courseId) : '空闲', busy: false })
          return
        }
        if (msg.type === 'out') feed(msg.text)
        else if (msg.type === 'err') {
          if (TutorDom.isContentGateError(msg.text)) {
            gateBlocked = true
            canSend = false
            setRunning(false)
            $log.appendChild(TutorDom.gateNotice({ courseId, navigate, raw: msg.text }))
          } else {
            appendLine(String(msg.text).replace(/\n$/, ''), 'no')
          }
        } else if (msg.type === 'exit') handleExit(msg.kind, msg.code)
        TutorDom.scrollToEnd($log)
      }
      source.onerror = () => {
        canSend = false
        setRunning(false)
        onStatus({ text: '连接中断，重连中…', busy: false })
      }
    }

    async function startPractice() {
      const result = await api('/flow/start', { kind: 'practice', courseId, nodeId: wantedNode })
      if (!result.ok) {
        if (TutorDom.isContentGateError(result.error)) renderGatePrompt(result.error)
        else showBanner(result.error || '开始实践失败')
        return false
      }
      onStatus({ text: `实践进行中：${courseId}`, busy: true })
      hideBanner()
      setRunning(true, '启动中')
      return true
    }

    async function startPracticeGen() {
      const result = await api('/flow/start', { kind: 'practice-gen', courseId, nodeId: wantedNode })
      if (!result.ok) {
        if (TutorDom.isContentGateError(result.error)) renderGatePrompt(result.error)
        else showBanner(result.error || '生成实践任务失败')
        return false
      }
      onStatus({ text: `生成实践任务中：${courseId}`, busy: true })
      hideBanner()
      setRunning(true, '正在生成并核对任务')
      return true
    }

    // 同一门课程同时只能跑一个流程（不同课程可并行）。同门课被别的流程占用时如实说明并给入口。
    function renderFlowMismatch(runningFlow) {
      if (!flowClient.attach(runningFlow)) return
      const runLabel = KIND_LABEL[runningFlow.kind] || runningFlow.kind
      onStatus({ text: `${runLabel}进行中：${runningFlow.courseId}`, busy: false })
      showBanner(`「${runningFlow.courseId}」正在进行${runLabel}${runningFlow.nodeId ? ' · ' + runningFlow.nodeId : ''}。要练习「${courseId} · ${wantedNode}」，请先结束它。`)
      const btn = TutorDom.el('<button style="margin-top:8px;cursor:pointer">结束当前流程并开始实践</button>')
      btn.addEventListener('click', async () => {
        btn.disabled = true
        btn.textContent = '正在结束当前流程…'
        await api('/flow/stop')
        for (let i = 0; i < 40; i++) {
          const state = await flowClient.state()
          if (!state) { btn.disabled = false; return }
          if (!(state.flows ?? []).some((flow) => flow.courseId === runningFlow.courseId)) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        hideBanner()
        if (await enterPractice()) startSse()
        else btn.disabled = false
      })
      $banner.appendChild(document.createElement('br'))
      $banner.appendChild(btn)
    }

    // 有 practice.yaml → 直接练；没有 → 先给「生成实践任务」入口（不擅自烧模型额度）。
    async function enterPractice() {
      let hasPractice = false
      try {
        const course = await TutorRpc('courseStatus', { id: courseId })
        hasPractice = !!(course.nodes.find((node) => node.id === wantedNode)?.practiceCount)
        if (course.contentReady === false && !hasPractice) {
          renderGatePrompt('课程内容未通过审查')
          return false
        }
      } catch (error) {
        showBanner('读取课程状态失败：' + error.message)
        return false
      }
      if (hasPractice) return await startPractice()
      renderGenPrompt()
      return false
    }

    $select.addEventListener('change', () => {
      navigate(options.nodeHref
        ? options.nodeHref(courseId, $select.value)
        : `#/course/${encodeURIComponent(courseId)}/practice/${encodeURIComponent($select.value)}`)
    })
    $run.addEventListener('click', () => sendLine('', '> 〔运行测试〕'))
    $rerun.addEventListener('click', () => sendLine('r', '> r 〔重跑〕'))
    $quit.addEventListener('click', () => { api('/flow/stop') })
    $send.addEventListener('click', () => {
      const value = $input.value.trim()
      if (!value) return
      $input.value = ''
      sendLine(value, `> ${value}`)
    })
    $input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        const value = $input.value.trim()
        if (!value) return
        $input.value = ''
        sendLine(value, `> ${value}`)
      }
    })

    updateControls()

    const ready = (async () => {
      if (!courseId) {
        showBanner('缺少 course 参数——请从课程列表进入实践。')
        return
      }
      const state = await flowClient.state()
      if (!state) return
      const flows = state.flows ?? []
      const act = flows.find((flow) => ['practice', 'practice-gen'].includes(flow.kind) && flow.courseId === courseId)
      const busySameCourse = flows.find((flow) => flow.courseId === courseId && flow !== act)
      const course = await TutorRpc('courseStatus', { id: courseId })
      if (!course.hasPlan) { showBanner('请先完成课程规划，再选择知识点实践。'); return }
      wantedNode ||= (act && act.nodeId) || course.current || course.nodes[0]?.id
      if (!course.nodes.some((node) => node.id === wantedNode)) { showBanner('所选知识点不存在，请从课程列表重新选择。'); return }
      for (const node of course.nodes) {
        const option = document.createElement('option')
        option.value = node.id
        option.textContent = `${node.title || node.id}${node.status === 'mastered' ? '（已掌握，可巩固）' : ''}`
        $select.appendChild(option)
      }
      $select.value = wantedNode
      if (busySameCourse) { renderFlowMismatch(busySameCourse); return }
      const mine = !!act && act.nodeId === wantedNode
      if (act && !mine) { renderFlowMismatch(act); return }
      if (act) {
        if (!flowClient.attach(act)) return
        setRunning(true, act.kind === 'practice-gen' ? '生成任务中' : '加载中')
        startSse()
        return
      }
      if (await enterPractice()) startSse()
    })().catch((error) => showBanner('加载实践失败：' + error.message))

    return {
      ready,
      destroy() {
        if (busyTimer) { clearInterval(busyTimer); busyTimer = null }
        try { source?.close() } catch { /* 已关闭 */ }
      },
    }
  }
})()
