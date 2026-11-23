;(function () {
  function esc(value) {
    const node = document.createElement('span')
    node.textContent = String(value ?? '')
    return node.innerHTML
  }
  function el(html) {
    const template = document.createElement('template')
    template.innerHTML = html.trim()
    return template.content.firstElementChild
  }
  window.TutorDom = { esc, el }
})()
