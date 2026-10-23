import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const staticDir = path.join(root, 'static')
// 旧版单页已下线：网页只剩单壳 /app.html + 共享视图。
const pages = ['app.html']
const sharedScripts = [
  'ui/dom.js', 'ui/rpc.js', 'ui/chat.js', 'ui/app.js',
  'ui/views/home.js', 'ui/views/learn.js', 'ui/views/exam.js',
  'ui/views/practice.js', 'ui/views/review.js', 'ui/views/wizard.js',
  'flow-client.js', 'md.js', 'research-progress.js',
]

function read(file: string): string {
  return fs.readFileSync(path.join(staticDir, file), 'utf8')
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


  it('内部运行提示不进聊天记录；旧成本行静默丢弃', () => {
    const chat = read('ui/chat.js')
    // 排队/限速提示属于内部提示：应被识别为 op 状态，而不是聊天气泡
    assert.match(chat, /OP_ERR_RE = .*按共享队列每分钟/, '排队提示应被识别为内部提示')
    assert.match(chat, /LEGACY_COST_RE\.test\(trimmed\)/, '旧成本行应被静默过滤')
    // 旧会话以成本行收尾时仍要闭合气泡并转成选项按钮
    assert.match(chat, /TURN_COST_RE\.test\(trimmed\)[\s\S]{0,200}maybeChips\(closed\)/, '成本行收尾时也要生成选项按钮')
    assert.doesNotMatch(chat, /colorizeCost|class="cost"/, '聊天壳不应再渲染成本行')
  })

  it('旧版单页已下线，只保留单壳', () => {
    for (const legacy of ['index.html', 'lesson.html', 'exam.html', 'practice.html', 'review.html', 'wizard.html', 'settings.html', 'settings.js']) {
      assert.equal(fs.existsSync(path.join(staticDir, legacy)), false, `${legacy} 应已删除`)
    }
    assert.match(read('app.html'), /id="app-canvas"/, '单壳应有画布')
    assert.match(read('app.html'), /class="app-rail"/, '单壳应有左栏')
  })

  it('课堂与大考复用同一套聊天组件与样式，不再各自复制', () => {
    const chat = read('ui/chat.js')
    for (const duplicated of ['function maybeChips', 'function handleLine', 'function submitChips', 'function setBusy']) {
      assert.equal(chat.includes(duplicated), false, `ui/chat.js 不应再定义 ${duplicated}`)
    }
    assert.match(chat, /class="chip"/, '共享组件应提供选项按钮')
    assert.doesNotMatch(chat, /colorizeCost|class="cost"/, '共享组件不应展示成本')
  })

  it('视图控制器只实现一次流程逻辑', () => {
    const views = {
      'ui/views/home.js': ['renderStatus', 'renderList'],
      'ui/views/learn.js': ['findLessonFlow', 'renderLearnContinue'],
      'ui/views/exam.js': ['startExam', 'renderExamDone'],
      'ui/views/practice.js': ['enterPractice', 'startPracticeGen'],
      'ui/views/review.js': ['renderNode', 'showResult'],
      'ui/views/wizard.js': ['resumeFrom', 'startFlow'],
    }
    for (const [file, functions] of Object.entries(views)) {
      const source = read(file)
      for (const fn of functions) assert.ok(source.includes(fn), `${file} 应包含 ${fn}`)
    }
    // 视图不得再自己实现聊天渲染（应由 ui/chat.js 提供）。
    for (const file of ['ui/views/learn.js', 'ui/views/exam.js']) {
      const source = read(file)
      assert.equal(/function maybeChips|function handleLine/.test(source), false, `${file} 不应自建聊天渲染`)
      assert.match(source, /new TutorChat\(/, `${file} 应使用共享聊天组件`)
    }
  })

  it('单壳按哈希路由挂载全部视图', () => {
    const app = read('ui/app.js')
    for (const view of ['TutorViews.home', 'TutorViews.learn', 'TutorViews.exam', 'TutorViews.practice', 'TutorViews.review', 'TutorViews.wizard']) {
      assert.ok(app.includes(view), `单壳应挂载 ${view}`)
    }
    assert.match(app, /LEGACY/, '未迁入单壳的流程应回落到单壳路由而不是死胡同')
    assert.match(app, /view: 'new'/, '单壳应支持开设新课程的入口')
  })

  it('模型设置与命令面板已就位', () => {
    assert.match(read('ui/settings.js'), /TutorSettings|settings-form/, '应有共享设置表单')
    assert.match(read('ui/palette.js'), /metaKey \|\| event\.ctrlKey/, '命令面板应支持 ⌘K / Ctrl+K')
    assert.match(read('ui/chat.js'), /bindComposer/, '聊天组件应支持多行输入绑定')
    assert.match(read('ui/chat.js'), /event\.shiftKey/, 'Enter 发送、Shift+Enter 换行')
  })

  it('课堂与大考的输入选择器必须匹配多行输入框', () => {
    for (const file of ['ui/views/learn.js', 'ui/views/exam.js']) {
      const source = read(file)
      assert.match(source, /<textarea/, `${file} 应使用多行输入`)
      assert.match(source, /querySelector\('\.chat-inputrow textarea'\)/, `${file} 的输入选择器应匹配 textarea`)
    }
  })
})
