// 命令面板（⌘K / Ctrl+K）：模糊搜索课程、视图与动作，Enter 执行。
// 只做导航与快捷动作，不直接改课程状态。
(function () {
  const P = (window.TutorPalette = window.TutorPalette || {})

  P.mount = function (options) {
    const overlay = document.createElement('div')
    overlay.className = 'palette-overlay'
    overlay.innerHTML = `
      <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <input class="palette-input" placeholder="搜索课程或命令…（↑↓ 选择，Enter 执行，Esc 关闭）" autocomplete="off" spellcheck="false">
        <div class="palette-list"></div>
      </div>`
    document.body.appendChild(overlay)
    const input = overlay.querySelector('.palette-input')
    const list = overlay.querySelector('.palette-list')
    let items = []
    let filtered = []
    let cursor = 0

    function score(item, query) {
      if (!query) return 0
      const text = `${item.title} ${item.hint ?? ''}`.toLowerCase()
      const index = text.indexOf(query.toLowerCase())
      return index < 0 ? Infinity : index
    }

    function render() {
      const query = input.value.trim()
      filtered = items.map((item) => ({ item, rank: score(item, query) }))
        .filter((entry) => entry.rank !== Infinity)
        .sort((a, b) => a.rank - b.rank)
        .map((entry) => entry.item)
      cursor = 0
      if (filtered.length === 0) {
        list.innerHTML = '<div class="palette-empty">没有匹配项</div>'
        return
      }
      list.innerHTML = filtered.map((item, index) => `
        <button class="palette-item${index === cursor ? ' active' : ''}" data-index="${index}">
          <span class="palette-item-title">${window.TutorDom.esc(item.title)}</span>
          ${item.hint ? `<span class="palette-item-hint">${window.TutorDom.esc(item.hint)}</span>` : ''}
        </button>`).join('')
      for (const button of list.querySelectorAll('.palette-item')) {
        button.addEventListener('click', () => run(Number(button.dataset.index)))
      }
    }

    function run(index) {
      const item = filtered[index]
      if (!item) return
      close()
      item.run()
    }

    function open() {
      items = options.items?.() ?? []
      input.value = ''
      overlay.classList.add('open')
      render()
      input.focus()
    }

    function close() {
      overlay.classList.remove('open')
    }

    input.addEventListener('input', render)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (filtered.length === 0) return
        cursor = (cursor + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length
        render()
        return
      }
      if (event.key === 'Enter') { event.preventDefault(); run(cursor) }
    })
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close() })
    window.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        overlay.classList.contains('open') ? close() : open()
      }
    })

    return { open, close, destroy() { overlay.remove() } }
  }
})()
