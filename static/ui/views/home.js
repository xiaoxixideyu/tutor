// 看板视图（课程列表 + 课程详情）：单壳与独立页面共用同一份渲染逻辑。
(function () {
  const V = (window.TutorViews = window.TutorViews || {})
  const SYM = { mastered: ['✓', 's-mastered'], learning: ['●', 's-learning'], weak: ['▲', 's-weak'], unknown: ['·', 's-unknown'] }

  // 视图只存在于单壳里：默认链接就是 hash 路由（宿主可再覆盖）。
  function defaultFlowHref(flow) {
    const course = encodeURIComponent(flow.courseId)
    const node = flow.nodeId ? `/${encodeURIComponent(flow.nodeId)}` : ''
    if (flow.kind === 'new') return '#/new'
    if (flow.kind === 'learn') return `#/course/${course}/learn`
    if (flow.kind === 'exam') return `#/course/${course}/exam${flow.milestoneId ? `/${encodeURIComponent(flow.milestoneId)}` : ''}`
    if (flow.kind === 'practice' || flow.kind === 'practice-gen') return `#/course/${course}/practice${node}`
    if (flow.kind === 'research') return `#/course/${course}/research${node}`
    if (flow.kind === 'assess') return `#/course/${course}/assess`
    if (flow.kind === 'plan') return `#/course/${course}/plan`
    if (flow.kind === 'audit-content') return `#/course/${course}/audit-content`
    return `#/course/${course}`
  }

  V.home = function (options) {
    const root = options.root
    const researchLive = options.researchLive ?? null
    const flowHref = options.flowHref ?? defaultFlowHref
    const courseHref = options.courseHref ?? ((id) => `#/course/${encodeURIComponent(id)}`)
    const lessonHref = options.lessonHref ?? ((id) => `#/course/${encodeURIComponent(id)}/learn`)
    const planHref = options.planHref ?? ((id) => `#/course/${encodeURIComponent(id)}/plan`)
    const assessHref = options.assessHref ?? ((id) => `#/course/${encodeURIComponent(id)}/assess`)
    const practiceHref = options.practiceHref ?? ((id, node) => `#/course/${encodeURIComponent(id)}/practice${node ? `/${encodeURIComponent(node)}` : ''}`)
    const researchHref = options.researchHref ?? ((id, node) => `#/course/${encodeURIComponent(id)}/research${node ? `/${encodeURIComponent(node)}` : ''}`)
    const auditHref = options.auditHref ?? ((id) => `#/course/${encodeURIComponent(id)}/audit-content`)
    const reviewHref = options.reviewHref ?? ((id) => `#/course/${encodeURIComponent(id)}/review`)
    const examHref = options.examHref ?? ((id, milestone) => `#/course/${encodeURIComponent(id)}/exam${milestone ? `/${encodeURIComponent(milestone)}` : ''}`)
    const go = options.navigate ?? ((href) => { if (href) location.href = href })

    async function renderList() {
      if (researchLive) researchLive.connect(null)
      const courses = await TutorRpc('listCourses')
      const due = await TutorRpc('dueReviews')
      const state = await fetch('/flow/state').then((response) => response.json()).catch(() => ({ flows: [] }))
      const flowByCourse = new Map((state.flows ?? []).map((flow) => [flow.courseId, flow]))
      const dueById = new Map((due ?? []).map((c) => [c.id, c]))
      const rows = courses.length === 0
        ? '<div class="empty">暂无课程。先在“模型设置”中配置渠道，再点击“开设新课程”。</div>'
        : courses.map((c) => {
            const pct = c.total > 0 ? Math.round((c.mastered / c.total) * 100) : 0
            const dueBadge = c.dueCount ? `<span class="badge">到期 ${c.dueCount}</span>` : ''
            const running = flowByCourse.get(c.id)
            const runningBadge = running ? `<span class="badge run">▶ ${TutorDom.flowLabel(running.kind)}进行中</span>` : ''
            const reviewLine = dueById.has(c.id)
              ? `<div class="meta review-line">待复习：${TutorDom.esc(dueById.get(c.id).due.map((d) => d.node).join('、'))}</div>`
              : ''
            // 内容主闸（地图）未过审：摸底/计划/上课/大考/实践生成都会在门前退出，看板直接给重审入口而不是死路。
            const blocked = !c.error && c.contentReady === false
            const warnLine = blocked
              ? '<div class="meta warn-line">⚠ 教学内容未通过准入审查：摸底、上课、大考与生成实践已暂停（复习不受影响）。</div>'
              : ''
            const errorLine = c.error
              ? `<div class="meta" style="color:#b91c1c">⚠ 课程数据无法读取：${TutorDom.esc(c.error)}</div>`
              : ''
            // CTA 按阶段分流：有计划才进课堂；半成品课导去向导补齐（摸底/计划），不再把用户丢进「缺计划」死路。
            // 全部已掌握且无待学指针：上课只会得到「无课可上」，如实显示完成态并给复习/重测出口。
            const allMastered = !c.error && c.stage === 'ready' && c.total > 0 && c.mastered === c.total && !c.current
            const cta = c.error
              ? null
              : running
                ? { label: `继续${TutorDom.flowLabel(running.kind)} →`, href: flowHref(running) }
                : allMastered
                  ? { label: '✓ 已全部掌握', href: courseHref(c.id) }
                  : blocked
                    ? { label: '重新审查 →', href: auditHref(c.id), warn: true }
                    : c.stage === 'ready'
                      ? { label: '上课 →', href: lessonHref(c.id) }
                      : c.stage === 'need-plan'
                        ? { label: '生成计划 →', href: planHref(c.id) }
                        : { label: '摸底/续测 →', href: assessHref(c.id) }
            const reviewBtn = c.dueCount
              ? `<button class="enter review-btn" data-href="${TutorDom.esc(reviewHref(c.id))}">复习 ${c.dueCount} →</button>`
              : ''
            return `<div class="course" data-id="${TutorDom.esc(c.id)}" data-error="${c.error ? '1' : ''}">
              <div class="row1">
                <span class="id">${TutorDom.esc(c.id)}</span>
                ${runningBadge}${dueBadge}
                <span class="actions">${reviewBtn}${cta ? `<button class="enter${cta.warn ? ' warn' : ''}" data-href="${TutorDom.esc(cta.href)}">${TutorDom.esc(cta.label)}</button>` : ''}</span>
              </div>
              <div class="goal">${TutorDom.esc(c.goal)}</div>
              <div class="bar"><span style="width:${pct}%"></span></div>
              <div class="meta">进度 ${c.mastered}/${c.total} 已掌握${c.current ? ` · 当前 ${TutorDom.esc(c.current)}` : ''}</div>
              ${reviewLine}
              ${warnLine}
              ${errorLine}
            </div>`
          }).join('')
      root.innerHTML = `<h2>课程列表</h2>${rows}`
      for (const row of root.querySelectorAll('.course')) {
        row.addEventListener('click', () => { if (!row.dataset.error) renderStatus(row.dataset.id) })
      }
      for (const btn of root.querySelectorAll('.enter')) {
        btn.addEventListener('click', (event) => {
          event.stopPropagation()
          go(btn.dataset.href)
        })
      }
    }

    async function renderStatus(id) {
      const p = await TutorRpc('courseStatus', { id })
      if (researchLive) researchLive.connect(id)
      // 展开课程详情时拉取"当前内容里哪条没过审"（地图/计划/各节点题库），省得用户去翻 JSON 证据文件。
      const [issues, flowState] = await Promise.all([
        TutorRpc('contentIssues', { id }).catch(() => []),
        fetch('/flow/state').then((response) => response.json()).catch(() => ({ flows: [] })),
      ])
      const running = (flowState.flows ?? []).find((flow) => flow.courseId === id)
      // 学习曲线数据来自事件流（mastery-events.jsonl）；旧课程没有事件流时优雅降级。
      const history = await TutorRpc('masteryHistory', { id, days: 30 }).catch(() => null)
      const maxCount = history ? Math.max(1, ...history.activity.map((d) => d.count)) : 1
      const curveSection = !history || !history.activity.some((d) => d.count > 0)
        ? `<h2 style="margin-top:16px">学习曲线</h2><div class="empty">事件流从本次更新后开始积累：上完一节课、做一次复习或大考后，这里会出现逐日活动与成绩轨迹。</div>`
        : `<h2 style="margin-top:16px">学习曲线（近 ${history.days} 天）</h2>
           <div class="bars">${history.activity.map((d) => `<span class="${d.count === 0 ? 'zero' : ''}" style="height:${d.count === 0 ? 2 : Math.max(4, Math.round((d.count / maxCount) * 42))}px" title="${TutorDom.esc(d.date)} · ${d.count} 次活动${d.count > 0 ? `（${Object.entries(d.kinds).map(([k, v]) => `${k}×${v}`).join('、')}）` : ''}"></span>`).join('')}</div>
           <div class="meta">近 14 天学习 ${history.pace.sessions} 天${history.pace.averageGapDays !== undefined ? `，平均间隔 ${history.pace.averageGapDays} 天` : ''}　（柱=当天活动次数：小测/回访/复习/实践/大考）</div>
           ${history.nodes.length ? `<div class="trail" style="margin-top:8px">${history.nodes.map((n) => `<div class="meta">${TutorDom.esc(n.node)}：${n.points.map((pt) => `<span class="sym ${pt.passed === false ? 's-weak' : 's-mastered'}" title="${TutorDom.esc(pt.at)} · ${TutorDom.esc(pt.kind)} · ${pt.score}">${pt.passed === false ? '✗' : '✓'}</span>`).join('')}</div>`).join('')}</div>` : ''}`
      const KIND_LABEL = { map: '知识地图', bank: '摸底题库', lesson: '教案', plan: '教学计划', teaching: '课堂讲授', exam: '大考', practice: '实践任务' }
      const blocked = p.contentReady === false
      const issueList = issues.length
        ? issues.map((it) => `<div class="meta" style="margin:4px 0">· <strong>${TutorDom.esc(KIND_LABEL[it.kind] ?? it.kind)}${it.node ? '（' + TutorDom.esc(it.node) + '）' : ''}</strong>：${(it.issues || []).map(TutorDom.esc).join('；')}</div>`).join('')
        : '<div class="meta">未找到当前内容对应的拒绝原因，可直接重新审查。</div>'
      const warnSection = blocked
        ? `<div class="notice warn-notice">
            <div class="notice-title">⚠ 教学内容未通过准入审查</div>
            <div class="notice-body">摸底、上课、大考与生成实践已暂停；复习不受影响。内容未修改时重审会复用上次结论，仍需先修复对应内容。</div>
            ${issueList}
            ${running ? '<div class="meta">当前流程结束后才能重新审查。</div>' : `<div class="notice-actions"><button class="enter go-audit" data-href="${TutorDom.esc(auditHref(p.id))}">重新审查 →</button></div>`}
          </div>`
        : issues.length
          ? `<div class="notice warn-notice">
              <div class="notice-title">⚠ 以下内容未通过审查，修复后需重新审查</div>
              ${issueList}
              ${running ? '<div class="meta">当前流程结束后才能重新审查。</div>' : `<div class="notice-actions"><button class="enter go-audit" data-href="${TutorDom.esc(auditHref(p.id))}">重新审查 →</button></div>`}
            </div>`
          : ''
      const nodeRows = p.nodes.map((n) => {
        const [sym, cls] = SYM[n.status] ?? SYM.unknown
        // 记忆保留率估计（有实测锚点时才有）：低于 70% 标橙，提示可能已生锈。
        const retention = n.retention !== undefined
          ? ` <span${n.retention < 0.7 ? ' style="color:#b45309"' : ' class="meta"'}>保留≈${Math.round(n.retention * 100)}%</span>`
          : ''
        // 教研状态：已保存但一条来源都没有的节点如实标"无来源"，避免被读成"教研已完成"。
        const researchLabel = n.researchStatus
          ? n.researchStatus === 'saved' && (n.researchResources ?? 0) === 0
            ? '已保存（无来源）'
            : { pending: '待教研', saved: '已保存 · 待交叉验证', verified: '来源已验证' }[n.researchStatus]
          : ''
        return `<tr>
          <td><span class="sym ${cls}">${sym}</span></td>
          <td>${TutorDom.esc(n.status)}</td><td>${TutorDom.esc(n.id)}</td><td>${TutorDom.esc(n.title ?? '')}</td>
          <td>${n.score !== undefined ? TutorDom.esc(n.score) : ''}</td>
          <td>${n.review_due !== undefined ? `复习→${TutorDom.esc(n.review_due)}${retention}` : ''}</td>
          <td>${n.researchStatus && !running ? `${researchLabel} <button class="enter go-research" data-href="${TutorDom.esc(researchHref(p.id, n.id))}">${n.researchStatus === 'pending' ? '教研' : '补查'}</button>` : researchLabel}</td>
          <td>${p.hasPlan && !running && (n.practiceCount || !blocked) ? `<button class="enter go-practice" data-href="${TutorDom.esc(practiceHref(p.id, n.id))}">${n.practiceCount ? '实践' : '生成实践'}</button>` : ''}</td>
        </tr>`
      }).join('')
      // 里程碑：已通过大考→标「✓ 大考通过」；全部节点已掌握且未通过→给「参加大考」入口；否则显示掌握进度。
      const milestoneRows = p.milestones.map((m) => {
        const frac = `[${m.masteredCount}/${m.nodes.length}]`
        let tail = ''
        if (m.examPassed) {
          const pctText = m.examScore !== undefined ? `（${Math.round(m.examScore * 100)} 分）` : ''
          tail = `<span style="color:var(--mastered)">✓ 大考通过${pctText}</span>`
        } else if (m.examable) {
          tail = blocked
            ? '<span class="meta">内容审查通过后可考</span>'
            : running
              ? '<span class="meta">先结束当前流程后可考</span>'
              : `<button class="enter ms-exam" data-href="${TutorDom.esc(examHref(p.id, m.id))}">参加大考 →</button>`
        }
        return `<div class="meta" style="display:flex;align-items:center;gap:8px;margin-top:6px"><span>${TutorDom.esc(m.id)} ${TutorDom.esc(m.title)}　${frac}</span>${tail}</div>`
      }).join('')
      const c = p.counts
      const runningSection = running
        ? `<div class="notice flow-notice">
            <div class="notice-title">▶ 正在进行${TutorDom.flowLabel(running.kind)}</div>
            <div class="notice-body">同一门课程同时只能运行一个流程；先继续或结束它，再开始新的教学步骤。</div>
            <div class="notice-actions"><button class="enter go-continue" data-href="${TutorDom.esc(flowHref(running))}">继续${TutorDom.flowLabel(running.kind)} →</button></div>
          </div>`
        : ''
      // 详情页也要能直接继续下一课：从看板点进课程后不应只剩复习/实践入口；已有流程在跑时先继续它。
      const lessonBtn = p.hasPlan && !blocked && p.current && !running
        ? `<button class="enter go-lesson" data-href="${TutorDom.esc(lessonHref(p.id))}">上课 →</button>`
        : ''
      // 实践入口（course 级）：已生成任务→「去实践」；未生成且内容未过审时不给会失败的死路。
      const practiceRow = p.hasPlan && !running && (p.hasPractice || !blocked)
        ? `<div style="margin-top:10px"><button class="enter go-practice" data-href="${TutorDom.esc(practiceHref(p.id))}">${p.hasPractice ? '去实践 →' : '生成实践任务 →'}</button></div>`
        : ''
      const resetBtn = running ? '' : '<button class="back" id="reset-breaks" type="button">清理中断的摸底/考试断点</button>'
      root.innerHTML = `
        <button class="back" id="back">← 返回课程列表</button>
        <h2 style="margin-top:12px">${TutorDom.esc(p.id)}${p.goal ? ` · ${TutorDom.esc(p.goal)}` : ''}</h2>
        <div class="meta">指针：${p.current ? TutorDom.esc(p.current) : p.hasPlan ? '（计划内知识点均已掌握）' : '（无计划）'}</div>
        <div class="counts">✓ ${c.mastered} 已掌握 ｜ ● ${c.learning} 学习中 ｜ ▲ ${c.weak} 薄弱 ｜ · ${c.unknown} 未测</div>
        ${runningSection}
        ${warnSection}
        <div class="detail-actions">${lessonBtn}${resetBtn}</div>
        ${p.research ? `<div class="meta">教研资料：已保存 ${p.research.completed}/${p.research.total} 个知识点，来源已验证 ${p.research.verified} 个。${p.research.pending && !running ? ` <button class="enter go-research" data-href="${TutorDom.esc(researchHref(p.id))}">继续剩余 ${p.research.pending} 个教研 →</button>` : ''}</div>` : ''}
        ${practiceRow}
        ${milestoneRows ? `<h2 style="margin-top:16px">里程碑</h2>${milestoneRows}` : ''}
        <h2 style="margin-top:16px">知识点（${p.totalNodes}）</h2>
        <div class="table-scroll"><table><thead><tr><th></th><th>状态</th><th>id</th><th>标题</th><th>分数</th><th>复习</th><th>教研资料</th><th>实践</th></tr></thead>
        <tbody>${nodeRows}</tbody></table></div>
        ${curveSection}`
      root.querySelector('#back').addEventListener('click', () => renderList())
      for (const btn of root.querySelectorAll('.ms-exam, .go-practice, .go-research, .go-audit, .go-lesson, .go-continue')) {
        btn.addEventListener('click', () => go(btn.dataset.href))
      }
      root.querySelector('#reset-breaks')?.addEventListener('click', async () => {
        if (!confirm('将归档并清理未完成的摸底/考试断点；掌握度、计划和已通过成绩不受影响。继续？')) return
        try {
          const [assessment, exam] = await Promise.all([
            TutorRpc('resetAssessment', { id: p.id }), TutorRpc('discardAttempt', { id: p.id }),
          ])
          const lines = [
            assessment.reset ? '已清理未完成的摸底进度。' : assessment.message,
            exam.discarded ? '已放弃未完成的考试断点。' : exam.message,
          ]
          alert(lines.filter(Boolean).join('\n'))
          renderStatus(p.id)
        } catch (error) {
          alert(`清理失败：${error.message}`)
        }
      })
    }

    async function start() {
      const courseId = options.courseId ?? new URLSearchParams(location.search).get('course')
      if (courseId) await renderStatus(courseId)
      else await renderList()
    }
    const ready = start().catch((error) => {
      root.innerHTML = `<div class="err">加载失败：${TutorDom.esc(error.message)}</div>`
    })
    return {
      ready,
      showCourse: (courseId) => renderStatus(courseId),
      showList: () => renderList(),
      destroy() { if (researchLive) researchLive.connect(null) },
    }
  }
})()
