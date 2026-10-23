// 共享课堂/考试聊天壳：气泡、选项 chips、忙态、运行状态条与输入区。
// 页面只负责流程生命周期（start/stop/SSE/exit），渲染与交互集中在这里，避免多页各写一套。
(function () {
  // 旧会话回放可能仍带成本行：静默丢弃，不向学员展示任何开销。
  const LEGACY_COST_RE = /^(本回合|会话累计|审查开销|备课开销|知识地图生成开销|该知识点出题开销|本次流程总成本|复用同一内容的.*费用)/
  const TURN_COST_RE = /^(本回合|会话累计)/
  // 引擎内部运行提示（限流等待、内容审查、备课等）——学员视图不显示为教学气泡，只在一条安静的状态条里显示当前进度。
  const OP_OUT_RE = /^(正在备课[：:]|备课完成|正在从可用的已审查内容恢复课堂|内容审查[ 　]|审查已有内容[：:]|复用同一内容的|正在核对|[^\n]{0,12}核查中[：:]|资料审查达到|正在汇总本知识点|正在核对本知识点)/
  // 运行时排队/限速提示也是内部提示：进状态条，不进聊天记录。
  const OP_ERR_RE = /(等待渠道额度|渠道暂时|重新检查共享额度|按共享队列每分钟)/

  function cleanOp(text) {
    return String(text ?? '').replace(/^tutor:\s*/, '').replace(/\s*；已保存的教研进度保留。?\s*$/, '').trim()
  }

  class TutorChat {
    constructor(options) {
      this.log = options.log
      this.input = options.input
      this.sendButton = options.sendButton
      this.stopButton = options.stopButton
      this.quickButtons = options.quickButtons ?? []
      this.busyEl = options.busyEl
      this.busyText = options.busyText
      this.opStatus = options.opStatus
      this.readyPlaceholder = options.readyPlaceholder ?? '轮到你了，输入回答…（Enter 发送）'
      this.busyLabel = options.busyLabel ?? '等待模型回复…'
      this.onSend = options.onSend ?? (() => {})
      this.onLine = options.onLine
      this.onBusyChange = options.onBusyChange
      this.flowFinished = options.flowFinished !== false
      this.pending = ''
      this.bubble = null
      this.bubbleText = ''
      this.busy = false
      this.busyTimer = null
      this.busySeconds = 0
      this.growComposer = null
      this.setBusy(false)
    }

    // hello 重放前清空临时渲染状态（$log 由页面清空）。
    reset() {
      this.pending = ''
      this.bubble = null
      this.bubbleText = ''
    }

    setFlowFinished(value) {
      this.flowFinished = value
      this.setBusy(this.busy)
    }

    setBusy(on, label) {
      this.busy = on
      if (this.busyTimer) { clearInterval(this.busyTimer); this.busyTimer = null }
      if (this.input) this.input.disabled = on || this.flowFinished
      if (this.sendButton) this.sendButton.disabled = on || this.flowFinished
      for (const button of this.quickButtons) button.disabled = on || this.flowFinished
      if (this.stopButton) this.stopButton.disabled = this.flowFinished
      if (on || this.flowFinished) {
        for (const button of this.log.querySelectorAll('.choices button')) button.disabled = true
      }
      if (on) {
        this.busySeconds = 0
        if (this.busyText) this.busyText.textContent = label ?? `${this.busyLabel} 0s`
        if (this.busyEl) this.busyEl.style.display = 'inline-flex'
        this.busyTimer = setInterval(() => {
          this.busySeconds++
          if (this.busyText) this.busyText.textContent = `${label ?? this.busyLabel}… ${this.busySeconds}s`
        }, 1000)
      } else {
        if (this.busyEl) this.busyEl.style.display = 'none'
        if (this.input && !this.flowFinished) {
          this.input.placeholder = this.readyPlaceholder
          this.input.focus()
        }
      }
      if (this.onBusyChange) this.onBusyChange(on)
    }

    scrollToEnd() {
      window.TutorDom.scrollToEnd(this.log)
    }

    noteOp(text) {
      const value = cleanOp(text)
      if (!value || !this.opStatus) return
      this.opStatus.textContent = '⏳ ' + value
      this.opStatus.style.display = 'block'
    }

    clearOp() {
      if (!this.opStatus) return
      this.opStatus.textContent = ''
      this.opStatus.style.display = 'none'
    }

    isOpError(text) {
      return OP_ERR_RE.test(text)
    }

    renderBubble() {
      if (!this.bubble || !this.bubbleText) return
      this.bubble.innerHTML = window.TutorMd.toHtml(this.bubbleText)
    }

    closeBubble() {
      if (this.bubble) this.renderBubble()
      const text = this.bubbleText
      this.bubble = null
      this.bubbleText = ''
      return text
    }

    setUserEcho(line) {
      this.log.appendChild(window.TutorDom.el(`<div class="userline">你：${window.TutorDom.esc(line)}</div>`))
      this.log.scrollTop = this.log.scrollHeight
    }

    sendLine(line) {
      if (this.busy || this.flowFinished) return false
      this.setUserEcho(line)
      this.closeBubble()
      this.setBusy(true)
      this.onSend(line)
      return true
    }

    // 多行输入：Enter 发送，Shift+Enter 换行；输入框随内容自动增高。
    bindComposer(getLine) {
      if (!this.input) return
      const input = this.input
      const grow = () => {
        input.style.height = 'auto'
        input.style.height = `${Math.min(input.scrollHeight, 200)}px`
      }
      input.addEventListener('input', grow)
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
        event.preventDefault()
        const line = getLine()
        if (!line) return
        input.value = ''
        grow()
        this.sendLine(line)
      })
      this.growComposer = grow
    }

    optionLinesOf(text) {
      const out = []
      for (const line of text.split('\n')) {
        const match = line.match(/^\s*([A-Fa-f])[.、．]\s*(\S.*)$/)
        if (match) out.push({ letter: match[1].toUpperCase(), label: match[2].trim() })
      }
      return out
    }

    maybeChips(text) {
      const options = this.optionLinesOf(text)
      if (options.length < 2 || options.length > 6) return
      // 单个问题（一组连续字母）
      const letters = options.map((option) => option.letter)
      const expects = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, letters.length)
      if (letters.join('') !== expects.join('')) return
      // 下一题出现后，旧题按钮也不能再次提交。
      for (const button of this.log.querySelectorAll('.choices button')) button.disabled = true
      const multi = /可多选|可多選|多选题|（多选）|\(多选\)/.test(text)
      const container = window.TutorDom.el('<div class="chips choices"></div>')
      const chipSelection = []
      let chipsAnswered = false
      if (multi) container.appendChild(window.TutorDom.el('<span class="hint">可多选，选完点「提交选择」</span>'))
      for (const option of options) {
        const chip = window.TutorDom.el(`<button class="chip">${window.TutorDom.esc(option.letter)}. ${window.TutorDom.esc(option.label)}</button>`)
        chip.addEventListener('click', () => {
          if (chipsAnswered || this.busy || this.flowFinished) return
          if (multi) {
            const index = chipSelection.indexOf(option.letter)
            if (index >= 0) chipSelection.splice(index, 1)
            else chipSelection.push(option.letter)
            chip.classList.toggle('selected')
          } else {
            chipsAnswered = true
            for (const button of container.querySelectorAll('.chip')) button.classList.add('disabled')
            chip.classList.add('selected')
            this.submitChips([option.letter])
          }
        })
        container.appendChild(chip)
      }
      if (multi) {
        const submit = window.TutorDom.el('<button class="chip">提交选择</button>')
        submit.addEventListener('click', () => {
          if (chipsAnswered || this.busy || this.flowFinished || chipSelection.length === 0) return
          chipsAnswered = true
          for (const button of container.querySelectorAll('.chip')) button.classList.add('disabled')
          this.submitChips(chipSelection)
        })
        container.appendChild(submit)
      }
      this.log.appendChild(container)
      this.log.scrollTop = this.log.scrollHeight
    }

    submitChips(letters) {
      if (this.busy || this.flowFinished) return
      const line = letters.join('')
      this.log.appendChild(window.TutorDom.el(`<div class="userline">你：${window.TutorDom.esc(line)}</div>`))
      this.closeBubble()
      this.setBusy(true)
      this.onSend(line)
    }

    handleLine(line) {
      const trimmed = line.trim()
      if (this.onLine) this.onLine(trimmed)
      if (trimmed === '>') {
        const closed = this.closeBubble()
        if (closed) this.maybeChips(closed)
        this.clearOp()
        this.setBusy(false)
        return
      }
      if (LEGACY_COST_RE.test(trimmed)) {
        // 旧会话以回合成本行收尾时，讲解气泡在这里闭合：其中的选项仍要转成可点按钮，
        // 否则"当前这道题"只剩纯文本，学员没有可点的入口。
        if (TURN_COST_RE.test(trimmed)) {
          const closed = this.closeBubble()
          if (closed) this.maybeChips(closed)
        }
        return
      }
      if (OP_OUT_RE.test(trimmed)) { this.noteOp(trimmed); return }
      if (trimmed === '') return
      if (!this.bubble) {
        this.clearOp()
        this.bubble = window.TutorDom.el('<div class="tutor"></div>')
        this.log.appendChild(this.bubble)
      }
      this.bubbleText += (this.bubbleText ? '\n' : '') + line
      this.bubble.textContent = this.bubbleText
      this.scrollToEnd()
    }

    feed(text) {
      this.pending += text
      let index
      while ((index = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, index)
        this.pending = this.pending.slice(index + 1)
        this.handleLine(line)
      }
      if (this.pending.trim() === '>') {
        this.handleLine('>')
        this.pending = ''
      }
    }
  }

  TutorChat.cleanOp = cleanOp
  TutorChat.isOpLine = (text) => OP_OUT_RE.test(String(text ?? '').trim())
  window.TutorChat = TutorChat
})()
