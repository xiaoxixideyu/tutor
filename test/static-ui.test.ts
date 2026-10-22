import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pages = ['index.html', 'wizard.html', 'lesson.html', 'exam.html', 'practice.html', 'review.html', 'settings.html', 'app.html']
const sharedScripts = [
  'ui/dom.js', 'ui/rpc.js', 'ui/chat.js', 'ui/app.js',
  'ui/views/home.js', 'ui/views/learn.js', 'ui/views/exam.js',
  'ui/views/practice.js', 'ui/views/review.js', 'ui/views/wizard.js',
  'ui/settings.js', 'ui/palette.js',
  'flow-client.js', 'md.js', 'research-progress.js',
]

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
      // 这些实现已经移入 ui/chat.js 与 ui/views/*，页面里不应再有副本。
      for (const duplicated of ['function maybeChips', 'function handleLine', 'function submitChips', 'function colorizeCost', 'function setBusy']) {
        assert.equal(html.includes(duplicated), false, `${file} 不应再定义 ${duplicated}`)
      }
    }
  })

  it('课堂与大考页面只是共享视图的薄壳', () => {
    assert.match(read('lesson.html'), /TutorViews\.learn\(/, 'lesson.html 应挂载共享课堂视图')
    assert.match(read('exam.html'), /TutorViews\.exam\(/, 'exam.html 应挂载共享大考视图')
    assert.match(read('index.html'), /TutorViews\.home\(/, 'index.html 应挂载共享看板视图')
    assert.match(read('practice.html'), /TutorViews\.practice\(/, 'practice.html 应挂载共享实践视图')
    assert.match(read('review.html'), /TutorViews\.review\(/, 'review.html 应挂载共享复习视图')
    assert.match(read('wizard.html'), /TutorViews\.wizard\(/, 'wizard.html 应挂载共享向导视图')
    for (const file of ['lesson.html', 'exam.html', 'index.html', 'practice.html', 'review.html', 'wizard.html']) {
      const html = read(file)
      assert.equal(/function renderList|function renderStatus|function maybeChips|function handleLine|function renderNode/.test(html), false, `${file} 不应再内联视图实现`)
    }
  })

  it('单壳工作区按哈希路由挂载视图，旧流程回落到独立页面', () => {
    const shell = read('app.html')
    assert.match(shell, /<script src="\/ui\/app\.js"><\/script>/, '单壳应加载路由脚本')
    assert.match(shell, /id="app-rail"|class="app-rail"/, '单壳应有左栏')
    assert.match(shell, /id="app-canvas"/, '单壳应有画布')
    const app = read('ui/app.js')
    for (const view of ['TutorViews.home', 'TutorViews.learn', 'TutorViews.exam', 'TutorViews.practice', 'TutorViews.review', 'TutorViews.wizard']) {
      assert.ok(app.includes(view), `单壳应挂载 ${view}`)
    }
    assert.match(app, /LEGACY/, '未迁入单壳的流程应回落到旧页面而不是死胡同')
  })

  it('设置页与单壳抽屉共用同一份设置表单逻辑', () => {
    assert.match(read('settings.html'), /TutorSettings\.mount\(/, '设置页应挂载共享设置表单')
    assert.match(read('ui/app.js'), /TutorSettings\.mount\(/, '单壳抽屉应挂载共享设置表单')
    assert.equal(read('settings.html').includes('function updateKeyHint'), false, '设置页不应再内联表单逻辑')
  })

  it('命令面板与多行输入组件已就位', () => {
    assert.match(read('ui/palette.js'), /metaKey \|\| event\.ctrlKey/, '命令面板应支持 ⌘K / Ctrl+K')
    assert.match(read('ui/chat.js'), /bindComposer/, '聊天组件应支持多行输入绑定')
    assert.match(read('ui/chat.js'), /event\.shiftKey/, 'Enter 发送、Shift+Enter 换行')
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
