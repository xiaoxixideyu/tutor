// 教学正文的安全 Markdown 子集；原始内容与代码转义保持可追溯。
;(function () {
  function escHtml(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    )
  }

  function normalizeText(value) {
    const original = String(value ?? '').replace(/\r\n?/g, '\n')
    const protectedText = []
    // 代码、数学命令及路径中的 \n 不是教学段落换行。
    const text = original.replace(
      /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[\s\S]*?\2|[A-Za-z]:\\[^\s<>"'`]+|\\(?:nabla|neqslant|nequiv|neq|nu|not|newcommand|newline|nicefrac|rho|right|ref|rangle|renewcommand)(?![A-Za-z])|["']\\{1,2}[nrt]["']/g,
      (part) => {
        protectedText.push(part)
        return '\u0000PROTECTED' + (protectedText.length - 1) + '\u0000'
      },
    )
    const breaks = text.match(/\\{1,2}(?:r\\{1,2})?n/g) ?? []
    const structured = /\\{1,2}n(?:\\{1,2}n|[ \t]*(?:[-*+#>]|\d|[\u3400-\u9fff]))/.test(text)
    const normalized =
      breaks.length >= 2 && structured ? text.replace(/\\{1,2}r\\{1,2}n|\\{1,2}n/g, '\n') : text
    return normalized.replace(/\u0000PROTECTED(\d+)\u0000/g, (_, index) => protectedText[Number(index)] ?? '')
  }

  function plainInline(value) {
    return escHtml(value)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[资料[:：](\d+)\]/g, '<sup class="cite">[资料:$1]</sup>')
  }

  function inlineText(value) {
    const source = String(value ?? ''),
      pattern = /(`+)([\s\S]*?)\1/g
    let out = '',
      cursor = 0,
      match
    while ((match = pattern.exec(source))) {
      out += plainInline(source.slice(cursor, match.index))
      out += '<code>' + escHtml(match[2].replace(/\n/g, ' ')) + '</code>'
      cursor = pattern.lastIndex
    }
    return out + plainInline(source.slice(cursor))
  }

  function listItem(line) {
    const unordered = line.match(/^ {0,3}[-*+]\s+(.*)$/)
    if (unordered) return { type: 'ul', content: unordered[1] }
    const ordered = line.match(/^ {0,3}(\d+)[.)]\s+(.*)$/)
    return ordered ? { type: 'ol', content: ordered[2], start: Number(ordered[1]) } : null
  }

  function blockStart(line) {
    return (
      /^ {0,3}(?:#{1,6}\s|>|`{3,}|~{3,})/.test(line) ||
      /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
      !!listItem(line)
    )
  }

  function renderBlocks(lines) {
    const out = []
    for (let index = 0; index < lines.length; ) {
      const line = lines[index]
      if (!line.trim()) {
        index++
        continue
      }
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})[^`~]*$/)
      if (fence) {
        const code = [],
          closing = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$')
        index++
        while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++])
        if (index < lines.length) index++
        out.push('<pre><code>' + escHtml(code.join('\n')) + '</code></pre>')
        continue
      }
      const heading = line.match(/^ {0,3}#{1,6}\s+(.*)$/)
      if (heading) {
        out.push('<h3>' + inlineText(heading[1]) + '</h3>')
        index++
        continue
      }
      if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('<hr>')
        index++
        continue
      }
      if (/^ {0,3}>/.test(line)) {
        const quote = []
        while (index < lines.length && /^ {0,3}>/.test(lines[index]))
          quote.push(lines[index++].replace(/^ {0,3}>\s?/, ''))
        out.push('<blockquote>' + renderBlocks(quote) + '</blockquote>')
        continue
      }
      const item = listItem(line)
      if (item) {
        const start = item.type === 'ol' && item.start !== 1 ? ' start="' + item.start + '"' : ''
        out.push('<' + item.type + start + '>')
        while (index < lines.length) {
          const next = listItem(lines[index])
          if (!next || next.type !== item.type) break
          out.push('<li>' + inlineText(next.content) + '</li>')
          index++
        }
        out.push('</' + item.type + '>')
        continue
      }
      const paragraph = [line]
      index++
      while (index < lines.length && lines[index].trim() && !blockStart(lines[index]))
        paragraph.push(lines[index++])
      out.push('<p>' + paragraph.map(inlineText).join('<br>') + '</p>')
    }
    return out.join('\n')
  }

  function toHtml(value) {
    return renderBlocks(normalizeText(value).split('\n'))
  }
  window.TutorMd = { toHtml, inlineText, normalizeText }
})()
