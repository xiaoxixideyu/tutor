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
    phase = ''
  let seen = new Set(),
    timeline = null,
    questionPanel = null,
    profilePanel = null,
    composer = null
  const drafts = new Map(),
    attempts = new Map()
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
    canvas.innerHTML = '<div class="notice error"><h3>暂时没能打开</h3><p>' + esc(error.message) + '</p></div>'
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
    canvas.querySelectorAll('[data-new]').forEach((node) => node.addEventListener('click', () => navigate('#/new')))
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
  function status() {
    const box = canvas.querySelector('#tutor-status')
    if (!box || !current) return
    const busy = current.tutorStatus === 'working' || current.serverBusy === true
    if (busy && !busyStart) busyStart = Date.now()
    if (!busy) busyStart = 0
    box.classList.toggle('busy', busy)
    box.querySelector('.phase').textContent = busy
      ? phase || '导师正在准备下一步'
      : current.tutorStatus === 'failed'
        ? '本轮未完成，进度已保存'
        : current.tutorStatus === 'paused'
          ? '已暂停，随时可以继续'
          : '轮到你了'
    box.querySelector('.elapsed').textContent = busyStart ? Math.floor((Date.now() - busyStart) / 1000) + ' 秒' : ''
    canvas.querySelector('#pause-study').disabled = !busy && current.active?.status !== 'active'
    const send = canvas.querySelector('.send-message')
    if (send) send.disabled = busy
    canvas.querySelectorAll('.quick button').forEach((node) => (node.disabled = busy))
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
      (current.goalSupported ? '完整目标已验证' : current.supported + ' / ' + current.total + ' 项当前目标已验证') +
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
                            '<li>' + esc(criterion.description) + (criterion.critical ? '（关键）' : '') + '</li>',
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
                (hypothesis.status === 'confirmed' ? '已确认的原因' : '待验证：' + esc(hypothesis.nextCheck)) +
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
          esc(event.data.independent ? '本次保留为独立作答证据。' : '本次是练习证据，掌握判断还需要独立验证。') +
          '</small></div>',
      )
    }
    if (node) {
      timeline.appendChild(node)
      while (timeline.children.length > 100) timeline.firstElementChild.remove()
    }
  }
  async function sendTurn(message, intent = 'learn') {
    if (!current || current.tutorStatus === 'working' || current.serverBusy) return
    if (!configured) {
      drawer(true)
      return
    }
    const id = current.id
    const elapsed = activeElapsed()
    try {
      current.tutorStatus = 'working'
      current.serverBusy = true
      status()
      toggleQuestion(true)
      await api('/api/courses/' + id + '/turn', {
        requestId: uid(),
        message,
        intent,
        expectedRevision: current.revision,
        activeMs: elapsed,
      })
      if (questionPanel) {
        questionPanel.dataset.elapsed = '0'
        questionPanel.dataset.started = ''
      }
    } catch (error) {
      toast(error.message)
      await refreshCourse()
    }
  }
  function activeElapsed() {
    const panel = questionPanel
    if (!panel) return 0
    const saved = Number(panel.dataset.elapsed ?? 0)
    return (
      saved + (!document.hidden && panel.dataset.started ? Math.max(0, Date.now() - Number(panel.dataset.started)) : 0)
    )
  }
  function toggleQuestion(disabled) {
    const running = !disabled && current.active?.status === 'active' && !document.hidden
    if (questionPanel) {
      if (!running && questionPanel.dataset.started) {
        questionPanel.dataset.elapsed = String(
          Number(questionPanel.dataset.elapsed ?? 0) + Math.max(0, Date.now() - Number(questionPanel.dataset.started)),
        )
        questionPanel.dataset.started = ''
      } else if (running && !questionPanel.dataset.started) questionPanel.dataset.started = String(Date.now())
    }
    questionPanel
      ?.querySelectorAll('button,input,textarea')
      .forEach((node) => (node.disabled = disabled || current.active?.status !== 'active'))
  }
  function renderQuestion() {
    if (!current || !questionPanel) return
    const active = current.active
    const busy = current.tutorStatus === 'working' || current.serverBusy === true
    if (current.pendingAnswer) {
      const key = 'pending:' + current.pendingAnswer.requestId
      if (questionPanel.dataset.key !== key) {
        questionPanel.dataset.key = key
        questionPanel.innerHTML =
          '<div class="notice"><h3>作答已保存</h3><p>评分尚未完成，恢复会沿用同一份作答。</p></div>'
        questionPanel.firstChild.appendChild(button('恢复评分', () => resume(), true))
      }
      questionPanel.querySelector('button').disabled = busy
      return
    }
    if (!active) {
      const key = 'idle:' + current.tutorStatus
      if (questionPanel.dataset.key !== key) {
        questionPanel.dataset.key = key
        questionPanel.innerHTML =
          '<div class="completed-card"><h3>' +
          esc(
            current.goalSupported
              ? '这个学习目标已经通过验证'
              : current.tutorStatus === 'working'
                ? '导师正在选择下一步'
                : '下一步，继续取得真实能力',
          ) +
          '</h3><p>' +
          esc(current.nextSuggestion?.label ?? '导师会根据刚才的表现继续安排。') +
          '</p></div>'
        questionPanel.firstChild.appendChild(button('继续学习 →', () => sendTurn(''), true))
      }
      questionPanel.querySelector('button').disabled = busy
      return
    }
    if (!active.question) {
      const key = 'explanation:' + active.id + ':' + active.status
      if (questionPanel.dataset.key !== key) {
        questionPanel.dataset.key = key
        questionPanel.dataset.started = String(Date.now())
        questionPanel.innerHTML = '<div class="completed-card"><p>可以说说你的理解，也可以让导师继续安排。</p></div>'
        questionPanel.firstChild.appendChild(
          button(
            active.status === 'paused' ? '恢复这一节 →' : '继续 →',
            () => (active.status === 'paused' ? resume() : sendTurn('')),
            true,
          ),
        )
      }
      questionPanel.querySelector('button').disabled = busy
      return
    }
    const question = active.question,
      key = active.id + ':' + question.id
    if (questionPanel.dataset.key === key) {
      toggleQuestion(busy)
      return
    }
    questionPanel.dataset.key = key
    questionPanel.dataset.elapsed = '0'
    questionPanel.dataset.started = busy ? '' : String(Date.now())
    let saved = drafts.get(key) ?? active.draft?.text ?? ''
    try {
      saved = saved || sessionStorage.getItem('tutor:draft:' + key) || ''
    } catch {}
    questionPanel.innerHTML =
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
    const form = questionPanel.querySelector('form'),
      errorBox = form.querySelector('.question-error')
    let answer = saved
    let draftVersion = active.draft?.version ?? 0,
      saveTimer,
      saveChain = Promise.resolve()
    const courseId = current.id
    function remember(value) {
      answer = value
      drafts.set(key, value)
      try {
        sessionStorage.setItem('tutor:draft:' + key, value)
      } catch {}
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveChain = saveChain
          .catch(() => {})
          .then(async () => {
            const result = await api('/api/courses/' + courseId + '/draft', {
              requestId: uid(),
              activityId: active.id,
              questionId: question.id,
              answer: value,
              draftVersion,
            })
            draftVersion = result.draft.version
          })
          .catch(() => {})
      }, 300)
    }
    if (question.type === 'choice') {
      form.querySelectorAll('.choice').forEach((choice) => {
        choice.classList.toggle('selected', choice.dataset.letter === answer)
        choice.addEventListener('click', () => {
          remember(choice.dataset.letter)
          form.querySelectorAll('.choice').forEach((node) => node.classList.toggle('selected', node === choice))
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
    form.querySelector('.hint-button').addEventListener('click', () => sendTurn('这道题我还没想明白，请给一个提示。'))
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      clearTimeout(saveTimer)
      if (!answer.trim()) {
        errorBox.textContent = '请先完成作答。'
        errorBox.hidden = false
        return
      }
      const previous = attempts.get(key),
        requestId = previous?.answer === answer ? previous.requestId : uid()
      attempts.set(key, { answer, requestId })
      toggleQuestion(true)
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
        drafts.delete(key)
        try {
          sessionStorage.removeItem('tutor:draft:' + key)
        } catch {}
      } catch (error) {
        errorBox.textContent = error.message
        errorBox.hidden = false
        await refreshCourse()
        toggleQuestion(current?.tutorStatus === 'working')
      }
    })
    toggleQuestion(busy)
  }
  async function resume() {
    if (!current) return
    try {
      await api('/api/courses/' + current.id + '/resume', { requestId: uid() })
    } catch (error) {
      toast(error.message)
      await refreshCourse()
    }
  }
  function notices() {
    const container = canvas.querySelector('#study-notices')
    if (!container || !current) return
    container.innerHTML = ''
    if (current.tutorStatus === 'failed') {
      const card = window.TutorDom.el(
        '<div class="notice error"><h3>本轮还没有完成</h3><p>已完成的内容和作答都已保存，可以从断点继续。</p><details><summary>查看具体原因</summary><p>' +
          esc(current.tutorError ?? '') +
          '</p></details></div>',
      )
      card.appendChild(button('恢复本次 →', () => resume(), true))
      if (current.contentFailures.length)
        card.appendChild(
          button('让导师修复', () => sendTurn('请修复最近没有通过内容核对的任务，并继续学习。', 'repair')),
        )
      container.appendChild(card)
    } else if (current.tutorStatus === 'paused') {
      const card = window.TutorDom.el('<div class="notice"><p>已暂停，恢复后沿用原有活动和作答。</p></div>')
      card.appendChild(button('继续这一节 →', () => resume(), true))
      container.appendChild(card)
    }
    for (const proposal of current.proposals) {
      const card = window.TutorDom.el(
        '<div class="proposal-card"><h3>导师建议调整目标</h3><p>' +
          esc(proposal.explanation) +
          '</p><strong>' +
          esc(proposal.goal.text) +
          '</strong><p>每天 ' +
          proposal.goal.dailyMinutes +
          ' 分钟' +
          (proposal.goal.deadline ? ' · ' + esc(proposal.goal.deadline) : '') +
          '</p><div class="proposal-actions"></div></div>',
      )
      for (const [accept, label] of [
        [true, '采用这个建议'],
        [false, '保留原目标'],
      ])
        card.querySelector('.proposal-actions').appendChild(
          button(
            label,
            async () => {
              try {
                await api('/api/courses/' + current.id + '/goal', {
                  requestId: uid(),
                  proposalId: proposal.id,
                  accept,
                  expectedRevision: current.revision,
                })
                await refreshCourse()
                if (accept) sendTurn('请按我接受的目标继续安排。')
              } catch (error) {
                toast(error.message)
                await refreshCourse()
              }
            },
            accept,
          ),
        )
      container.appendChild(card)
    }
  }
  function applySnapshot(value) {
    if (!current || value.course.id !== current.id) return
    current = value.course
    current.serverBusy = !!value.job
    if (value.job && !busyStart) busyStart = Date.now()
    status()
    renderProfile()
    renderQuestion()
    notices()
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
    title.textContent = current.title
    canvas.innerHTML =
      '<div class="learning-head"><div><div class="eyebrow">YOUR LEARNING</div><h1>' +
      esc(current.title) +
      '</h1><div class="goal-summary">' +
      esc(current.goal.text) +
      '</div></div><div class="head-actions"><button id="pause-study">暂停一下</button><button id="refresh-study">重新连接</button></div></div><div class="learning-layout"><section class="study-panel"><div class="toolbar">' +
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
      '</div><div id="tutor-status" class="tutor-status"><span class="status-dot"></span><span class="phase"></span><span class="elapsed"></span></div><div id="study-notices"></div><div class="timeline" id="timeline"></div><div id="question-panel"></div><div class="composer"><textarea id="feedback-input" rows="2" placeholder="说说你的理解、卡住的地方，或者希望怎么学…"></textarea><div class="composer-foot"><div class="quick"><button data-feedback="我有点跟不上，请换个更具体的讲法。">换个讲法</button><button data-feedback="我想先看一个实际例子。">看个例子</button><button data-feedback="我想独立试一次，不要先告诉我答案。">独立试试</button></div><button class="send-message">发送 →</button></div></div></section><aside class="profile-panel" id="profile-panel"></aside></div>'
    timeline = canvas.querySelector('#timeline')
    questionPanel = canvas.querySelector('#question-panel')
    profilePanel = canvas.querySelector('#profile-panel')
    composer = canvas.querySelector('#feedback-input')
    result.events.forEach(appendEvent)
    applySnapshot(result)
    canvas.querySelector('#pause-study').addEventListener('click', async () => {
      try {
        await api('/api/courses/' + id + '/pause', { requestId: uid() })
      } catch (error) {
        toast(error.message)
      }
    })
    canvas.querySelector('#refresh-study').addEventListener('click', () => {
      source?.close()
      loadCourse(id)
    })
    canvas
      .querySelectorAll('[data-intent]')
      .forEach((node) => node.addEventListener('click', () => sendTurn('', node.dataset.intent)))
    canvas
      .querySelectorAll('[data-feedback]')
      .forEach((node) => node.addEventListener('click', () => sendTurn(node.dataset.feedback)))
    function sendFeedback() {
      const message = composer.value.trim()
      if (!message) return
      composer.value = ''
      sendTurn(message)
    }
    canvas.querySelector('.send-message').addEventListener('click', sendFeedback)
    composer.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        sendFeedback()
      }
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
      const indicator = canvas.querySelector('#tutor-status .phase')
      if (indicator) indicator.textContent = '连接正在恢复，学习记录仍在'
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
    questionPanel = null
    profilePanel = null
    composer = null
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
    if (current) toggleQuestion(current.tutorStatus === 'working')
  })
  window.addEventListener('hashchange', route)
  window.addEventListener('beforeunload', () => {
    source?.close()
    clearInterval(timer)
  })
  const ready = refreshNav().then(() => route())
  window.TutorApp = { ready, api, navigate, refresh: route }
})()
