// 共享 DOM 小工具：所有页面用同一套转义/创建/滚动实现，避免各页复制出细微差异。
(function () {
  function el(html) {
    const div = document.createElement('div')
    div.innerHTML = html
    return div.firstChild
  }

  function esc(text) {
    const div = document.createElement('div')
    div.textContent = String(text ?? '')
    return div.innerHTML
  }

  // 只在已贴近底部时才自动滚动——用户上翻回看讲解时不被拽到底。
  function scrollToEnd(element) {
    if (!element) return
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 120) {
      element.scrollTop = element.scrollHeight
    }
  }

  function setText(id, text) {
    const element = typeof id === 'string' ? document.getElementById(id) : id
    if (element) element.textContent = text
  }

  const FLOW_LABEL = {
    new: '需求访谈', assess: '摸底测评', plan: '教学计划', research: '联网教研', learn: '课堂',
    exam: '里程碑大考', 'practice-gen': '实践任务生成', practice: '实践', 'audit-content': '内容审查',
  }
  const FLOW_STATUS = { running: '进行中', stopping: '正在停止', completed: '已完成', failed: '失败' }
  const flowLabel = (kind) => FLOW_LABEL[kind] ?? '教学流程'
  const flowStatusLabel = (status) => FLOW_STATUS[status] ?? status ?? ''

  // 服务器错误里的准入证据路径只用于排查；界面只呈现下一步动作。
  function isContentGateError(text) {
    return /(未通过审查|尚未通过审查|内容审查未完成|已有内容未通过审查)/.test(String(text ?? ''))
  }

  function gateNotice({ courseId, navigate = (href) => { location.hash = href }, raw = '' }) {
    const card = el(`<div class="gate-notice">
      <div class="gate-head">⚠ 内容审查未通过，流程已暂停</div>
      <div class="gate-body">该课程当前教学内容未通过准入审查。先重新审查并处理未通过项，才能继续摸底、上课、大考或生成实践。</div>
      <div class="gate-actions"></div>
    </div>`)
    const actions = card.querySelector('.gate-actions')
    const audit = el('<button class="chip primary">重新审查 →</button>')
    audit.addEventListener('click', () => navigate(`#/course/${encodeURIComponent(courseId)}/audit-content`))
    const detail = el('<button class="chip">查看已发现的问题</button>')
    detail.addEventListener('click', () => navigate(`#/course/${encodeURIComponent(courseId)}`))
    actions.append(audit, detail)
    if (raw) card.title = String(raw)
    return card
  }

  // 内容生成多次未通过校验：对外只给结论，原始诊断收进可展开的技术细节。
  function flowFailure({ title = '内容生成未通过校验，本轮已暂停', body = '模型生成的内容没有通过独立核对，已停止继续生成。已完成的进度已保存，可稍后重试；若多次失败，可在模型设置里换一个能力更强的模型。', detail = '' } = {}) {
    const card = el(`<div class="gate-notice flow-failure">
      <div class="gate-head">⚠ ${esc(title)}</div>
      <div class="gate-body">${esc(body)}</div>
    </div>`)
    if (detail) {
      const details = el('<details class="failure-detail"><summary>技术细节</summary><pre></pre></details>')
      details.querySelector('pre').textContent = String(detail)
      card.appendChild(details)
    }
    return card
  }

  // 进教学流程前先看课程准入，避免为了“自动开始”先触发一次昂贵的内容复审再失败。
  async function contentBlocked(courseId) {
    try {
      const course = await TutorRpc('courseStatus', { id: courseId })
      return course.contentReady === false
    } catch { return false }
  }

  window.TutorDom = { el, esc, scrollToEnd, setText, flowLabel, flowStatusLabel, isContentGateError, gateNotice, flowFailure, contentBlocked }
})()
