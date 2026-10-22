// 看板视图（课程列表 + 课程详情）：单壳与独立页面共用同一份渲染逻辑。
(function () {
  const V = (window.TutorViews = window.TutorViews || {})
  const SYM = { mastered: ['✓', 's-mastered'], learning: ['●', 's-learning'], weak: ['▲', 's-weak'], unknown: ['·', 's-unknown'] }
  const FLOW_LABEL = { new: '访谈', assess: '摸底', plan: '计划', research: '教研', learn: '课堂', exam: '大考', 'practice-gen': '实践生成', practice: '实践', 'audit-content': '内容审查' }

  // 单壳里跳的是 hash 路由，独立页面跳的是旧地址；由宿主决定。
  function defaultFlowHref(flow) {
    const course = encodeURIComponent(flow.courseId)
    if (flow.kind === 'learn') return `/lesson.html?course=${course}`
    if (flow.kind === 'exam') return `/exam.html?course=${course}&milestone=${encodeURIComponent(flow.milestoneId || '')}`
    if (flow.kind === 'practice' || flow.kind === 'practice-gen') return `/practice.html?course=${course}`
    return `/wizard.html?course=${course}&resume=${encodeURIComponent(flow.kind)}${flow.nodeId ? `&node=${encodeURIComponent(flow.nodeId)}` : ''}`
  }

  V.home = function (options) {
    const root = options.root
    const researchLive = options.researchLive ?? null
    const flowHref = options.flowHref ?? defaultFlowHref
    const courseHref = options.courseHref ?? ((id) => `/?course=${encodeURIComponent(id)}`)
    const lessonHref = options.lessonHref ?? ((id) => `/lesson.html?course=${encodeURIComponent(id)}`)
    const planHref = options.planHref ?? ((id) => `/wizard.html?course=${encodeURIComponent(id)}&resume=plan`)
    const assessHref = options.assessHref ?? ((id) => `/wizard.html?course=${encodeURIComponent(id)}&resume=assess`)
    const practiceHref = options.practiceHref ?? ((id, node) => `/practice.html?course=${encodeURIComponent(id)}${node ? `&node=${encodeURIComponent(node)}` : ''}`)
    const researchHref = options.researchHref ?? ((id, node) => `/wizard.html?course=${encodeURIComponent(id)}&resume=research${node ? `&node=${encodeURIComponent(node)}` : ''}`)
    const auditHref = options.auditHref ?? ((id) => `/wizard.html?course=${encodeURIComponent(id)}&resume=audit-content`)
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
            const runningBadge = running ? `<span class="badge run">▶ ${FLOW_LABEL[running.kind] ?? running.kind}进行中</span>` : ''
            const reviewLine = dueById.has(c.id)
              ? `<div class="meta review-line">待复习：${TutorDom.esc(dueById.get(c.id).due.map((d) => d.node).join('、'))}</div>`
              : ''
            // 内容主闸（地图）未过审：摸底/计划/上课/复习都会 gate.require 地图，任一点进去都会 dead-end；看板先提示而非假装可用。
            const warnLine = !c.error && c.contentReady === false
              ? '<div class="meta" style="color:#b45309">⚠ 课程内容未通过当前审查，摸底/上课/复习等环节可能无法进入——需重新审查后再用</div>'
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
                ? { label: `继续${FLOW_LABEL[running.kind] ?? '流程'} →`, href: flowHref(running) }
                : c.stage === 'ready'
                  ? allMastered
                    ? { label: '✓ 已全部掌握', href: courseHref(c.id) }
                    : { label: '上课 →', href: lessonHref(c.id) }
                  : c.stage === 'need-plan'
                    ? { label: '生成计划 →', href: planHref(c.id) }
                    : { label: '去摸底 →', href: assessHref(c.id) }
            const reviewBtn = c.dueCount
              ? `<button class="enter review-btn" data-href="/review.html?course=${encodeURIComponent(c.id)}">复习 ${c.dueCount} →</button>`
              : ''
            return `<div class="course" data-id="${TutorDom.esc(c.id)}" data-error="${c.error ? '1' : ''}">
              <div class="row1"><span class="id">${TutorDom.esc(c.id)}</span><span class="goal">${TutorDom.esc(c.goal)}</span>${runningBadge}${dueBadge}${reviewBtn}${cta ? `<button class="enter" data-href="${TutorDom.esc(cta.href)}">${TutorDom.esc(cta.label)}</button>` : ''}</div>
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
      const issues = await TutorRpc('contentIssues', { id }).catch(() => [])
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
      const issuesSection = issues.length
        ? `<div style="margin-top:12px;padding:10px 12px;border:1px solid #f1c084;background:#fffbeb;border-radius:8px">
            <div style="color:#b45309;font-weight:600;margin-bottom:6px">⚠ 以下内容未通过审查，修复后需重新审查</div>
            ${issues.map((it) => `<div class="meta" style="margin:4px 0">· <strong>${TutorDom.esc(KIND_LABEL[it.kind] ?? it.kind)}${it.node ? '（' + TutorDom.esc(it.node) + '）' : ''}</strong>：${(it.issues || []).map(TutorDom.esc).join('；')}</div>`).join('')}
            <div class="meta" style="margin-top:6px">修复对应 YAML 后运行 <code>npm run agent -- audit-content ${TutorDom.esc(p.id)}</code> 重新审查。</div>
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
          <td>${n.researchStatus ? `${researchLabel} <button class="enter go-research" data-href="${TutorDom.esc(researchHref(p.id, n.id))}">${n.researchStatus === 'pending' ? '教研' : '补查'}</button>` : ''}</td>
          <td>${p.hasPlan ? `<button class="enter go-practice" data-href="${TutorDom.esc(practiceHref(p.id, n.id))}">${n.practiceCount ? '实践' : '生成实践'}</button>` : ''}</td>
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
          tail = `<button class="enter ms-exam" data-href="${TutorDom.esc(options.examHref ? options.examHref(p.id, m.id) : `/exam.html?course=${encodeURIComponent(p.id)}&milestone=${encodeURIComponent(m.id)}`)}">参加大考 →</button>`
        }
        return `<div class="meta" style="display:flex;align-items:center;gap:8px;margin-top:6px"><span>${TutorDom.esc(m.id)} ${TutorDom.esc(m.title)}　${frac}</span>${tail}</div>`
      }).join('')
      const c = p.counts
      // 实践入口（course 级）：有计划才给；practice.yaml 已生成→「去实践」，否则→「生成实践任务」（practice.html 内部再兜底判定）。
      const practiceRow = p.hasPlan
        ? `<div style="margin-top:10px"><button class="enter go-practice" data-href="${TutorDom.esc(practiceHref(p.id))}">${p.hasPractice ? '去实践 →' : '生成实践任务 →'}</button></div>`
        : ''
      // 未过审时给「重新审查」入口（wizard 以 audit-content 流程运行 `npm run agent -- audit-content <id>`）。
      const auditBtn = p.contentReady === false
        ? `<button class="enter go-audit" data-href="${TutorDom.esc(auditHref(p.id))}">重新审查 →</button>`
        : ''
      const resetBtn = `<button class="enter" id="reset-breaks" style="margin-left:8px">清理中断的摸底/考试断点</button>`
      root.innerHTML = `
        <button class="back" id="back">← 返回课程列表</button>
        <h2 style="margin-top:12px">${TutorDom.esc(p.id)}${p.goal ? ` · ${TutorDom.esc(p.goal)}` : ''}</h2>
        <div class="meta">指针：${p.current ? TutorDom.esc(p.current) : p.hasPlan ? '（计划内知识点均已掌握）' : '（无计划）'}</div>
        <div class="counts">✓ ${c.mastered} 已掌握 ｜ ● ${c.learning} 学习中 ｜ ▲ ${c.weak} 薄弱 ｜ · ${c.unknown} 未测</div>
        ${auditBtn}
        ${resetBtn}
        ${issuesSection}
        ${p.research ? `<div class="meta">教研资料：已保存 ${p.research.completed}/${p.research.total} 个知识点，来源已验证 ${p.research.verified} 个。${p.research.pending ? ` <button class="enter go-research" data-href="${TutorDom.esc(researchHref(p.id))}">继续剩余 ${p.research.pending} 个教研 →</button>` : ''}</div>` : ''}
        ${practiceRow}
        ${milestoneRows ? `<h2 style="margin-top:16px">里程碑</h2>${milestoneRows}` : ''}
        <h2 style="margin-top:16px">知识点（${p.totalNodes}）</h2>
        <table><thead><tr><th></th><th>状态</th><th>id</th><th>标题</th><th>分数</th><th>复习</th><th>教研资料</th><th>实践</th></tr></thead>
        <tbody>${nodeRows}</tbody></table>
        ${curveSection}`
      root.querySelector('#back').addEventListener('click', () => renderList())
      for (const btn of root.querySelectorAll('.ms-exam, .go-practice, .go-research, .go-audit')) {
        btn.addEventListener('click', () => go(btn.dataset.href))
      }
      root.querySelector('#reset-breaks').addEventListener('click', async () => {
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
