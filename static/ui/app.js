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
  // 尚未迁入单壳的流程先走旧页面，避免出现死胡同。
  const LEGACY = {
    practice: (courseId, node) => `/practice.html?course=${encodeURIComponent(courseId)}${node ? `&node=${encodeURIComponent(node)}` : ''}`,
    review: (courseId) => `/review.html?course=${encodeURIComponent(courseId)}`,
    assess: (courseId) => `/wizard.html?course=${encodeURIComponent(courseId)}&resume=assess`,
    plan: (courseId) => `/wizard.html?course=${encodeURIComponent(courseId)}&resume=plan`,
    research: (courseId, node) => `/wizard.html?course=${encodeURIComponent(courseId)}&resume=research${node ? `&node=${encodeURIComponent(node)}` : ''}`,
    'audit-content': (courseId) => `/wizard.html?course=${encodeURIComponent(courseId)}&resume=audit-content`,
  }

  function navigate(href) {
    if (!href) return
    location.hash = href.replace(/^#/, '')
  }

  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, '')
    const parts = hash.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
    if (parts.length === 0) return { view: 'home' }
    if (parts[0] === 'course' && parts[1]) {
      return { view: parts[2] ?? 'detail', courseId: parts[1], milestone: parts[3], node: parts[4] }
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

    navigate('#/')
  }

  async function refreshRail() {
    try {
      const [courses, state] = await Promise.all([
        TutorRpc('listCourses'),
        fetch('/flow/state').then((response) => response.json()).catch(() => ({ flows: [] })),
      ])
      const flows = state.flows ?? []
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
  mount(parseRoute())
  window.addEventListener('beforeunload', () => { if (railTimer) clearInterval(railTimer) })
})()
