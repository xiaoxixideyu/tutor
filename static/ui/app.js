;(function () {
  const canvas = document.getElementById('app-canvas'),
    title = document.getElementById('page-title')
  const rail = document.getElementById('rail'),
    nav = document.getElementById('course-nav')
  const esc = (value) => window.TutorDom.esc(value),
    md = (value) => window.TutorMd.toHtml(value)
  const uid = () => crypto.randomUUID()
  const kinds = {
    explanation: '看懂原理',
    diagnostic: '定位问题',
    practice: '动手练习',
    assessment: '独立检验',
    recall: '回忆巩固',
    transfer: '迁移应用',
  }
  const statuses = { supported: '独立证据已支持', developing: '正在建立能力', needs_evidence: '还需独立验证' }
  let courses = [],
    configured = false,
    current = null,
    source = null,
    routeVersion = 0,
    pendingStart = null,
    settings = null,
    busyStart = 0,
    phase = '',
    requestInFlight = false,
    pauseInFlight = false,
    lastAction = '',
    interactionOverride = '',
    interactionError = ''
  let seen = new Set(),
    timeline = null,
    interactionPanel = null,
    profilePanel = null
  const drafts = new Map(),
    attempts = new Map(),
    draftVersions = new Map(),
    draftQueues = new Map(),
    draftTimers = new Map()
  async function api(path, body, method, timeout = 10000) {
    const response = await fetch(path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    })
    const result = await response.json()
    if (!response.ok || result.ok === false) {
      const error = new Error(result.error?.message ?? result.error ?? '请求失败')
      error.code = result.error?.code
      throw error
    }
    return result
  }
  function toast(message) {
    const node = document.getElementById('toast')
    node.textContent = message
    node.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => (node.hidden = true), 4500)
  }
  function navigate(hash) {
    if (!hash.startsWith('#')) hash = '#' + hash
    if (location.hash === hash) route()
    else location.hash = hash
    rail.classList.remove('open')
  }
  function courseHref(id) {
    return '#/course/' + encodeURIComponent(id)
  }
  function when(date) {
    try {
      return new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }
  function button(label, handler, primary = false) {
    const node = document.createElement('button')
    node.textContent = label
    node.className = primary ? 'primary' : 'secondary'
    node.addEventListener('click', handler)
    return node
  }
  function loading() {
    canvas.innerHTML = '<div class="loading">正在读取学习记录…</div>'
  }
  function failure(error, retry) {
    canvas.innerHTML =
      '<div class="notice error"><h3>暂时没能打开</h3><p>' + esc(error.message) + '</p></div>'
    if (retry) canvas.firstChild.appendChild(button('重试', retry))
  }
  function drawer(open) {
    document.getElementById('drawer-backdrop').hidden = !open
    document.getElementById('settings-drawer').hidden = !open
    if (open && !settings)
      settings = window.TutorSettings.mount(document.getElementById('settings-body'), {
        onSaved: async () => {
          await refreshNav()
          if (current) loadCourse(current.id)
        },
      })
  }
  document.getElementById('open-settings').addEventListener('click', () => drawer(true))
  document.getElementById('top-settings').addEventListener('click', () => drawer(true))
  document.getElementById('close-settings').addEventListener('click', () => drawer(false))
  document.getElementById('drawer-backdrop').addEventListener('click', () => drawer(false))
  document.getElementById('new-course').addEventListener('click', () => navigate('#/new'))
  document.getElementById('toggle-rail').addEventListener('click', () => rail.classList.toggle('open'))
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      drawer(false)
      rail.classList.remove('open')
    }
  })
  async function refreshNav() {
    try {
      const [result, config] = await Promise.all([api('/api/courses'), api('/api/model-config')])
      courses = result.courses
      configured = config.config.configured
      document.getElementById('connection-state').textContent = configured ? '模型已配置' : '模型尚未配置'
      nav.innerHTML = courses.length
        ? courses
            .map(
              (course) =>
                '<a href="' +
                courseHref(course.id) +
                '" class="' +
                (current?.id === course.id ? 'active' : '') +
                '"><strong>' +
                esc(course.title) +
                '</strong><small>' +
                esc(
                  course.tutorStatus === 'working'
                    ? '导师准备中'
                    : (course.active?.title ??
                        (course.total ? '已验证 ' + course.supported + ' 项目标' : '目标已记下')),
                ) +
                '</small></a>',
            )
            .join('')
        : '<small class="rail-caption">从一个真实目标开始</small>'
    } catch {
      document.getElementById('connection-state').textContent = '连接暂时中断'
    }
  }
  function cards(list) {
    if (!list.length)
      return '<div class="empty"><div class="empty-icon">◌</div><h2>从一个真实目标开始</h2><p>告诉导师你想解决什么问题，以及已经会什么。</p><button class="primary" data-new>开始学习 →</button></div>'
    return (
      '<div class="course-grid">' +
      list
        .map((course) => {
          const supported = course.supported ?? 0,
            total = course.total ?? 0,
            pct = total ? Math.round((supported / total) * 100) : 0
          return (
            '<a class="course-card" href="' +
            courseHref(course.id) +
            '"><div class="course-top"><span>' +
            esc(course.deadline ? '目标日期 ' + course.deadline : '按你的节奏') +
            '</span><span class="badge ' +
            (course.active?.status === 'paused' ? 'paused' : '') +
            '">' +
            esc(
              course.goalSupported
                ? '目标已验证'
                : course.tutorStatus === 'working'
                  ? '导师准备中'
                  : course.active?.status === 'paused'
                    ? '可以继续'
                    : '正在学习',
            ) +
            '</span></div><h3>' +
            esc(course.title) +
            '</h3><p>' +
            esc(course.goal ?? course.error ?? '') +
            '</p><div class="course-progress"><i style="width:' +
            pct +
            '%"></i></div><div class="course-bottom"><span>' +
            supported +
            ' / ' +
            total +
            ' 项当前目标已独立验证</span><span>继续 →</span></div></a>'
          )
        })
        .join('') +
      '</div>'
    )
  }
  function bindNew() {
    canvas
      .querySelectorAll('[data-new]')
      .forEach((node) => node.addEventListener('click', () => navigate('#/new')))
  }
  async function today(version) {
    title.textContent = '今天'
    const result = await api('/api/today')
    if (version !== routeVersion) return
    courses = result.courses
    configured = result.configured
    const date = new Date(result.today + 'T12:00:00').toLocaleDateString('zh-CN', {
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    })
    const recommendation = result.recommendation
    canvas.innerHTML =
      '<div class="hero"><div class="eyebrow">' +
      esc(date) +
      '</div><h1>今天，向目标靠近一步。</h1><p>导师会根据你的作答和反馈，选择现在最值得做的一件事。</p><div class="today-meta"><span><strong>' +
      courses.length +
      '</strong>个学习目标</span><span><strong>' +
      Math.round(result.activeMinutes) +
      '</strong>分钟今日已记录投入</span></div></div>' +
      (courses.length
        ? '<div class="time-choice"><label for="today-minutes">今天可用</label><select id="today-minutes"><option value="10">10 分钟</option><option value="20" selected>20 分钟</option><option value="30">30 分钟</option><option value="60">60 分钟</option><option value="120">120 分钟</option></select><button id="replan-today">重新安排</button></div><div class="action-card"><div><div class="label">现在做这一件</div><h2 id="next-label">' +
          esc(recommendation?.label ?? '让导师安排今天') +
          '</h2><p id="next-reason">' +
          esc(recommendation?.reason ?? '结合学习目标、期限和最近表现，为你挑选一个可执行的步骤。') +
          '</p></div><button id="next-go">' +
          (recommendation ? '按这个安排开始 →' : '安排今天 →') +
          '</button></div>'
        : '') +
      '<div class="section-head"><h2>我的学习目标</h2><button data-new>＋ 新目标</button></div>' +
      cards(courses)
    bindNew()
    if (!courses.length) return
    let selected = recommendation
    const go = canvas.querySelector('#next-go'),
      replan = canvas.querySelector('#replan-today')
    async function arrange() {
      go.disabled = true
      replan.disabled = true
      go.textContent = '正在为你安排…'
      try {
        const value = await api(
          '/api/today/recommend',
          { availableMinutes: Number(canvas.querySelector('#today-minutes').value) },
          undefined,
          240000,
        )
        if (version !== routeVersion) return
        selected = value.recommendation
        canvas.querySelector('#next-label').textContent = selected.label
        canvas.querySelector('#next-reason').textContent = selected.reason
        go.textContent = '按这个安排开始 →'
      } catch (error) {
        toast(error.message)
        go.textContent = '再试一次 →'
      } finally {
        go.disabled = false
        replan.disabled = false
      }
    }
    replan.addEventListener('click', () => {
      selected = null
      arrange()
    })
    go.addEventListener('click', () => {
      if (!configured) {
        drawer(true)
        return
      }
      if (!selected) {
        arrange()
        return
      }
      pendingStart = { id: selected.courseId, intent: selected.intent }
      navigate(courseHref(selected.courseId))
    })
  }
  async function courseList(version) {
    title.textContent = '我的课程'
    const result = await api('/api/courses')
    if (version !== routeVersion) return
    courses = result.courses
    canvas.innerHTML =
      '<div class="hero"><div class="eyebrow">MY LEARNING</div><h1>每个目标，都有自己的路径。</h1><p>课程会随你取得的学习证据逐步调整。</p></div><div class="section-head"><h2>' +
      courses.length +
      ' 个学习目标</h2><button data-new>＋ 新目标</button></div>' +
      cards(courses)
    bindNew()
  }
  function createCourse() {
    title.textContent = '开始学习'
    canvas.innerHTML =
      '<div class="hero"><div class="eyebrow">A NEW BEGINNING</div><h1>你想真正学会什么？</h1><p>用自己的话说。导师会围绕这个目标，边教边确认你需要什么。</p></div><form class="form-card" id="goal-form"><label for="new-goal">学习目标</label><textarea id="new-goal" required maxlength="4000" placeholder="例如：我会 Java，想学会 Go 的并发，能独立实现一个安全的 worker pool。"></textarea><div class="form-row"><div><label for="daily-minutes">每天可用时间</label><select id="daily-minutes"><option value="10">10 分钟</option><option value="20" selected>20 分钟</option><option value="30">30 分钟</option><option value="60">60 分钟</option><option value="120">120 分钟</option></select></div><div><label for="goal-deadline">目标日期（可选）</label><input id="goal-deadline" type="date"></div></div><details><summary>补充已有基础和不想学的内容</summary><div class="field"><label for="background">已有基础</label><input id="background" placeholder="例如：有五年后端开发经验"></div><div class="field"><label for="exclusions">暂时不学</label><input id="exclusions" placeholder="用逗号分隔，例如：部署、前端"></div></details><div class="form-actions"><span class="form-hint">从一个合适的小步骤开始</span><button class="primary" type="submit">交给导师 →</button></div><div class="form-error" hidden></div></form>'
    const form = canvas.querySelector('#goal-form'),
      errorBox = form.querySelector('.form-error')
    const courseId = 'course-' + uid()
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const submit = form.querySelector('[type=submit]')
      submit.disabled = true
      errorBox.hidden = true
      try {
        const result = await api('/api/courses', {
          id: courseId,
          goal: form.querySelector('#new-goal').value.trim(),
          dailyMinutes: Number(form.querySelector('#daily-minutes').value),
          deadline: form.querySelector('#goal-deadline').value,
          background: form.querySelector('#background').value,
          exclusions: form
            .querySelector('#exclusions')
            .value.split(/[,，]/)
            .map((value) => value.trim())
            .filter(Boolean),
        })
        pendingStart = { id: result.course.id, intent: 'learn' }
        await refreshNav()
        navigate(courseHref(result.course.id))
      } catch (error) {
        errorBox.textContent = error.message
        errorBox.hidden = false
        submit.disabled = false
      }
    })
  }
  function isBusy() {
    return (
      requestInFlight || pauseInFlight || current?.tutorStatus === 'working' || current?.serverBusy === true
    )
  }
  function placeStatus() {
    const box = canvas.querySelector('#tutor-status'),
      anchor = canvas.querySelector('#tutor-status-anchor')
    if (!box || !anchor || !current) return
    box.classList.remove('floating')
    box.style.left = ''
    box.style.width = ''
    anchor.style.minHeight = ''
    const height = box.offsetHeight,
      rect = anchor.getBoundingClientRect()
    if (isBusy() && (rect.top < 8 || rect.top + height > window.innerHeight - 12)) {
      anchor.style.minHeight = height + 18 + 'px'
      const panel = canvas.querySelector('.study-panel').getBoundingClientRect()
      box.style.left = Math.max(12, panel.left) + 'px'
      box.style.width = Math.min(panel.width, window.innerWidth - Math.max(12, panel.left) - 12) + 'px'
      box.classList.add('floating')
    }
  }
  function status() {
    const box = canvas.querySelector('#tutor-status')
    if (!box || !current) return
    const busy = isBusy()
    if (busy && !busyStart) busyStart = Date.now()
    if (!busy) busyStart = 0
    box.classList.toggle('busy', busy)
    const message = pauseInFlight
      ? '正在暂停，进度会保留…'
      : busy
        ? requestInFlight && current.tutorStatus !== 'working' && !current.serverBusy
          ? '正在确认提交状态…'
          : phase || '导师正在准备下一步'
        : current.interaction?.kind === 'complete'
          ? '本次学习已结束'
          : current.tutorStatus === 'failed'
            ? '本轮未完成，进度已保存'
            : current.tutorStatus === 'paused'
              ? '已暂停，随时可以继续'
              : '轮到你了'
    if (box.querySelector('.phase').textContent !== message) box.querySelector('.phase').textContent = message
    box.querySelector('.elapsed').textContent = busyStart
      ? Math.floor((Date.now() - busyStart) / 1000) + ' 秒'
      : ''
    canvas.querySelector('#pause-study').disabled =
      requestInFlight || pauseInFlight || (!busy && current.active?.status !== 'active')
    canvas.querySelector('#refresh-study').disabled = requestInFlight || pauseInFlight
    const pause = box.querySelector('.pause-processing')
    pause.hidden = !busy
    pause.disabled = requestInFlight || pauseInFlight
    const send = canvas.querySelector('.send-message')
    if (send) {
      send.disabled = busy
      send.textContent = busy
        ? requestInFlight && lastAction === 'message'
          ? '发送中…'
          : '处理中…'
        : (send.dataset.idleLabel ?? '回复导师 →')
      send.setAttribute('aria-busy', String(busy))
    }
    const submit = canvas.querySelector('.submit-answer')
    if (submit) {
      submit.textContent = busy
        ? requestInFlight && lastAction === 'answer'
          ? '提交中…'
          : lastAction === 'answer'
            ? '作答处理中…'
            : '导师处理中…'
        : '提交本次作答 →'
      submit.setAttribute('aria-busy', String(busy))
    }
    canvas.querySelectorAll('.quick button').forEach((node) => (node.disabled = busy))
    canvas.querySelectorAll('[data-intent]').forEach((node) => (node.disabled = busy))
    canvas.querySelectorAll('[data-open-feedback], [data-feedback]').forEach((node) => (node.disabled = busy))
    placeStatus()
  }
  function renderProfile() {
    if (!current || !profilePanel) return
    const groups = new Map()
    for (const skill of current.skills.filter((skill) => skill.required)) {
      if (!groups.has(skill.unit)) groups.set(skill.unit, [])
      groups.get(skill.unit).push(skill)
    }
    profilePanel.innerHTML =
      '<div class="side-card"><h3>当前学习目标</h3><p>' +
      esc(current.goal.text) +
      '</p><p>每天 ' +
      current.goal.dailyMinutes +
      ' 分钟' +
      (current.goal.deadline ? ' · ' + esc(current.goal.deadline) : '') +
      '</p><span class="badge">' +
      (current.goalSupported
        ? '完整目标已验证'
        : current.supported + ' / ' + current.total + ' 项当前目标已验证') +
      '</span></div>' +
      '<div class="side-card"><h3>能力证据</h3>' +
      (current.skills.filter((skill) => skill.required).length
        ? [...groups.entries()]
            .map(
              ([unit, list]) =>
                '<div class="unit-label">' +
                esc(unit) +
                '</div>' +
                list
                  .map(
                    (skill) =>
                      '<div class="skill-row"><div class="skill-title"><span class="skill-dot ' +
                      skill.status +
                      '"></span><span>' +
                      esc(skill.title) +
                      '</span></div><small>' +
                      esc(statuses[skill.status]) +
                      ' · ' +
                      skill.evidenceCount +
                      ' 条作答记录</small><details><summary>查看验证要求</summary><ul>' +
                      skill.criteria
                        .map(
                          (criterion) =>
                            '<li>' +
                            esc(criterion.description) +
                            (criterion.critical ? '（关键）' : '') +
                            '</li>',
                        )
                        .join('') +
                      '</ul>' +
                      skill.eligibility.reasons.map((reason) => '<p>' + esc(reason) + '</p>').join('') +
                      '</details></div>',
                  )
                  .join(''),
            )
            .join('')
        : '<p>导师会按目标逐步确定需要验证的能力。</p>') +
      '</div>' +
      (current.learner.background || current.learner.preferences.length
        ? '<div class="side-card"><h3>你的学习方式</h3><p>' +
          esc(current.learner.background) +
          '</p>' +
          current.learner.preferences.map((value) => '<p>' + esc(value) + '</p>').join('') +
          '</div>'
        : '') +
      (current.hypotheses.some((item) => item.status !== 'resolved')
        ? '<div class="side-card"><h3>导师观察</h3>' +
          current.hypotheses
            .filter((item) => item.status !== 'resolved')
            .slice(-3)
            .map(
              (hypothesis) =>
                '<div class="hypothesis">' +
                esc(hypothesis.description) +
                '<small>' +
                (hypothesis.status === 'confirmed'
                  ? '已确认的原因'
                  : '待验证：' + esc(hypothesis.nextCheck)) +
                '</small></div>',
            )
            .join('') +
          '</div>'
        : '') +
      (current.sources.length
        ? '<div class="side-card"><h3>参考资料</h3>' +
          current.sources
            .map(
              (source) =>
                '<a class="source-link" href="' +
                esc(source.url) +
                '" target="_blank" rel="noopener noreferrer">' +
                esc(source.title) +
                ' ↗</a>',
            )
            .join('') +
          '</div>'
        : '')
  }
  function appendEvent(event) {
    if (!timeline || seen.has(event.seq)) return
    seen.add(event.seq)
    let node = null
    if (event.type === 'learner_feedback' && event.data.text) {
      node = document.createElement('div')
      node.className = 'message user'
      node.textContent = event.data.text
    }
    if (event.type === 'tutor_message' && event.data.text) {
      node = window.TutorDom.el(
        '<div class="message"><div class="message-head"><span class="avatar">t</span><span>导师</span><span>' +
          when(event.at) +
          '</span></div>' +
          md(event.data.text) +
          '</div>',
      )
    }
    if (event.type === 'activity_presented') {
      node = window.TutorDom.el(
        '<div class="message"><div class="message-head"><span class="avatar">t</span><span>' +
          esc(kinds[event.data.kind] ?? '导师') +
          '</span><span>' +
          when(event.at) +
          '</span></div><h3>' +
          esc(event.data.title) +
          '</h3>' +
          md(event.data.body ?? '') +
          (event.data.rationale
            ? '<div class="decision-note">为什么这样安排：' + esc(event.data.rationale) + '</div>'
            : '') +
          '</div>',
      )
    }
    if (event.type === 'answer_graded') {
      const grade = event.data.grade
      node = window.TutorDom.el(
        '<div class="message grade ' +
          (grade.correct ? '' : 'incomplete') +
          '"><div class="grade-head">' +
          (grade.correct ? '✓ 本次要求已满足' : '继续把这个点弄清楚') +
          ' · ' +
          Math.round(grade.score * 100) +
          '%</div>' +
          md(grade.feedback) +
          '<small>' +
          esc(
            event.data.independent ? '本次保留为独立作答证据。' : '本次是练习证据，掌握判断还需要独立验证。',
          ) +
          '</small></div>',
      )
    }
    if (node) {
      timeline.appendChild(node)
      while (timeline.children.length > 100) timeline.firstElementChild.remove()
      placeStatus()
    }
  }
  async function sendTurn(message, intent = 'learn') {
    if (!current || isBusy()) return
    if (!configured) {
      drawer(true)
      return
    }
    const id = current.id
    const elapsed = activeElapsed()
    requestInFlight = true
    lastAction = 'message'
    interactionError = ''
    phase = '正在发送，等待导师处理…'
    try {
      current.tutorStatus = 'working'
      current.serverBusy = true
      renderInteraction()
      status()
      toggleInteraction(true)
      await api('/api/courses/' + id + '/turn', {
        requestId: uid(),
        message,
        intent,
        expectedRevision: current.revision,
        activeMs: elapsed,
      })
      if (current?.id !== id) return false
      if (interactionPanel) {
        interactionPanel.dataset.elapsed = '0'
        interactionPanel.dataset.started = ''
      }
      await refreshCourse()
      return true
    } catch (error) {
      if (current?.id !== id) return false
      interactionError = error.message
      toast(error.message)
      await refreshCourse()
      return false
    } finally {
      if (current?.id === id) {
        requestInFlight = false
        renderInteraction()
        status()
      }
    }
  }
  function activeElapsed() {
    const panel = interactionPanel
    if (!panel) return 0
    const saved = Number(panel.dataset.elapsed ?? 0)
    return (
      saved +
      (!document.hidden && panel.dataset.started
        ? Math.max(0, Date.now() - Number(panel.dataset.started))
        : 0)
    )
  }
  function toggleInteraction(disabled) {
    const running =
      !disabled &&
      ['answer', 'continue'].includes(interactionPanel?.dataset.mode) &&
      current.active?.status === 'active' &&
      !document.hidden
    if (interactionPanel) {
      if (!running && interactionPanel.dataset.started) {
        interactionPanel.dataset.elapsed = String(
          Number(interactionPanel.dataset.elapsed ?? 0) +
            Math.max(0, Date.now() - Number(interactionPanel.dataset.started)),
        )
        interactionPanel.dataset.started = ''
      } else if (running && !interactionPanel.dataset.started)
        interactionPanel.dataset.started = String(Date.now())
    }
    interactionPanel
      ?.querySelectorAll('button,input,textarea')
      .forEach(
        (node) =>
          (node.disabled =
            disabled || (interactionPanel.dataset.mode === 'answer' && current.active?.status !== 'active')),
      )
  }
  function selectedInteraction() {
    if (isBusy()) return { kind: 'waiting' }
    if (interactionOverride === 'feedback') return { kind: 'feedback', key: 'feedback:' + current.id }
    if (current.interaction) return current.interaction
    if (current.pendingAnswer || ['paused', 'failed'].includes(current.tutorStatus))
      return {
        kind: 'resume',
        label: current.pendingAnswer ? '恢复评分' : '继续本次学习',
        message: '从已保存的断点继续。',
      }
    if (current.proposals.length) return { kind: 'proposal', proposalId: current.proposals[0].id }
    if (current.active?.question && current.active.status === 'active') return { kind: 'answer' }
    if (current.goalSupported || current.nextSuggestion)
      return { kind: 'complete', message: '本次学习已结束', nextLabel: current.nextSuggestion?.label }
    return { kind: 'continue', label: current.active ? '看懂了，继续' : '继续学习', intent: 'learn' }
  }
  function renderReply(interaction) {
    const feedback = interaction.kind === 'feedback'
    const key = (feedback ? 'feedback:' : 'reply:') + current.id + ':' + interaction.key
    if (interactionPanel.dataset.key === key) {
      const error = interactionPanel.querySelector('.question-error')
      if (error) {
        error.textContent = interactionError
        error.hidden = !interactionError
      }
      toggleInteraction(false)
      return
    }
    toggleInteraction(true)
    interactionPanel.dataset.key = key
    interactionPanel.dataset.mode = feedback ? 'feedback' : 'reply'
    interactionPanel.innerHTML =
      '<form class="question-card reply-card"><div class="question-meta"><span>' +
      (feedback ? '告诉导师你遇到的问题' : '回复导师') +
      '</span></div>' +
      (interaction.prompt ? '<div class="question-prompt">' + md(interaction.prompt) + '</div>' : '') +
      '<textarea id="feedback-input" class="answer-box" rows="3" placeholder="' +
      (feedback ? '描述卡住的地方，导师会调整当前任务…' : '在这里回答导师的问题…') +
      '"></textarea><div class="question-actions">' +
      (feedback ? '<button type="button" class="cancel-feedback">返回当前任务</button>' : '<span></span>') +
      '<button type="submit" class="primary send-message" data-idle-label="' +
      (feedback ? '发送反馈 →' : '回复导师 →') +
      '">' +
      (feedback ? '发送反馈 →' : '回复导师 →') +
      '</button></div><div class="question-error" hidden></div></form>'
    const form = interactionPanel.querySelector('form'),
      input = form.querySelector('textarea'),
      error = form.querySelector('.question-error')
    const id = current.id
    let value = drafts.get(key) ?? ''
    try {
      value = value || sessionStorage.getItem('tutor:reply:' + key) || ''
    } catch {}
    input.value = value
    error.textContent = interactionError
    error.hidden = !interactionError
    const remember = () => {
      drafts.set(key, input.value)
      try {
        sessionStorage.setItem('tutor:reply:' + key, input.value)
      } catch {}
      interactionError = ''
      error.hidden = true
    }
    input.addEventListener('input', remember)
    if (feedback)
      form.querySelector('.cancel-feedback').addEventListener('click', () => {
        remember()
        interactionOverride = ''
        interactionError = ''
        renderInteraction()
        status()
      })
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (isBusy()) return
      const message = input.value.trim()
      if (!message) {
        interactionError = '请填写你的回复。'
        error.textContent = '请填写你的回复。'
        error.hidden = false
        return
      }
      remember()
      if (await sendTurn(message)) {
        drafts.delete(key)
        try {
          sessionStorage.removeItem('tutor:reply:' + key)
        } catch {}
        if (current?.id === id) {
          interactionOverride = ''
          renderInteraction()
          status()
        }
      }
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        form.requestSubmit()
      }
    })
    toggleInteraction(false)
  }
  function renderProposal(interaction) {
    const proposal = current.proposals.find((item) => item.id === interaction.proposalId)
    if (!proposal) return
    const key = 'proposal:' + proposal.id
    if (interactionPanel.dataset.key === key) return
    toggleInteraction(true)
    interactionPanel.dataset.key = key
    interactionPanel.dataset.mode = 'proposal'
    interactionPanel.innerHTML =
      '<div class="proposal-card"><h3>请确认学习目标</h3>' +
      md(proposal.explanation) +
      '<strong>' +
      esc(proposal.goal.text) +
      '</strong><p>每天 ' +
      proposal.goal.dailyMinutes +
      ' 分钟' +
      (proposal.goal.deadline ? ' · ' + esc(proposal.goal.deadline) : '') +
      '</p><div class="proposal-actions"></div></div>'
    for (const [accept, label] of [
      [true, '采用这个建议'],
      [false, '保留原目标'],
    ])
      interactionPanel.querySelector('.proposal-actions').appendChild(
        button(
          label,
          async () => {
            if (isBusy()) return
            const id = current.id
            requestInFlight = true
            lastAction = 'goal'
            interactionError = ''
            phase = '正在保存目标选择…'
            renderInteraction()
            status()
            let saved = false
            try {
              await api('/api/courses/' + id + '/goal', {
                requestId: uid(),
                proposalId: proposal.id,
                accept,
                expectedRevision: current.revision,
              })
              saved = true
              await refreshCourse()
            } catch (error) {
              interactionError = error.message
              toast(error.message)
              await refreshCourse()
            } finally {
              if (current?.id === id) {
                requestInFlight = false
                renderInteraction()
                status()
              }
            }
            if (saved && current?.id === id)
              sendTurn(accept ? '请按我接受的目标继续安排。' : '保留原目标，请按原目标继续安排。')
          },
          accept,
        ),
      )
  }
  function renderInteraction() {
    if (!current || !interactionPanel) return
    const active = current.active
    const interaction = selectedInteraction(),
      busy = isBusy()
    if (interaction.kind === 'waiting') {
      if (requestInFlight && ['answer', 'reply', 'feedback'].includes(interactionPanel.dataset.mode)) {
        toggleInteraction(true)
        return
      }
      toggleInteraction(true)
      interactionPanel.dataset.key = 'waiting'
      interactionPanel.dataset.mode = 'waiting'
      interactionPanel.innerHTML = ''
      return
    }
    if (interaction.kind === 'reply' || interaction.kind === 'feedback') {
      renderReply(interaction)
      return
    }
    if (interaction.kind === 'proposal') {
      renderProposal(interaction)
      return
    }
    if (interaction.kind !== 'answer') {
      const key =
        interaction.kind +
        ':' +
        (active?.id ?? '') +
        ':' +
        (interaction.label ?? '') +
        ':' +
        (interaction.nextLabel ?? '')
      if (interactionPanel.dataset.key !== key) {
        toggleInteraction(true)
        interactionPanel.dataset.key = key
        interactionPanel.dataset.mode = interaction.kind
        interactionPanel.innerHTML =
          '<div class="completed-card"><h3>' +
          esc(
            interaction.kind === 'complete'
              ? interaction.message
              : interaction.kind === 'resume'
                ? '继续已保存的学习'
                : active
                  ? '准备好后继续'
                  : '开始下一步学习',
          ) +
          '</h3>' +
          (interaction.kind === 'complete' && interaction.nextLabel
            ? '<p>下次安排：' + esc(interaction.nextLabel) + '</p>'
            : interaction.kind === 'resume'
              ? '<p>' + esc(interaction.message) + '</p>'
              : '') +
          (current.tutorStatus === 'failed'
            ? '<details><summary>查看具体原因</summary><p>' + esc(current.tutorError ?? '') + '</p></details>'
            : '') +
          '</div>'
        interactionPanel.firstChild.appendChild(
          button(
            interaction.kind === 'complete' ? '返回首页' : interaction.label,
            () =>
              interaction.kind === 'complete'
                ? navigate('#/')
                : interaction.kind === 'resume'
                  ? resume()
                  : sendTurn('', interaction.intent),
            true,
          ),
        )
      }
      toggleInteraction(false)
      return
    }
    if (!active?.question) return
    const question = active.question,
      key = active.id + ':' + question.id
    if (interactionPanel.dataset.key === key) {
      toggleInteraction(busy)
      return
    }
    interactionPanel.dataset.key = key
    interactionPanel.dataset.mode = 'answer'
    interactionPanel.dataset.elapsed = '0'
    interactionPanel.dataset.started = busy ? '' : String(Date.now())
    let saved = drafts.get(key) ?? active.draft?.text ?? ''
    try {
      saved = saved || sessionStorage.getItem('tutor:draft:' + key) || ''
    } catch {}
    interactionPanel.innerHTML =
      '<form class="question-card" id="answer-form"><div class="question-meta"><span>' +
      esc(kinds[active.kind]) +
      '</span><span>第 ' +
      (active.index + 1) +
      ' / ' +
      active.total +
      ' 题</span></div><div class="question-prompt">' +
      md(question.prompt) +
      '</div>' +
      (question.type === 'choice'
        ? '<div class="choices">' +
          question.choices
            .map(
              (value, index) =>
                '<button type="button" class="choice" data-letter="' +
                String.fromCharCode(65 + index) +
                '"><b>' +
                String.fromCharCode(65 + index) +
                '</b><span>' +
                esc(value) +
                '</span></button>',
            )
            .join('') +
          '</div>'
        : '<textarea class="answer-box ' +
          (question.type === 'code' ? 'code' : '') +
          '" spellcheck="' +
          (question.type === 'code' ? 'false' : 'true') +
          '" placeholder="' +
          (question.type === 'code'
            ? '写出完整程序；输入来自标准输入，结果写到标准输出。'
            : question.type === 'numeric'
              ? '填写一个数值，可以使用分数。'
              : '写出你的理解、推导或方案。') +
          '"></textarea>') +
      '<div class="question-actions"><button type="button" class="hint-button">需要一点提示</button><button class="primary submit-answer" type="submit">提交本次作答 →</button></div><div class="question-error" hidden></div></form>'
    const form = interactionPanel.querySelector('form'),
      errorBox = form.querySelector('.question-error')
    errorBox.textContent = interactionError
    errorBox.hidden = !interactionError
    let answer = saved
    draftVersions.set(key, Math.max(draftVersions.get(key) ?? 0, active.draft?.version ?? 0))
    const courseId = current.id
    function remember(value) {
      answer = value
      interactionError = ''
      errorBox.hidden = true
      drafts.set(key, value)
      try {
        sessionStorage.setItem('tutor:draft:' + key, value)
      } catch {}
      clearTimeout(draftTimers.get(key))
      draftTimers.set(
        key,
        setTimeout(() => {
          const saveChain = (draftQueues.get(key) ?? Promise.resolve())
            .catch(() => {})
            .then(async () => {
              const result = await api('/api/courses/' + courseId + '/draft', {
                requestId: uid(),
                activityId: active.id,
                questionId: question.id,
                answer: value,
                draftVersion: draftVersions.get(key) ?? 0,
              })
              draftVersions.set(key, result.draft.version)
            })
            .catch(() => {})
          draftQueues.set(key, saveChain)
        }, 300),
      )
    }
    if (question.type === 'choice') {
      form.querySelectorAll('.choice').forEach((choice) => {
        choice.classList.toggle('selected', choice.dataset.letter === answer)
        choice.addEventListener('click', () => {
          remember(choice.dataset.letter)
          form
            .querySelectorAll('.choice')
            .forEach((node) => node.classList.toggle('selected', node === choice))
          errorBox.hidden = true
        })
      })
    } else {
      const textarea = form.querySelector('textarea')
      textarea.value = saved || question.starterCode || ''
      answer = textarea.value
      textarea.addEventListener('input', () => remember(textarea.value))
      if (question.type === 'code')
        textarea.addEventListener('keydown', (event) => {
          if (event.key === 'Tab') {
            event.preventDefault()
            const start = textarea.selectionStart,
              end = textarea.selectionEnd
            textarea.setRangeText('  ', start, end, 'end')
            remember(textarea.value)
          }
        })
    }
    form
      .querySelector('.hint-button')
      .addEventListener('click', () => sendTurn('这道题我还没想明白，请给一个提示。'))
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (isBusy()) return
      clearTimeout(draftTimers.get(key))
      draftTimers.delete(key)
      if (!answer.trim()) {
        interactionError = '请先完成作答。'
        errorBox.textContent = '请先完成作答。'
        errorBox.hidden = false
        return
      }
      const previous = attempts.get(key),
        requestId = previous?.answer === answer ? previous.requestId : uid()
      attempts.set(key, { answer, requestId })
      const id = current.id
      requestInFlight = true
      lastAction = 'answer'
      interactionError = ''
      phase = '正在提交作答，等待评阅…'
      current.serverBusy = true
      toggleInteraction(true)
      renderInteraction()
      status()
      errorBox.hidden = true
      try {
        await api('/api/courses/' + current.id + '/answer', {
          requestId,
          activityId: active.id,
          questionId: question.id,
          contentHash: active.contentHash,
          answer,
          expectedRevision: current.revision,
          activeMs: activeElapsed(),
        })
        if (current?.id !== id) return
        drafts.delete(key)
        try {
          sessionStorage.removeItem('tutor:draft:' + key)
        } catch {}
        await refreshCourse()
      } catch (error) {
        if (current?.id !== id) return
        interactionError = error.message
        errorBox.textContent = error.message
        errorBox.hidden = false
        await refreshCourse()
      } finally {
        if (current?.id === id) {
          requestInFlight = false
          renderInteraction()
          status()
        }
      }
    })
    toggleInteraction(busy)
  }
  async function resume() {
    if (!current || isBusy()) return
    const id = current.id
    requestInFlight = true
    lastAction = 'resume'
    interactionError = ''
    phase = '正在恢复本次处理…'
    renderInteraction()
    status()
    try {
      await api('/api/courses/' + current.id + '/resume', { requestId: uid() })
      await refreshCourse()
    } catch (error) {
      toast(error.message)
      await refreshCourse()
    } finally {
      if (current?.id === id) {
        requestInFlight = false
        renderInteraction()
        status()
      }
    }
  }
  async function pauseStudy() {
    if (!current || requestInFlight || pauseInFlight) return
    const id = current.id
    pauseInFlight = true
    phase = '正在暂停，进度会保留…'
    status()
    try {
      await api('/api/courses/' + id + '/pause', { requestId: uid() })
      await refreshCourse()
      if (current?.id === id && current.tutorStatus === 'paused') toast('已暂停，进度已保存。')
    } catch (error) {
      toast(error.message)
    } finally {
      if (current?.id === id) {
        pauseInFlight = false
        renderInteraction()
        status()
      }
    }
  }
  function applySnapshot(value) {
    if (!current || value.course.id !== current.id) return
    if (value.course.revision < current.revision) return
    current = value.course
    current.serverBusy = !!value.job
    if (value.job) phase = value.job.phase
    if (value.job && !busyStart) busyStart = Date.now()
    status()
    renderProfile()
    renderInteraction()
    status()
  }
  async function refreshCourse() {
    if (!current) return
    const id = current.id
    try {
      const result = await api('/api/courses/' + id)
      if (current?.id !== id) return
      result.events.forEach(appendEvent)
      applySnapshot(result)
      refreshNav()
    } catch (error) {
      toast(error.message)
    }
  }
  async function loadCourse(id, version = routeVersion) {
    const result = await api('/api/courses/' + id)
    if (version !== routeVersion) return
    current = result.course
    seen = new Set()
    phase = ''
    busyStart = 0
    requestInFlight = false
    pauseInFlight = false
    lastAction = ''
    interactionOverride = ''
    interactionError = ''
    title.textContent = current.title
    canvas.innerHTML =
      '<div class="learning-head"><div><div class="eyebrow">YOUR LEARNING</div><h1>' +
      esc(current.title) +
      '</h1><div class="goal-summary">' +
      esc(current.goal.text) +
      '</div></div><details class="learning-tools"><summary>更多操作</summary><div class="learning-tool-menu"><button data-open-feedback>告诉导师我卡住了</button><button data-feedback="我有点跟不上，请换个更具体的讲法。">换个讲法</button><button data-feedback="我想先看一个实际例子。">看个例子</button>' +
      [
        ['learn', '继续学习'],
        ['practice', '做个任务'],
        ['assess', '检验能力'],
        ['review', '回顾一下'],
        ['exam', '阶段验收'],
        ['research', '核对资料'],
      ]
        .map(([intent, label]) => '<button data-intent="' + intent + '">' + label + '</button>')
        .join('') +
      '<button id="pause-study">暂停本次学习</button><button id="refresh-study">重新连接</button></div></details></div><div class="learning-layout"><section class="study-panel"><div class="timeline" id="timeline"></div><section class="interaction-surface" aria-label="当前操作"><div id="interaction-panel"></div><div id="tutor-status-anchor"><div id="tutor-status" class="tutor-status"><span class="status-dot" aria-hidden="true"></span><span class="phase" role="status" aria-live="polite"></span><span class="elapsed"></span><button type="button" class="pause-processing" hidden>暂停</button></div></div></section></section><aside class="profile-panel" id="profile-panel"></aside></div>'
    timeline = canvas.querySelector('#timeline')
    interactionPanel = canvas.querySelector('#interaction-panel')
    profilePanel = canvas.querySelector('#profile-panel')
    result.events.forEach(appendEvent)
    applySnapshot(result)
    canvas.querySelector('#pause-study').addEventListener('click', pauseStudy)
    canvas.querySelector('.pause-processing').addEventListener('click', pauseStudy)
    canvas.querySelector('#refresh-study').addEventListener('click', () => {
      source?.close()
      loadCourse(id)
    })
    canvas.querySelectorAll('[data-intent]').forEach((node) =>
      node.addEventListener('click', () => {
        interactionOverride = ''
        canvas.querySelector('.learning-tools').open = false
        sendTurn('', node.dataset.intent)
      }),
    )
    canvas.querySelectorAll('[data-feedback]').forEach((node) =>
      node.addEventListener('click', () => {
        canvas.querySelector('.learning-tools').open = false
        sendTurn(node.dataset.feedback)
      }),
    )
    canvas.querySelector('[data-open-feedback]').addEventListener('click', () => {
      interactionOverride = 'feedback'
      canvas.querySelector('.learning-tools').open = false
      renderInteraction()
      status()
    })
    source?.close()
    const cursor = result.events.at(-1)?.seq ?? -1
    source = new EventSource('/api/courses/' + id + '/stream?after=' + cursor)
    source.onmessage = (event) => {
      if (current?.id !== id) return
      let value
      try {
        value = JSON.parse(event.data)
      } catch {
        return
      }
      if (value.type === 'snapshot') applySnapshot(value)
      else if (value.type === 'operation') {
        phase = value.data.phase
        if (!value.data.running) refreshNav()
        status()
      } else if (value.type === 'history_gap') refreshCourse()
      else {
        appendEvent(value)
        if (value.type === 'tutor_ready' || value.type === 'tutor_failed') refreshNav()
      }
    }
    source.onerror = () => {
      phase = '连接正在恢复，学习记录仍在'
      status()
    }
    refreshNav()
    if (pendingStart?.id === id) {
      const intent = pendingStart.intent
      if (configured) {
        pendingStart = null
        sendTurn('', intent)
      } else toast('目标已保存，请先完成模型设置。')
    }
  }
  async function route() {
    const version = ++routeVersion
    source?.close()
    source = null
    current = null
    timeline = null
    interactionPanel = null
    profilePanel = null
    seen = new Set()
    const hash = location.hash.replace(/^#\/?/, '')
    document
      .querySelectorAll('[data-nav]')
      .forEach((node) =>
        node.classList.toggle('active', node.dataset.nav === (hash === 'courses' ? 'courses' : 'today')),
      )
    loading()
    try {
      if (hash === 'new') {
        createCourse()
        return
      }
      if (hash === 'courses') {
        await courseList(version)
        return
      }
      const match = hash.match(/^course\/([a-z0-9-]+)$/)
      if (match) {
        await loadCourse(match[1], version)
        return
      }
      await today(version)
    } catch (error) {
      if (version === routeVersion) failure(error, () => route())
    }
  }
  const timer = setInterval(status, 1000)
  document.addEventListener('visibilitychange', () => {
    if (current) toggleInteraction(isBusy())
  })
  window.addEventListener('scroll', placeStatus, { passive: true })
  window.addEventListener('resize', placeStatus)
  window.addEventListener('hashchange', route)
  window.addEventListener('beforeunload', () => {
    source?.close()
    clearInterval(timer)
  })
  const ready = refreshNav().then(() => route())
  window.TutorApp = { ready, api, navigate, refresh: route }
})()
