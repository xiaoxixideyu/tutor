// 复习视图：到期知识点的结构化小测（选项/填空），独立页面与单壳共用。
(function () {
  const V = (window.TutorViews = window.TutorViews || {})
  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

  V.review = function (options) {
    const root = options.root
    const courseId = options.courseId ?? new URLSearchParams(location.search).get('course')
    const navigate = options.navigate ?? ((href) => { location.href = href })
    const onStatus = options.onStatus ?? (() => {})

    root.innerHTML = '<div class="review-panel"></div>'
    const $main = root.querySelector('.review-panel')

    let items = []
    let titles = new Map()
    let cur = 0

    function showResultCard(message) {
      const card = TutorDom.el('<div class="card"><div class="empty"></div><div class="chips"></div></div>')
      card.querySelector('.empty').textContent = message
      const back = TutorDom.el('<button class="next">← 课程列表</button>')
      back.addEventListener('click', () => navigate('/'))
      card.querySelector('.chips').appendChild(back)
      $main.appendChild(card)
    }

    function renderNode() {
      const item = items[cur]
      const title = titles.get(item.node) || item.node
      const answers = new Array(item.questions.length).fill('')
      const card = TutorDom.el('<div class="card"></div>')
      card.appendChild(TutorDom.el(`<div class="nodehead">${TutorDom.esc(title)}</div>`))
      // 记忆状态：逾期天数与保留率估计（旧数据无锚点时只显示题量）。
      const memory = [
        item.overdue_days > 0 ? `逾期 ${item.overdue_days} 天` : '',
        item.retention !== undefined ? `预计保留 ≈${Math.round(item.retention * 100)}%` : '',
      ].filter(Boolean).join(' · ')
      card.appendChild(TutorDom.el(`<div class="progress">第 ${cur + 1}/${items.length} 节 · ${item.questions.length} 题${memory ? ` · ${memory}` : ''}</div>`))
      item.questions.forEach((question, index) => {
        const qDiv = TutorDom.el('<div class="q"></div>')
        // 题干可能是含代码块的 Markdown（题库原文），必须渲染而不是转义成纯文本。
        qDiv.appendChild(TutorDom.el(`<div class="qtext"><span class="idx">${index + 1}.</span><div class="qbody">${TutorMd.toHtml(question.question)}</div></div>`))
        if (question.type === 'choice' && Array.isArray(question.choices)) {
          const wrap = TutorDom.el('<div class="choices"></div>')
          question.choices.forEach((choiceText, choiceIndex) => {
            const letter = LETTERS[choiceIndex]
            const btn = TutorDom.el(`<button class="choice">${TutorMd.inlineText(choiceText)}</button>`)
            btn.addEventListener('click', () => {
              if (btn.classList.contains('disabled')) return
              answers[index] = letter
              for (const other of wrap.querySelectorAll('.choice')) other.classList.remove('selected')
              btn.classList.add('selected')
            })
            wrap.appendChild(btn)
          })
          qDiv.appendChild(wrap)
        } else {
          const box = TutorDom.el('<div class="short"><input placeholder="输入你的答案…"></div>')
          box.querySelector('input').addEventListener('input', (event) => { answers[index] = event.target.value })
          qDiv.appendChild(box)
        }
        card.appendChild(qDiv)
      })
      const submit = TutorDom.el('<button class="submit">提交本节</button>')
      submit.addEventListener('click', async () => {
        if (answers.some((answer) => !answer.trim())) {
          onStatus({ text: '请完成全部题目后提交', busy: false })
          return
        }
        submit.disabled = true
        for (const choice of card.querySelectorAll('.choice')) choice.classList.add('disabled')
        for (const input of card.querySelectorAll('input')) input.disabled = true
        try {
          const out = await TutorRpc('submitReview', { id: courseId, node: item.node, attemptId: item.attemptId, answers })
          showResult(card, item, out)
        } catch (error) {
          submit.disabled = false
          for (const choice of card.querySelectorAll('.choice')) choice.classList.remove('disabled')
          for (const input of card.querySelectorAll('input')) input.disabled = false
          card.appendChild(TutorDom.el(`<div class="err">提交失败：${TutorDom.esc(error.message)}</div>`))
        }
      })
      card.appendChild(submit)
      $main.innerHTML = ''
      $main.appendChild(card)
    }

    function showResult(card, item, out) {
      const qDivs = card.querySelectorAll('.q')
      out.perQuestion.forEach((pq, index) => {
        const question = item.questions[index]
        let answerText = pq.answer
        // choice 的标准答案是字母，换成选项原文更友好
        if (question && question.type === 'choice' && Array.isArray(question.choices)) {
          const choiceIndex = LETTERS.indexOf(String(pq.answer).trim().toUpperCase())
          if (choiceIndex >= 0 && question.choices[choiceIndex]) answerText = question.choices[choiceIndex]
        }
        const tail = pq.correct ? '' : `　<span class="ans">正确答案：${TutorMd.inlineText(answerText)}</span>`
        const verdict = TutorDom.el(`<div class="verdict ${pq.correct ? 'ok' : 'no'}">${pq.correct ? '✓ 正确' : '✗ 错误'}${tail}</div>`)
        if (qDivs[index]) qDivs[index].appendChild(verdict)
      })
      const pct = Math.round(out.score * 100)
      const result = TutorDom.el('<div class="result"></div>')
      result.appendChild(TutorDom.el(`<div class="score">得分 ${out.correct}/${out.total}（${pct}%）</div>`))
      result.appendChild(TutorDom.el(`<div class="due">下次复习：${TutorDom.esc(out.entry.review_due)}（状态 ${TutorDom.esc(out.entry.status)}）</div>`))
      const row = TutorDom.el('<div class="chips"></div>')
      if (cur < items.length - 1) {
        const next = TutorDom.el('<button class="next">下一节 →</button>')
        next.addEventListener('click', () => { cur += 1; window.scrollTo(0, 0); renderNode() })
        row.appendChild(next)
      } else {
        const done = TutorDom.el('<button class="next">全部完成 → 课程列表</button>')
        done.addEventListener('click', () => navigate('/'))
        row.appendChild(done)
      }
      const back = TutorDom.el('<button class="next secondary">← 课程列表</button>')
      back.addEventListener('click', () => navigate('/'))
      row.appendChild(back)
      result.appendChild(row)
      card.appendChild(result)
      onStatus({ text: `已复习 ${cur + 1}/${items.length}`, busy: false })
    }

    const ready = (async () => {
      if (!courseId) {
        $main.innerHTML = '<div class="err">缺少 course 参数——请从课程列表进入。</div>'
        return
      }
      onStatus({ text: '复习 · ' + courseId, busy: false })
      try {
        // courseStatus 仅用来把节点 id 换成可读标题，失败不阻断复习
        const [status, review] = await Promise.all([
          TutorRpc('courseStatus', { id: courseId }).catch(() => null),
          TutorRpc('reviewQuestions', { id: courseId }),
        ])
        if (status) titles = new Map(status.nodes.map((node) => [node.id, node.title]))
        const all = review.items ?? []
        items = all.filter((item) => item.questions.length > 0)
        const skipped = all.filter((item) => item.questions.length === 0)
        if (skipped.length) onStatus({ text: `${skipped.length} 个到期知识点缺少题库，暂未纳入本轮`, busy: false })
        if (items.length === 0) {
          showResultCard(skipped.length ? '到期知识点缺少题库，暂无法复习。' : '🎉 没有到期的复习。')
          return
        }
        onStatus({ text: `${items.length} 个知识点待复习${skipped.length ? `，另 ${skipped.length} 个缺少题库` : ''}`, busy: false })
        renderNode()
      } catch (error) {
        $main.innerHTML = `<div class="err">加载失败：${TutorDom.esc(error.message)}</div>`
      }
    })()

    return { ready, destroy() { /* 复习视图无长连接 */ } }
  }
})()
