// 共享 Markdown 渲染（课堂 / 考试 / 复习页）：代码块、行内码、粗体、[资料:n] 高亮。
// 输入按纯文本转义后再拼受控标签；页面只应把本函数输出用于 innerHTML。
(function () {
  function escHtml(text) { const div = document.createElement('div'); div.textContent = String(text ?? ''); return div.innerHTML }
  // 行内元素：`行内码`、**粗体**、[资料:n]。输入是已转义文本。
  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[资料[:：](\d+)\]/g, '<sup class="cite">[资料:$1]</sup>')
  }
  function inlineText(raw) { return inline(escHtml(raw)) }
  function toHtml(src) {
    const blocks = []
    // 1) 抽出 fenced code 块，避免被后续按行处理破坏
    const text = String(src ?? '').replace(/```(\w*)\n([\s\S]*?)(?:```|$)/g, (_, _lang, code) => {
      blocks.push(`<pre><code>${escHtml(code.replace(/\n$/, ''))}</code></pre>`)
      return `\u0000CODE${blocks.length - 1}\u0000`
    })
    // 2) 逐行处理剩余 md
    const lines = text.split('\n')
    const out = []
    let listType = null
    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }
    for (const raw of lines) {
      const line = escHtml(raw)
      if (/^\u0000CODE\d+\u0000$/.test(line.trim())) { closeList(); out.push(line.trim()); continue }
      const heading = line.match(/^(#{1,4})\s+(.*)$/)
      if (heading) { closeList(); out.push(`<h3>${inline(heading[2])}</h3>`); continue }
      const ul = line.match(/^\s*[-*]\s+(.*)$/)
      if (ul) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul' } out.push(`<li>${inline(ul[1])}</li>`); continue }
      const ol = line.match(/^\s*\d+\.\s+(.*)$/)
      if (ol) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol' } out.push(`<li>${inline(ol[1])}</li>`); continue }
      closeList()
      if (line.trim() === '') { out.push('<p></p>'); continue }
      out.push(`<p>${inline(line)}</p>`)
    }
    closeList()
    // 3) 还原代码块
    return out.join('\n').replace(/\u0000CODE(\d+)\u0000/g, (_, index) => blocks[Number(index)])
  }
  window.TutorMd = { toHtml, inlineText }
})()
