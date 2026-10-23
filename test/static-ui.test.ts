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
    assert.match(app, /view === 'practice' \|\| view === 'research' \? tail\[0\]/, '实践/教研的节点参数在第三段，不能被当成大考里程碑')
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

  it('流程恢复不把 flowId 写进地址栏，避免之后进入向导时误认旧流程', () => {
    for (const file of ['ui/views/wizard.js', 'ui/views/exam.js']) {
      assert.doesNotMatch(read(file), /history\.replaceState/, `${file} 不应改写地址栏查询串`)
    }
    const app = read('ui/app.js')
    assert.doesNotMatch(app, /get\('flowId'\)/, '路由不应从查询串读取 flowId')
    assert.match(app, /location\.search\) history\.replaceState/, '单壳启动时应清理旧版残留查询串')
  })

  it('内容未过审时看板与详情只给重审入口，不提供会失败的课堂/实践入口', () => {
    const home = read('ui/views/home.js')
    assert.match(home, /blocked\s*\?\s*\{ label: '重新审查 →'/, '看板主入口应切换为重审')
    assert.match(home, /const blocked = p\.contentReady === false/, '详情页应判定内容准入')
    assert.match(home, /warnSection[\s\S]{0,600}重新审查/, '详情页应展示准入审查提示')
    assert.match(home, /n\.practiceCount \|\| !blocked/, '未过审且未生成实践时不应给生成入口')
    assert.match(read('ui/views/practice.js'), /renderGatePrompt/, '实践视图应识别内容闸门')
    assert.match(read('ui/views/learn.js'), /gateNotice/, '课堂视图应识别内容闸门')
    assert.match(read('ui/views/exam.js'), /gateNotice/, '大考视图应识别内容闸门')
  })

  it('复习提交前在题内标出漏答，而不是只在顶栏提示', () => {
    const review = read('ui/views/review.js')
    assert.match(review, /class="formerr"/, '应有题内错误提示')
    assert.match(review, /classList\.add\('missing'\)/, '应标出未作答的题目')
    assert.match(review, /scrollIntoView/, '应定位到第一道漏答题')
  })

  it('向导提供停止入口，长时间教研/审查可从当前页取消', () => {
    const wizard = read('ui/views/wizard.js')
    assert.match(wizard, /class="wizard-stop"/, '向导应有停止按钮')
    assert.match(wizard, /api\('\/flow\/stop'\)/, '停止按钮应调用停止接口')
  })

  it('访谈档案 JSON、本机路径与生成失败诊断不直接堆进对话', () => {
    const wizard = read('ui/views/wizard.js')
    assert.match(wizard, /skipJson/, '访谈应过滤档案 JSON')
    assert.match(wizard, /能力画像已写入/, '应过滤能力画像路径')
    assert.match(wizard, /教学计划已生成（/, '应去掉计划路径')
    assert.match(wizard, /flowFailure/, '生成失败应使用折叠的技术细节卡片')
    assert.match(read('ui/dom.js'), /function flowFailure/, '应提供共享生成失败卡片')
  })

  it('活动中的访谈从侧栏回到新课程向导，而不是不存在的课程详情', () => {
    for (const file of ['ui/app.js', 'ui/views/home.js']) {
      assert.match(read(file), /flow\.kind === 'new'\) return '#\/new'/, `${file} 应把访谈流程指回向导`)
    }
  })

  it('课堂/大考准备期间仍可暂停，停止按钮不会误发一条消息', () => {
    for (const file of ['ui/views/learn.js', 'ui/views/exam.js']) {
      assert.match(read(file), /stopButton: \$stop/, `${file} 应把停止按钮交给共享聊天组件管理`)
    }
    assert.match(read('ui/views/learn.js'), /if \(!button\.dataset\.cmd\) continue/, '快捷按钮循环应跳过停止按钮')
    assert.match(read('ui/chat.js'), /本轮已结束，请使用上方操作/, '流程结束后输入框不应继续提示“轮到你了”')
  })

  it('课程详情可直接继续上课，生成类内部审查不刷屏', () => {
    const home = read('ui/views/home.js')
    assert.match(home, /const lessonBtn = p\.hasPlan/, '详情页应有继续上课入口')
    assert.match(home, /go-lesson/, '详情页上课按钮应能导航')
    const chat = read('ui/chat.js')
    assert.match(chat, /prettyReview/, '课堂/大考的审查进度应翻译并收敛')
    assert.match(chat, /内容审查发现 \$\{count\} 处问题，正在自动修复/, '单次拦截应作为修复进度')
    for (const file of ['ui/views/learn.js', 'ui/views/exam.js']) {
      assert.match(read(file), /TutorDom\.flowFailure/, `${file} 生成失败应使用折叠诊断卡片`)
    }
  })

  it('已有课程不能再开一次访谈；详情页有流程在跑时只提供继续入口', () => {
    const wizard = read('ui/views/wizard.js')
    assert.match(wizard, /courses\.some\(\(course\) => course\.id === id\)/, '开课前应阻止重复课程标识')
    assert.match(wizard, /\$courseInput\.addEventListener\('keydown'/, '课程标识输入框应支持回车开课')
    const home = read('ui/views/home.js')
    assert.match(home, /const runningSection = running/, '详情页应提示正在进行的流程')
    assert.match(home, /p\.hasPlan && !running/, '有流程在跑时不应再给实践入口')
    assert.match(home, /const resetBtn = running \? ''/, '有流程在跑时不应显示断点清理')
    assert.match(home, /watchFlow/, '详情页应轮询并在流程结束后恢复操作')
  })

  it('复习选项带字母、提交后禁用，结果页不再出现两个重复的返回列表按钮', () => {
    const review = read('ui/views/review.js')
    assert.match(review, /choice-letter/, '复习选项应显示 A/B/C 字母')
    assert.match(review, /choice\.disabled = true/, '提交后选项应真正禁用')
    assert.match(review, /← 课程详情/, '复习结果应能返回课程详情')
    assert.match(review, /没有到期的复习/, '无到期复习时应更新顶栏状态')
    assert.match(read('ui/views/practice.js'), /TutorDom\.flowFailure/, '实践生成失败应使用折叠诊断卡片')
  })

  it('教研进度面板在单壳有样式，从详情启动教研时也会连接', () => {
    assert.match(read('app.html'), /research-progress\.css/, '单壳应加载教研进度样式')
    assert.match(read('ui/views/wizard.js'), /kind === 'research'\) researchLive\.connect/, '从详情启动教研时应连接进度面板')
    assert.match(read('research-progress.js'), /查看课程详情/, '进度面板链接应指向课程详情而不是同一页')
  })

  it('视图卸载时清掉聊天/教研计时器，长会话不累积泄漏', () => {
    assert.match(read('ui/chat.js'), /destroy\(\)[\s\S]{0,120}clearInterval\(this\.busyTimer\)/, '聊天组件应清理忙态计时器')
    for (const file of ['ui/views/learn.js', 'ui/views/exam.js']) {
      assert.match(read(file), /chat\.destroy\(\)/, `${file} 卸载时应清理聊天计时器`)
    }
    assert.match(read('research-progress.js'), /clearInterval\(this\.poll\)/, '教研进度应清理轮询')
    assert.match(read('research-progress.js'), /clearInterval\(this\.clock\)/, '教研进度应清理秒表')
    assert.match(read('ui/views/wizard.js'), /researchLive\.destroy\(\)/, '向导卸载时应销毁教研进度')
  })
})
