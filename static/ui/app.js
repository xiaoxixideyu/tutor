// 单壳工作区：左栏（课程 / 进行中流程）+ 中间画布（按哈希路由渲染视图）+ 顶部一条状态。
// 视图本身是共享控制器（ui/views/*），独立页面也用同一批控制器，不会出现第二份实现。
(function () {
  const canvas = document.getElementById('app-canvas')
  const titleEl = document.getElementById('app-title')
  const statusEl = document.getElementById('app-status')
  const railCourses = document.getElementById('rail-courses')
  const railFlows = document.getElementById('rail-flows')
  let current = null
  let railTimer = null

  const FLOW_LABEL = { new: '访谈', assess: '摸底', plan: '计划', research: '教研', learn: '课堂', exam: '大考', 'practice-gen': '实践生成', practice: '实践', 'audit-content': '内容审查' }
  // 画布内可直接承载的流程；其余情况回落到单壳的对应路由，避免死胡同。
  const LEGACY = {
    'practice-gen': (courseId, node) => `#/course/${encodeURIComponent(courseId)}/practice${node ? `/${encodeURIComponent(node)}` : ''}`,
  }

  function navigate(href) {
    if (!href) return
    location.hash = href.replace(/^#/, '')
  }

  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, '')
    const parts = hash.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
    if (parts.length === 0) return { view: 'home' }
    if (parts[0] === 'settings') return { view: 'settings' }
    if (parts[0] === 'new') return { view: 'new' }
    if (parts[0] === 'course' && parts[1]) {
      return {
        view: parts[2] ?? 'detail',
        courseId: parts[1],
        milestone: parts[3],
        node: parts[4],
        flowId: new URLSearchParams(location.search).get('flowId'),
      }
    }
    return { view: 'home' }
  }

  // 画布内的看板卡片：与独立看板页的 section 观感一致。
  function panel() {
    const section = document.createElement('section')
    section.className = 'home-panel'
    canvas.appendChild(section)
    return section
  }

  function setStatus(text, busy) {
    statusEl.textContent = text ?? ''
    statusEl.classList.toggle('busy', !!busy)
  }

  function destroyCurrent() {
    if (!current) return
    try { current.destroy?.() } catch { /* 视图已卸载 */ }
    current = null
  }

  function mount(route) {
    // 设置是抽屉而不是画布视图：#/settings 直接展开抽屉，画布保持原样。
    if (route.view === 'settings') {
      setDrawer(true)
      return
    }
    destroyCurrent()
    canvas.innerHTML = ''
    setStatus('', false)

    if (route.view === 'home') {
      titleEl.textContent = '工作区'
      current = TutorViews.home({
        root: panel(),
        researchLive: null,
        navigate,
        courseHref: (id) => `#/course/${encodeURIComponent(id)}`,
        lessonHref: (id) => `#/course/${encodeURIComponent(id)}/learn`,
        planHref: (id) => `#/course/${encodeURIComponent(id)}/plan`,
        assessHref: (id) => `#/course/${encodeURIComponent(id)}/assess`,
        practiceHref: (id, node) => `#/course/${encodeURIComponent(id)}/practice${node ? `/${encodeURIComponent(node)}` : ''}`,
        researchHref: (id, node) => `#/course/${encodeURIComponent(id)}/research${node ? `/${encodeURIComponent(node)}` : ''}`,
        auditHref: (id) => `#/course/${encodeURIComponent(id)}/audit-content`,
        reviewHref: (id) => `#/course/${encodeURIComponent(id)}/review`,
        examHref: (id, milestone) => `#/course/${encodeURIComponent(id)}/exam${milestone ? `/${encodeURIComponent(milestone)}` : ''}`,
        flowHref: (flow) => {
          if (flow.kind === 'learn') return `#/course/${encodeURIComponent(flow.courseId)}/learn`
          if (flow.kind === 'exam') return `#/course/${encodeURIComponent(flow.courseId)}/exam`
          if (flow.kind === 'practice' || flow.kind === 'practice-gen') return `#/course/${encodeURIComponent(flow.courseId)}/practice`
          return `#/course/${encodeURIComponent(flow.courseId)}/detail`
        },
      })
      return
    }

    const courseId = route.courseId
    const legacy = LEGACY[route.view]
    if (legacy) {
      // 旧流程仍在独立页面运行：直接跳过去，流程本身不受影响。
      location.href = legacy(courseId, route.node)
      return
    }

    if (route.view === 'detail') {
      titleEl.textContent = courseId
      current = TutorViews.home({
        root: panel(),
        researchLive: null,
        navigate,
        courseId,
        courseHref: (id) => `#/course/${encodeURIComponent(id)}`,
        lessonHref: (id) => `#/course/${encodeURIComponent(id)}/learn`,
        planHref: (id) => `#/course/${encodeURIComponent(id)}/plan`,
        assessHref: (id) => `#/course/${encodeURIComponent(id)}/assess`,
        practiceHref: (id, node) => `#/course/${encodeURIComponent(id)}/practice${node ? `/${encodeURIComponent(node)}` : ''}`,
        researchHref: (id, node) => `#/course/${encodeURIComponent(id)}/research${node ? `/${encodeURIComponent(node)}` : ''}`,
        auditHref: (id) => `#/course/${encodeURIComponent(id)}/audit-content`,
        reviewHref: (id) => `#/course/${encodeURIComponent(id)}/review`,
        examHref: (id, milestone) => `#/course/${encodeURIComponent(id)}/exam${milestone ? `/${encodeURIComponent(milestone)}` : ''}`,
      })
      return
    }

    if (route.view === 'learn') {
      titleEl.textContent = `${courseId} · 课堂`
      current = TutorViews.learn({
        root: canvas,
        courseId,
        onStatus: ({ text, busy }) => setStatus(text, busy),
        onExit: ({ kind }) => { if (kind === 'list') navigate('#/') },
      })
      return
    }

    if (route.view === 'exam') {
      titleEl.textContent = `${courseId} · 大考`
      current = TutorViews.exam({
        root: canvas,
        courseId,
        milestoneId: route.milestone ?? '',
        onStatus: ({ text, busy }) => setStatus(text, busy),
        onExit: ({ kind }) => { if (kind === 'list') navigate('#/') },
      })
      return
    }

    if (route.view === 'practice') {
      titleEl.textContent = `${courseId} · 实践`
      current = TutorViews.practice({
        root: canvas,
        courseId,
        nodeId: route.node ?? '',
        navigate,
        nodeHref: (id, node) => `#/course/${encodeURIComponent(id)}/practice/${encodeURIComponent(node)}`,
        onStatus: ({ text, busy }) => setStatus(text, busy),
      })
      return
    }

    if (route.view === 'review') {
      titleEl.textContent = `${courseId} · 复习`
      current = TutorViews.review({
        root: canvas,
        courseId,
        navigate,
        onStatus: ({ text, busy }) => setStatus(text, busy),
      })
      return
    }

    if (['assess', 'plan', 'research', 'audit-content', 'new'].includes(route.view)) {
      const isNew = route.view === 'new'
      titleEl.textContent = isNew ? '新课程向导' : `${courseId} · 向导`
      current = TutorViews.wizard({
        root: canvas,
        courseId: isNew ? undefined : courseId,
        route: {
          course: isNew ? undefined : courseId,
          resume: route.view,
          node: route.node,
          flowId: route.flowId,
        },
        navigate,
        lessonHref: (id) => `#/course/${encodeURIComponent(id)}/learn`,
        onStatus: ({ text, busy }) => setStatus(text, busy),
      })
      return
    }

    navigate('#/')
  }

  let railCourseList = []

  async function refreshRail() {
    try {
      const [courses, state] = await Promise.all([
        TutorRpc('listCourses'),
        fetch('/flow/state').then((response) => response.json()).catch(() => ({ flows: [] })),
      ])
      const flows = state.flows ?? []
      railCourseList = courses
      const flowByCourse = new Map(flows.map((flow) => [flow.courseId, flow]))
      railCourses.innerHTML = courses.length === 0
        ? '<div class="rail-empty">还没有课程</div>'
        : courses.map((course) => {
            const flow = flowByCourse.get(course.id)
            const badge = course.dueCount ? `<span class="rail-badge due">到期 ${course.dueCount}</span>` : ''
            const running = flow ? `<span class="rail-badge run">${FLOW_LABEL[flow.kind] ?? flow.kind}</span>` : ''
            const progress = course.total > 0 ? Math.round((course.mastered / course.total) * 100) : 0
            return `<a class="rail-item" href="#/course/${encodeURIComponent(course.id)}">
              <span class="rail-item-title">${TutorDom.esc(course.id)}</span>
              <span class="rail-item-meta">${course.mastered}/${course.total}${running}${badge}</span>
              <span class="rail-bar"><i style="width:${progress}%"></i></span>
            </a>`
          }).join('')
      railFlows.innerHTML = flows.length === 0
        ? '<div class="rail-empty">当前没有进行中的流程</div>'
        : flows.map((flow) => `<a class="rail-item" href="#/course/${encodeURIComponent(flow.courseId)}/${flow.kind === 'learn' ? 'learn' : flow.kind === 'exam' ? 'exam' : 'detail'}">
            <span class="rail-item-title">${TutorDom.esc(flow.courseId)}</span>
            <span class="rail-item-meta">${FLOW_LABEL[flow.kind] ?? flow.kind} · ${TutorDom.esc(flow.status)}</span>
          </a>`).join('')
    } catch {
      railCourses.innerHTML = '<div class="rail-empty">课程列表读取失败</div>'
    }
  }

  window.addEventListener('hashchange', () => { mount(parseRoute()) })
  refreshRail()
  railTimer = setInterval(refreshRail, 5000)
  window.addEventListener('beforeunload', () => { if (railTimer) clearInterval(railTimer) })

  // 设置抽屉：与独立设置页共用 static/ui/settings.js 的表单逻辑。
  const drawer = document.getElementById('settingsDrawer')
  const backdrop = document.getElementById('drawerBackdrop')
  let settings = null
  function setDrawer(open) {
    drawer.classList.toggle('open', open)
    backdrop.classList.toggle('open', open)
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true')
    if (open && !settings) {
      settings = window.TutorSettings.mount(document.getElementById('settingsBody'), {
        onSaved: () => refreshRail(),
      })
    }
  }
  document.getElementById('openSettings').addEventListener('click', () => setDrawer(true))
  document.getElementById('openSettingsRail').addEventListener('click', () => setDrawer(true))
  document.getElementById('closeSettings').addEventListener('click', () => setDrawer(false))
  backdrop.addEventListener('click', () => setDrawer(false))
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer.classList.contains('open')) setDrawer(false)
  })

  // 命令面板：跳转课程/视图与常用动作。
  const palette = window.TutorPalette.mount({
    items: () => {
      const items = [
        { title: '课程列表', hint: '工作区首页', run: () => navigate('#/') },
        { title: '模型设置', hint: '渠道与教研搜索', run: () => setDrawer(true) },
        { title: '开设新课程', hint: '需求访谈', run: () => navigate('#/new') },
      ]
      for (const course of railCourseList) {
        const id = course.id
        items.push({ title: `课程 ${id}`, hint: course.goal || '课程详情', run: () => navigate(`#/course/${encodeURIComponent(id)}`) })
        items.push({ title: `课程 ${id} · 上课`, hint: '课堂', run: () => navigate(`#/course/${encodeURIComponent(id)}/learn`) })
        items.push({ title: `课程 ${id} · 复习`, hint: '到期知识点', run: () => navigate(`#/course/${encodeURIComponent(id)}/review`) })
      }
      return items
    },
  })

  // 抽屉与命令面板就绪后再挂载首个视图。
  mount(parseRoute())
})()
