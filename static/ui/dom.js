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

  window.TutorDom = { el, esc, scrollToEnd, setText }
})()
