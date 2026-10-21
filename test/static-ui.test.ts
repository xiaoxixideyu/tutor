import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pages = ['index.html', 'wizard.html', 'lesson.html', 'exam.html', 'practice.html', 'review.html', 'settings.html']
const sharedScripts = ['ui/dom.js', 'ui/rpc.js', 'ui/chat.js', 'flow-client.js', 'md.js', 'research-progress.js', 'settings.js']

function read(file: string): string {
  return fs.readFileSync(path.join(root, 'static', file), 'utf8')
}

describe('静态页面与共享 UI 组件', () => {
  it('共享脚本与内联脚本语法合法', () => {
    for (const file of sharedScripts) {
      assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), file)
    }
    for (const file of pages) {
      const html = read(file)
      const inline = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g
      let match: RegExpExecArray | null
      let index = 0
      while ((match = inline.exec(html))) {
        index++
        assert.doesNotThrow(() => new vm.Script(match![1], { filename: `${file}#${index}` }), `${file} 内联脚本 ${index}`)
      }
    }
  })

  it('课堂与大考复用同一套聊天组件与样式，不再各自复制', () => {
    for (const file of ['lesson.html', 'exam.html']) {
      const html = read(file)
      assert.match(html, /<link rel="stylesheet" href="\/ui\/chat\.css">/, `${file} 应引用共享样式`)
      assert.match(html, /<script src="\/ui\/dom\.js"><\/script>/, `${file} 应引用共享 DOM 工具`)
      assert.match(html, /<script src="\/ui\/chat\.js"><\/script>/, `${file} 应引用共享聊天组件`)
      // 这些实现已经移入 ui/chat.js，页面里不应再有副本。
      for (const duplicated of ['function maybeChips', 'function handleLine', 'function submitChips', 'function colorizeCost', 'function setBusy']) {
        assert.equal(html.includes(duplicated), false, `${file} 不应再定义 ${duplicated}`)
      }
    }
  })

  it('其余页面复用共享 DOM/RPC 工具', () => {
    for (const file of ['index.html', 'review.html', 'practice.html', 'wizard.html']) {
      assert.match(read(file), /<script src="\/ui\/dom\.js"><\/script>/, `${file} 应引用共享 DOM 工具`)
    }
    for (const file of ['index.html', 'review.html', 'practice.html']) {
      assert.match(read(file), /<script src="\/ui\/rpc\.js"><\/script>/, `${file} 应引用共享 RPC 工具`)
    }
    for (const file of ['index.html', 'review.html', 'practice.html', 'wizard.html']) {
      assert.equal(read(file).includes('function esc(text)'), false, `${file} 不应再定义 esc`)
      assert.equal(read(file).includes('async function rpc('), false, `${file} 不应再定义 rpc`)
    }
  })
})
