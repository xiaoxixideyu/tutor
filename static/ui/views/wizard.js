// 向导视图：访谈建档 / 联网教研 / 摸底测评 / 教学计划 / 内容重审 的分步流程。
// 独立页面与单壳共用同一份流程逻辑。
(function () {
  const V = (window.TutorViews = window.TutorViews || {})
  const STEP_TITLES = { new: '需求访谈', assess: '摸底测评', plan: '教学计划', research: '联网教研', learn: '课堂', 'audit-content': '内容审查' }
  const WIZARD_KINDS = ['new', 'assess', 'plan', 'research', 'audit-content']
  // 旧会话回放可能仍带成本行：静默丢弃，不向学员展示任何开销。
  const LEGACY_COST_RE = /^(本回合|会话累计|审查开销|备课开销|知识地图生成开销|该知识点出题开销|本次流程总成本|复用同一内容的.*费用)/
  // 只有真正需要用户处理的才算"错误"；限流等待、内部核查等一律进安静状态条，避免刷屏。
  const FAILURE_RE = /(不存在|未完成|失败|无法|不支持|非法|中断|预算|未通过|拦截|缺少|请先)/
  // 引擎内部运行提示（限流等待、生成与审查进度等）——不进对话流，只在状态条/进度面板里显示。
  const OP_OUT_RE = /^(?:tutor:\s*)?(等待渠道额度|渠道暂时|渠道临时错误后的重试等待|重新检查共享额度|按共享队列.*排队|约 \d+ 秒后|正在备课[：:]|备课完成|正在从可用的已审查内容恢复课堂|复用同一内容的|正在核对.*范围与正确性|[^\n]{0,12}核查中[：:]|资料审查达到|正在构思知识地图骨架|正在生成知识地图|知识地图就绪|正在生成摸底题库[：:]|正在设计|正在生成试卷|正在生成并核对|正在汇总本知识点|正在核对本知识点|检索资料（|读取来源正文（|第 \d+\/\d+ 个知识点教研中)/
  const cleanOp = (text) => String(text ?? '').replace(/^tutor:\s*/, '').replace(/\s*；已保存的教研进度保留。?\s*$/, '').trim()

  V.wizard = function (options) {
    const root = options.root
    const navigate = options.navigate ?? ((href) => { location.href = href })
    const onStatus = options.onStatus ?? (() => {})
    const flowClient = options.flowClient ?? new TutorFlowClient((message) => {
      setBusy(false)
      $log.appendChild(TutorDom.el(`<div class="errline">${TutorDom.esc(message)}</div>`))
    })

    root.innerHTML = `
      <div class="wizard">
        <div class="wizard-steps" style="display:none">
          <span class="step" data-step="new">1 访谈建档</span> →
          <span class="step" data-step="research">联网教研（可选）</span> →
          <span class="step" data-step="assess">摸底测评</span> →
          <span class="step" data-step="plan">教学计划</span> →
          <span class="step" data-step="learn">上课</span>
          <button class="goto" data-role="goto" style="display:none">进入课堂 →</button>
          <button class="goto" data-role="research" style="display:none">先联网教研（官方来源）</button>
        </div>
        <section class="wizard-research" hidden></section>
        <div class="wizard-log"></div>
        <div class="wizard-setup">
          <h2>开设新课程</h2>
          <p>导师会先做需求访谈（几个问题），随后引导摸底与计划，全部在这里完成。</p>
          <label>课程标识（小写英文/数字/连字符，如 python、english-writing）</label>
          <input placeholder="python" autocomplete="off">
          <div class="err"></div>
          <button class="primary">开始访谈</button>
        </div>
        <div class="wizard-foot" style="display:none">
          <div class="opstatus"></div>
          <div class="wizard-inputrow">
            <input placeholder="输入你的回答…（Enter 发送）" autocomplete="off">
            <button>发送</button>
          </div>
        </div>
      </div>`

    const $log = root.querySelector('.wizard-log')
    const $input = root.querySelector('.wizard-inputrow input')
    const $send = root.querySelector('.wizard-inputrow button')
    const $setup = root.querySelector('.wizard-setup')
    const $footer = root.querySelector('.wizard-foot')
    const $steps = root.querySelector('.wizard-steps')
    const $courseInput = root.querySelector('.wizard-setup input')
    const $err = root.querySelector('.wizard-setup .err')
    const $startBtn = root.querySelector('.wizard-setup .primary')
    const $gotoBtn = root.querySelector('[data-role="goto"]')
    const $researchBtn = root.querySelector('[data-role="research"]')
    const $opStatus = root.querySelector('.opstatus')
    const $researchRoot = root.querySelector('.wizard-research')
    const researchLive = options.researchLive ?? new TutorResearchProgress($researchRoot)

    let chipsMulti = false
    let chipSelection = []
    let chipsAnswered = false
    let currentKind = null
    let courseName = options.courseId ?? null
    let currentNodeId = ''
    let busy = false
    let busyTimer = null
    let busySeconds = 0
    let pending = ''
    let bubble = null
    let bubbleText = ''
    let source = null

    function scrollToEnd() { TutorDom.scrollToEnd($log) }

    function setBusy(on, label) {
      busy = on
      if (busyTimer) { clearInterval(busyTimer); busyTimer = null }
      $input.disabled = on
      if ($send) $send.disabled = on
      if (on) {
        busySeconds = 0
        onStatus({ text: label ?? '等待模型回复', busy: true })
        busyTimer = setInterval(() => {
          busySeconds++
          onStatus({ text: `${label ?? '等待模型回复'}… ${busySeconds}s`, busy: true })
        }, 1000)
      } else {
        onStatus({ text: onStatusText ?? '', busy: false })
        $input.placeholder = '轮到你了，输入回答…（Enter 发送）'
        if ($footer.style.display !== 'none') $input.focus()
      }
    }
    let onStatusText = ''

    function noteOp(text) {
      const value = cleanOp(text)
      if (!value) return
      $opStatus.textContent = '⏳ ' + value
      $opStatus.style.display = 'block'
    }

    function clearOp() {
      $opStatus.textContent = ''
      $opStatus.style.display = 'none'
    }

    // 引擎文本分流：返回 true 表示已归入状态条/里程碑或已静默丢弃，不再进对话流。
    function routeEngineLine(text) {
      const trimmed = String(text ?? '').trim()
      if (trimmed.startsWith('@@tutor-progress ')) return true
      if (LEGACY_COST_RE.test(trimmed)) return true
      if (/^内容审查[^：]*：/.test(trimmed)) {
        if (/拦截|未完成/.test(trimmed)) {
          closeBubble()
          $log.appendChild(TutorDom.el(`<div class="milestone warn">⚠ ${TutorDom.esc(cleanOp(trimmed))}</div>`))
          scrollToEnd()
        } else noteOp(trimmed)
        return true
      }
      if (/已保存：来源|本次教研已保存/.test(trimmed)) {
        closeBubble()
        $log.appendChild(TutorDom.el(`<div class="milestone">✓ ${TutorDom.esc(cleanOp(trimmed))}</div>`))
        scrollToEnd()
        return true
      }
      if (OP_OUT_RE.test(trimmed)) { noteOp(trimmed); return true }
      if (/^tutor:/.test(trimmed) && !FAILURE_RE.test(trimmed)) { noteOp(trimmed); return true }
      return false
    }

    function renderBubble() {
      if (!bubble || !bubbleText) return
      bubble.innerHTML = window.TutorMd.toHtml(bubbleText)
    }

    function closeBubble() {
      if (bubble) renderBubble()
      const text = bubbleText
      bubble = null
      bubbleText = ''
      return text
    }

    function optionLinesOf(text) {
      const out = []
      for (const line of text.split('\n')) {
        const match = line.match(/^\s*([A-Fa-f])[.、．]\s*(\S.*)$/)
        if (match) out.push({ letter: match[1].toUpperCase(), label: match[2].trim() })
      }
      return out
    }

    function maybeChips(text) {
      const options = optionLinesOf(text)
      if (options.length < 2 || options.length > 6) return
      const letters = options.map((option) => option.letter)
      const expects = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, letters.length)
      if (letters.join('') !== expects.join('')) return
      const multi = /可多选|可多選|多选题|（多选）|\(多选\)/.test(text)
      const container = TutorDom.el('<div class="chips"></div>')
      chipsMulti = multi
      chipSelection = []
      chipsAnswered = false
      if (multi) container.appendChild(TutorDom.el('<span class="hint">可多选，选完点「提交选择」</span>'))
      for (const option of options) {
        const chip = TutorDom.el(`<button class="chip">${TutorDom.esc(option.letter)}. ${TutorDom.esc(option.label)}</button>`)
        chip.addEventListener('click', () => {
          if (chipsAnswered) return
          if (multi) {
            const index = chipSelection.indexOf(option.letter)
            if (index >= 0) chipSelection.splice(index, 1)
            else chipSelection.push(option.letter)
            chip.classList.toggle('selected')
          } else {
            chipsAnswered = true
            for (const other of container.querySelectorAll('.chip')) other.classList.add('disabled')
            chip.classList.add('selected')
            submitChips([option.letter])
          }
        })
        container.appendChild(chip)
      }
      if (multi) {
        const submit = TutorDom.el('<button class="chip">提交选择</button>')
        submit.addEventListener('click', () => {
          if (chipsAnswered || chipSelection.length === 0) return
          chipsAnswered = true
          for (const other of container.querySelectorAll('.chip')) other.classList.add('disabled')
          submitChips(chipSelection)
        })
        container.appendChild(submit)
      }
      $log.appendChild(container)
      $log.scrollTop = $log.scrollHeight
    }

    function submitChips(letters) {
      const line = letters.join('')
      $log.appendChild(TutorDom.el(`<div class="userline">你：${TutorDom.esc(line)}</div>`))
      closeBubble()
      setBusy(true)
      api('/flow/input', { line })
    }

    function handleLine(line) {
      const trimmed = line.trim()
      if (trimmed === '>') {
        const closed = closeBubble()
        if (closed) maybeChips(closed)
        clearOp()
        setBusy(false)
        return
      }
      if (routeEngineLine(line)) return
      if (trimmed === '') return
      if (!bubble) { clearOp(); bubble = TutorDom.el('<div class="tutor"></div>'); $log.appendChild(bubble) }
      bubbleText += (bubbleText ? '\n' : '') + line
      bubble.textContent = bubbleText
      scrollToEnd()
    }

    function feed(text) {
      pending += text
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        handleLine(line)
      }
      if (pending.trim() === '>') { handleLine('>'); pending = '' }
    }

    // 教研决策：把「先联网教研」和「跳过」并排放进对话流。
    function researchDecision(skipKind, skipLabel) {
      const row = TutorDom.el('<div class="chips"></div>')
      const go = TutorDom.el('<button class="chip">先联网教研（官方来源）</button>')
      const skip = TutorDom.el(`<button class="chip">${TutorDom.esc(skipLabel)}</button>`)
      const done = (next) => { row.remove(); $researchBtn.style.display = 'none'; startFlow(next) }
      go.addEventListener('click', () => done('research'))
      skip.addEventListener('click', () => done(skipKind))
      row.appendChild(go)
      row.appendChild(skip)
      $log.appendChild(row)
      scrollToEnd()
    }

    // 单步确认 chip：两个模型步骤之间放一个「下一步 →」按钮，避免自动触发一次模型调用（会花钱）。
    function nextStepChip(kind, label, nodeId = '') {
      const row = TutorDom.el('<div class="chips"></div>')
      const go = TutorDom.el(`<button class="chip">${TutorDom.esc(label)}</button>`)
      go.addEventListener('click', () => { row.remove(); startFlow(kind, nodeId) })
      row.appendChild(go)
      $log.appendChild(row)
      scrollToEnd()
    }

    function markStep(kind, state) {
      for (const step of $steps.querySelectorAll('.step')) {
        if (step.dataset.step === kind) {
          step.classList.toggle('active', state === 'active')
          step.classList.toggle('done', state === 'done')
        }
      }
    }

    function resetSteps() {
      for (const step of $steps.querySelectorAll('.step')) step.classList.remove('active', 'done')
    }

    function busyLabel(kind) {
      return kind === 'assess' ? '准备并核对摸底题目' : kind === 'plan' ? '设计并核对学习计划' : kind === 'research' ? '联网教研进行中'
        : kind === 'audit-content' ? '正在重新审查课程内容' : '等待模型回复'
    }

    function showConsole() {
      researchLive.connect(currentKind === 'research' ? courseName : null)
      $setup.style.display = 'none'
      $steps.style.display = 'flex'
      $footer.style.display = 'block'
      onStatus({ text: `${STEP_TITLES[currentKind] ?? currentKind} · ${courseName}`, busy })
    }

    async function startFlow(kind, nodeId = '') {
      currentKind = kind
      currentNodeId = kind === 'research' ? nodeId : ''
      markStep(kind, 'active')
      onStatusText = `${STEP_TITLES[kind] ?? kind} · ${courseName}`
      $footer.style.display = 'block'
      $setup.style.display = 'none'
      setBusy(true, busyLabel(kind))
      await api('/flow/start', { kind, courseId: courseName, ...(currentNodeId ? { nodeId: currentNodeId } : {}) })
    }

    function rememberFlow(flow) {
      currentNodeId = flow.nodeId || ''
      const url = new URL(location.href)
      url.searchParams.set('course', flow.courseId)
      url.searchParams.set('resume', flow.kind)
      url.searchParams.set('flowId', flow.flowId)
      if (currentNodeId) url.searchParams.set('node', currentNodeId)
      else url.searchParams.delete('node')
      history.replaceState(null, '', url)
    }

    async function api(path, body) {
      const result = await flowClient.request(path, body)
      if (path === '/flow/start' && result.ok) { rememberFlow(result); startSse() }
      return result
    }

    function startSse() {
      source = flowClient.connect()
      if (!source) return
      source.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'hello' && msg.replay === undefined) {
          $log.innerHTML = ''
          pending = ''
          bubble = null
          bubbleText = ''
        }
        if (msg.type === 'hello') {
          currentNodeId = msg.nodeId || ''
          if (msg.kind && msg.kind !== currentKind) {
            currentKind = msg.kind
            courseName = msg.courseId
            showConsole()
          }
          return
        }
        if (msg.type === 'out') feed(msg.text)
        else if (msg.type === 'err') { if (!routeEngineLine(msg.text)) $log.appendChild(TutorDom.el(`<div class="errline">${TutorDom.esc(msg.text)}</div>`)) }
        else if (msg.type === 'exit') {
          feed('')
          renderBubble()
          closeBubble()
          setBusy(false)
          clearOp()
          $footer.style.display = 'none'
          if (msg.kind === 'new' && msg.code === 0) {
            markStep('new', 'done')
            $log.appendChild(TutorDom.el('<div class="sysline">—— 访谈完成。可先联网教研（官方来源、讲授可溯源），或直接进入摸底 ——</div>'))
            researchDecision('assess', '跳过教研，直接摸底 →')
          } else if (msg.kind === 'assess' && msg.code === 0) {
            markStep('assess', 'done')
            $log.appendChild(TutorDom.el('<div class="sysline">—— 摸底完成 ——</div>'))
            $gotoBtn.style.display = 'none'
            nextStepChip('plan', '生成教学计划 →')
          } else if (msg.kind === 'research' && msg.code === 0) {
            if (!currentNodeId) markStep('research', 'done')
            $researchBtn.style.display = 'none'
            $log.appendChild(TutorDom.el('<div class="sysline">—— 本次教研已保存，可继续剩余教研或进入摸底 ——</div>'))
            nextStepChip('research', '继续未完成的教研 →')
            $log.appendChild(TutorDom.el(`<div class="sysline"><a href="/?course=${encodeURIComponent(courseName)}">查看各知识点的资料与验证进度</a></div>`))
            nextStepChip('assess', '开始摸底 →')
          } else if (msg.kind === 'plan' && msg.code === 0) {
            markStep('plan', 'done')
            $log.appendChild(TutorDom.el('<div class="sysline">—— 计划就绪，准备上课 ——</div>'))
            $gotoBtn.style.display = 'inline-block'
          } else if (msg.kind === 'audit-content') {
            const ok = msg.code === 0
            $log.appendChild(TutorDom.el(`<div class="sysline">—— 内容重新审查${ok ? '全部通过' : '完成，仍有未通过条目'}（code ${msg.code}）——</div>`))
            if (ok) {
              markStep('new', 'done'); markStep('plan', 'done')
              $log.appendChild(TutorDom.el('<div class="sysline">内容已通过当前审查，可以开始上课。</div>'))
              nextStepChip('learn', '去上课 →')
            } else {
              $log.appendChild(TutorDom.el(`<div class="sysline"><a href="/?course=${encodeURIComponent(courseName)}">查看未通过的具体问题</a></div>`))
              nextStepChip('audit-content', '重新审查 →')
            }
          } else {
            $log.appendChild(TutorDom.el(`<div class="sysline">—— ${STEP_TITLES[msg.kind] ?? msg.kind} 结束（code ${msg.code}）——</div>`))
            if (msg.code !== 0) {
              nextStepChip(msg.kind, currentNodeId ? '重试本知识点 →' : '从已保存进度重试 →', currentNodeId)
              if (msg.kind === 'research' && currentNodeId) nextStepChip('research', '继续未完成的教研 →')
            }
          }
          scrollToEnd()
        }
      }
      source.onerror = () => { setBusy(false); onStatus({ text: '连接中断，正在重连…', busy: false }) }
    }

    function send() {
      if (busy) return
      const line = $input.value.trim()
      if (!line) return
      $input.value = ''
      $log.appendChild(TutorDom.el(`<div class="userline">你：${TutorDom.esc(line)}</div>`))
      closeBubble()
      setBusy(true)
      // /flow/input 在没有活动流程时返回 409 {ok:false}；此前忽略响应会让「模型思考中」计时器空转不止。
      api('/flow/input', { line })
        .then((result) => {
          if (result && result.ok === false) {
            setBusy(false)
            $log.appendChild(TutorDom.el(`<div class="errline">${TutorDom.esc(result.error ?? '当前没有进行中的流程——请用上方按钮选择「先联网教研」或「跳过」')}</div>`))
            scrollToEnd()
          }
        })
        .catch(() => { setBusy(false); $log.appendChild(TutorDom.el('<div class="errline">发送失败，请重试</div>')) })
    }

    $send.addEventListener('click', send)
    $input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) send() })
    $gotoBtn.addEventListener('click', () => navigate(options.lessonHref
      ? options.lessonHref(courseName)
      : `#/course/${encodeURIComponent(courseName)}/learn`))
    $researchBtn.addEventListener('click', () => startFlow('research'))
    $startBtn.addEventListener('click', async () => {
      const id = $courseInput.value.trim()
      $err.textContent = ''
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
        $err.textContent = '课程标识需为小写英文/数字/连字符'
        return
      }
      const state = await flowClient.state()
      if (!state) return
      const sameCourse = (state.flows ?? []).find((flow) => flow.courseId === id)
      if (sameCourse) {
        $err.textContent = `课程「${id}」已有进行中的流程（${sameCourse.kind}）`
        return
      }
      courseName = id
      $steps.style.display = 'flex'
      resetSteps()
      startFlow('new')
    })

    // 从课程列表「生成计划 / 去摸底」跳进来时的续起：跳过 setup 面板，直接从该步起流程。
    function resumeFrom(kind, course, nodeId) {
      courseName = course
      $setup.style.display = 'none'
      $steps.style.display = 'flex'
      resetSteps()
      const steps = [...$steps.querySelectorAll('.step')].map((step) => step.dataset.step)
      const target = steps.indexOf(kind)
      for (let i = 0; i < target; i++) {
        if (steps[i] === 'research') continue
        markStep(steps[i], 'done')
      }
      startFlow(kind, nodeId)
    }

    // 入口来自单壳的 hash 路由（{ course, resume, node, flowId }），不是查询串。
    const entry = options.route ?? {}
    const entryCourse = entry.course ?? null
    const entryResume = entry.resume ?? null
    const entryNode = entry.resume === 'research' ? (entry.node ?? '') : ''
    const entryFlowId = entry.flowId ?? null
    const ready = flowClient.state(entryFlowId).then((state) => {
      if (!state) return
      const requestedCourse = entryCourse
      const available = state.flow ?? (state.flows ?? []).find((flow) =>
        WIZARD_KINDS.includes(flow.kind) && (!requestedCourse || flow.courseId === requestedCourse))
      if (available) {
        if (!WIZARD_KINDS.includes(available.kind) || (requestedCourse && available.courseId !== requestedCourse)) {
          $err.textContent = `当前流程属于 ${available.kind} ${available.courseId}，请先返回课程列表。`
          return
        }
        if (!flowClient.attach(available)) return
        rememberFlow(available)
        currentKind = available.kind
        courseName = available.courseId
        showConsole()
        markStep(currentKind, 'active')
        setBusy(available.status === 'running', busyLabel(currentKind))
        startSse()
        return
      }
      const course = entryCourse
      const resume = entryResume
      const nodeId = entryNode
      if (nodeId && !/^[a-z0-9][a-z0-9-]*$/.test(nodeId)) {
        $err.textContent = '知识点参数非法'
        return
      }
      if (course && /^[a-z0-9][a-z0-9-]{0,63}$/.test(course) && WIZARD_KINDS.includes(resume)) {
        if (entryFlowId) {
          currentKind = resume; courseName = course; showConsole()
          $footer.style.display = 'none'
          $log.appendChild(TutorDom.el('<div class="sysline">流程回放已过期。可从课程已保存的进度继续。</div>'))
          nextStepChip(resume, '从已保存进度继续 →', nodeId)
        } else resumeFrom(resume, course, nodeId)
      }
      startSse()
    }).catch((error) => { $err.textContent = `加载失败：${error.message}` })

    return {
      ready,
      destroy() { try { source?.close() } catch { /* 已关闭 */ } },
    }
  }
})()
