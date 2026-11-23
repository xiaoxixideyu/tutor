import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { ESCAPED_LESSON } from './fixtures/markdown.ts'

const browser = {
  TutorMd: undefined as unknown as {
    normalizeText(value: string): string
    toHtml(value: string): string
    inlineText(value: string): string
  },
}
vm.runInNewContext(fs.readFileSync(path.join(import.meta.dirname, '../static/md.js'), 'utf8'), {
  window: browser,
})
const md = browser.TutorMd

it('双转义教学正文恢复段落、三步编号、引用与项目符号', () => {
  const html = md.toHtml(ESCAPED_LESSON)
  assert.equal(html.includes('\\n'), false)
  assert.equal((html.match(/<ol>/g) ?? []).length, 1)
  assert.equal((html.match(/<ul>/g) ?? []).length, 1)
  assert.equal((html.match(/<li>/g) ?? []).length, 6)
  assert.match(html, /<blockquote><p>“I started a new job last month\./)
  assert.match(html, /<strong>接住对方的话，再追问<\/strong>/)
  assert.equal(md.normalizeText(md.normalizeText(ESCAPED_LESSON)), md.normalizeText(ESCAPED_LESSON))
})

it('真实换行、不同编号样式与 tilde 代码围栏正常显示', () => {
  const html = md.toHtml(
    '## 步骤\r\n\r\n2) 第二步\r\n3) 第三步\r\n\r\n> 第一行\r\n> 第二行\r\n\r\n~~~js\r\nconsole.log("ok");\r\n~~~',
  )
  assert.match(html, /<ol start="2">/)
  assert.match(html, /<blockquote><p>第一行<br>第二行<\/p><\/blockquote>/)
  assert.match(html, /<pre><code>console\.log\(&quot;ok&quot;\);<\/code><\/pre>/)
})

it('代码中的换行转义、粗体标记、Windows 路径和数学命令保持原样', () => {
  const code = 'const text = "line\\nnext";\nconst marker = "**literal**";'
  const source =
    '说明：\\n\\n```javascript\n' +
    code +
    '\n```\n' +
    '行内代码 `\\n` 与 `**literal**`。\\n\\n' +
    '路径 C:\\new\\root\\file.txt，数学 \\nabla_x、\\nu 和 \\neq。'
  const normalized = md.normalizeText(source)
  assert.ok(normalized.includes(code))
  assert.ok(normalized.includes('C:\\new\\root\\file.txt'))
  assert.ok(normalized.includes('\\nabla_x、\\nu 和 \\neq'))
  const html = md.toHtml(source)
  assert.match(html, /<code>\\n<\/code>/)
  assert.match(html, /<code>\*\*literal\*\*<\/code>/)
  assert.ok(html.includes('line\\nnext'))
  assert.equal(html.includes('<strong>literal</strong>'), false)
})

it('没有文档换行迹象的转义说明不被解码，HTML 始终作为文本', () => {
  const literal = '解释字符 "\\n" 和 "\\r"，正则 `\\n`。'
  assert.equal(md.normalizeText(literal), literal)
  const html = md.toHtml('<img src=x onerror="alert(1)">\n> <script>alert(1)</script>\n`<b>code</b>`')
  assert.equal(html.includes('<img'), false)
  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('<b>code</b>'), false)
  assert.ok(html.includes('&lt;script&gt;'))
})
