import { it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createTutorServer } from '../src/server/http.ts'
import { activity, SKILL, scriptedTransport, systemFixture, toolReply, ROOT } from './fixtures/tutor.ts'

function longHistory(system: ReturnType<typeof systemFixture>['system']) {
  for (let index = 0; index < 18; index++)
    system.service.message(
      'alpha',
      '此前的讨论 ' +
        (index + 1) +
        '\n\n' +
        '我们已经讨论过这个例子，接下来根据你的回答继续调整学习安排。'.repeat(8),
      'history-' + index,
      'history',
      system.repository.read('alpha').revision,
      '前期讨论',
    )
}
import { browser, hasChrome } from './fixtures/browser.ts'
import { judgmentFetch, noulReply } from './fixtures/judgment.ts'
import { ESCAPED_LESSON } from './fixtures/markdown.ts'

it('网页能创建目标、接受 agent 活动、选择答案并显示真实反馈', { skip: !hasChrome }, async (t) => {
  const content = activity()
  content.kind = 'diagnostic'
  content.questions[0] = {
    ...content.questions[0],
    type: 'choice',
    answer: 'A',
    choices: ['5', '6', '7', '8'],
  }
  const fixture = systemFixture(
    t,
    scriptedTransport([
      toolReply('update_curriculum', { skills: [SKILL], reason: '先明确需要检验的能力' }),
      toolReply('present_activity', content),
      toolReply('ask_learner', {
        question: '你希望继续还是先回顾一下？',
        reason: '根据刚才的作答决定下一步',
      }),
    ]),
  )
  const app = createTutorServer(fixture.options)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.server.closeAllConnections()
    await app.close()
  })
  const base = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port
  const page = await browser(t, base + '/app.html#/new')
  await page.wait('!!document.querySelector("#goal-form")')
  await page.evaluate(
    'document.querySelector("#new-goal").value="掌握整数加法";document.querySelector("#goal-form").requestSubmit()',
  )
  await page.wait('!!document.querySelector(".choice") && !document.querySelector(".choice").disabled')
  const body = await page.evaluate<string>('document.body.innerText')
  assert.match(body, /独立完成计算/)
  const courseId = await page.evaluate<string>('location.hash.split("/")[2]')
  await page.evaluate(
    'document.querySelector(".choice").click();document.querySelector("#answer-form").requestSubmit()',
  )
  await page.wait('!!document.querySelector(".message.grade")')
  assert.match(await page.evaluate<string>('document.body.innerText'), /100%/)
  assert.equal(app.system.service.view(courseId).supported, 0)
})

it('已保存的双转义教学活动显示为段落、列表和引用，刷新不改写原文', { skip: !hasChrome }, async (t) => {
  const fixture = systemFixture(t, scriptedTransport([]))
  const app = createTutorServer(fixture.options)
  app.system.service.create({ id: 'alpha', goal: '学会英语闲聊中的回应与具体追问' })
  const skill = {
    ...SKILL,
    id: 'followup',
    title: '回应与追问',
    description: '回应信息并提出相关的具体问题',
    criteria: [{ id: 'followup-structure', description: '回应、个人细节和相关追问完整', critical: true }],
  }
  app.system.service.updateCurriculum('alpha', { skills: [skill], reason: '显示验证' }, 'seed', 0)
  const content = activity('', '', {
    kind: 'practice',
    title: '接住话轮：先回应，再具体追问',
    body: ESCAPED_LESSON,
    skillIds: ['followup'],
    questions: [
      {
        id: 'q1',
        type: 'open',
        prompt: '请写三句英语回复',
        answer: 'That sounds busy. I also changed jobs last year. What do you like most about your new team?',
        criterionIds: ['followup-structure'],
        dimension: 'application',
        difficulty: 2,
      },
    ],
  })
  app.system.service.presentActivity('alpha', content, 'present', 1, 'display-test')
  const revision = app.system.repository.read('alpha').revision
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.server.closeAllConnections()
    await app.close()
  })
  const page = await browser(
    t,
    'http://127.0.0.1:' + (app.server.address() as { port: number }).port + '/app.html#/course/alpha',
  )
  await page.wait('!!document.querySelector(".message blockquote")')
  assert.equal(await page.evaluate('document.querySelectorAll(".message ol li").length'), 3)
  assert.equal(await page.evaluate('document.querySelectorAll(".message ul li").length'), 3)
  assert.equal(await page.evaluate('document.querySelector(".message").innerText.includes("\\\\n")'), false)
  await page.evaluate('document.querySelector("#refresh-study").click()')
  await page.wait('!!document.querySelector(".message blockquote")')
  assert.equal(app.system.service.view('alpha').active!.body, ESCAPED_LESSON)
  assert.equal(app.system.repository.read('alpha').revision, revision)
  assert.equal(app.system.usageLedger.read().length, 0)
})

it('提交失败恢复控件，刷新与 SSE 重连不复制反馈', { skip: !hasChrome }, async (t) => {
  const content = activity()
  content.questions[0] = {
    ...content.questions[0],
    type: 'open',
    prompt: '解释 2+3 的合并过程',
    answer: '两个和三个合成五个',
  }
  const fixture = systemFixture(
    t,
    scriptedTransport([
      toolReply('present_activity', content),
      toolReply('ask_learner', { question: '需要继续吗？', reason: '等待下一步' }),
    ]),
  )
  fixture.system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  fixture.system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  const app = createTutorServer(fixture.options)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.server.closeAllConnections()
    await app.close()
  })
  const base = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port
  app.system.start('alpha', { requestId: 'first' })
  await app.system.wait('alpha')
  const page = await browser(t, base + '/app.html#/course/alpha')
  await page.wait('!!document.querySelector(".answer-box")')
  await page.evaluate(
    'window.__fetch=window.fetch;window.fetch=(url,options)=>String(url).endsWith("/answer")?Promise.resolve(new Response(JSON.stringify({ok:false,error:{message:"测试临时失败"}}),{status:503,headers:{"content-type":"application/json"}})):window.__fetch(url,options);document.querySelector(".answer-box").value="我的完整解释";document.querySelector(".answer-box").dispatchEvent(new Event("input"));document.querySelector("#answer-form").requestSubmit()',
  )
  await page.wait(
    'document.querySelector(".question-error") && !document.querySelector(".submit-answer").disabled',
  )
  assert.equal(await page.evaluate('document.querySelector(".answer-box").value'), '我的完整解释')
  await page.evaluate('window.fetch=window.__fetch')
  await page.evaluate('document.querySelector("#answer-form").requestSubmit()')
  await page.wait('!!document.querySelector(".message.grade")')
  const count = await page.evaluate<number>('document.querySelectorAll(".message.grade").length')
  await page.evaluate('document.querySelector("#refresh-study").click()')
  await page.wait('document.querySelectorAll(".message.grade").length > 0')
  assert.equal(await page.evaluate<number>('document.querySelectorAll(".message.grade").length'), count)
})

it('页面刷新后从服务端恢复未提交的多行草稿', { skip: !hasChrome }, async (t) => {
  const content = activity()
  content.questions[0] = {
    ...content.questions[0],
    type: 'open',
    prompt: '解释合并过程',
    answer: '合并得到五个',
  }
  const fixture = systemFixture(t, scriptedTransport([toolReply('present_activity', content)]))
  fixture.system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  fixture.system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  const app = createTutorServer(fixture.options)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.server.closeAllConnections()
    await app.close()
  })
  const base = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port
  app.system.start('alpha', { requestId: 'first' })
  await app.system.wait('alpha')
  const page = await browser(t, base + '/app.html#/course/alpha')
  await page.wait('!!document.querySelector(".answer-box")')
  await page.evaluate(
    'document.querySelector(".answer-box").value="第一行\\n第二行";document.querySelector(".answer-box").dispatchEvent(new Event("input"))',
  )
  await page.wait(
    '(async()=>{const result=await fetch("/api/courses/alpha").then(r=>r.json());return result.course.active.draft.text==="第一行\\n第二行"})()',
  )
  await page.evaluate('sessionStorage.clear()')
  await page.command('Page.reload', {})
  await page.wait('document.querySelector(".answer-box")?.value === "第一行\\n第二行"')
  assert.equal(
    app.system.repository.read('alpha').evidence.filter((item) => item.kind === 'answer').length,
    0,
  )
})

it('设置页能切换判断方式，连接测试不启用配置，保存后可再次关闭', { skip: !hasChrome }, async (t) => {
  let calls = 0
  let requestedUrl = '',
    requestedModel = ''
  const fixture = systemFixture(t, scriptedTransport([]))
  const app = createTutorServer({
    ...fixture.options,
    judgmentFetch: judgmentFetch((request, url) => {
      calls++
      requestedUrl = url
      requestedModel = request.model
    }, noulReply),
  })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.server.closeAllConnections()
    await app.close()
  })
  const page = await browser(
    t,
    'http://127.0.0.1:' + (app.server.address() as { port: number }).port + '/app.html',
  )
  await page.wait('!!document.querySelector("#top-settings")')
  await page.evaluate('document.querySelector("#top-settings").click()')
  await page.wait('document.querySelector(".settings-form fieldset")?.disabled === false')
  assert.equal(await page.evaluate('document.querySelector("[name=judgmentProvider]").value'), 'llm')
  assert.equal(await page.evaluate('document.querySelector(".typesafe-fields").hidden'), true)
  await page.evaluate(
    'document.querySelector(".judgment-settings").open=true;document.querySelector("[name=judgmentProvider]").value="typesafe";document.querySelector("[name=judgmentProvider]").dispatchEvent(new Event("change"))',
  )
  assert.equal(await page.evaluate('document.querySelector(".typesafe-fields").hidden'), false)
  assert.equal(await page.evaluate('document.querySelector("[name=judgmentApiKey]").required'), true)
  await page.evaluate(
    'document.querySelector("[name=judgmentApiKey]").value="browser-fast-secret";document.querySelector("[name=reviewModel]").value="review-fixture";document.querySelector("[name=judgmentConfidence]").value="95.5";document.querySelector("[name=judgmentSeconds]").value="1.234";document.querySelector("[name=judgmentBaseUrl]").value="https://emrank.tech/v1/decisions";document.querySelector("[name=judgmentUrlMode]").value="endpoint";document.querySelector("[name=judgmentUrlMode]").dispatchEvent(new Event("change"));document.querySelector("[name=judgmentQuestionType]").value="noul";document.querySelector("[name=judgmentQuestionType]").dispatchEvent(new Event("change"));document.querySelector("[name=judgmentModel]").value="commandcode/jev-1.14.0";document.querySelector(".settings-judge-test").click()',
  )
  await page.wait('document.querySelector(".settings-status").textContent.includes("已连通")')
  assert.equal(app.system.models.publicConfig().judgment.provider, 'llm')
  assert.equal(requestedUrl, 'https://emrank.tech/v1/decisions')
  assert.equal(requestedModel, 'commandcode/jev-1.14.0')
  await page.evaluate('document.querySelector(".settings-form").requestSubmit()')
  await page.wait('document.querySelector(".settings-status").textContent.includes("已保存")')
  assert.equal(app.system.models.publicConfig().judgment.provider, 'typesafe')
  assert.equal(app.system.models.publicConfig().judgment.minimumConfidence, 0.955)
  assert.equal(app.system.models.publicConfig().judgment.timeoutMs, 1234)
  assert.equal(app.system.models.publicConfig().judgment.urlMode, 'endpoint')
  assert.equal(app.system.models.publicConfig().judgment.questionType, 'noul')
  assert.equal(await page.evaluate('document.querySelector("[name=judgmentApiKey]").value'), '')
  assert.equal(JSON.stringify(app.system.models.publicConfig()).includes('browser-fast-secret'), false)
  await page.evaluate(
    'document.querySelector("[name=judgmentProvider]").value="llm";document.querySelector("[name=judgmentProvider]").dispatchEvent(new Event("change"));document.querySelector(".settings-form").requestSubmit()',
  )
  await page.wait(
    '(async()=>{const result=await fetch("/api/model-config").then(r=>r.json());return result.config.judgment.provider==="llm"})()',
  )
  assert.equal(app.system.models.environment().TUTOR_JUDGMENT_PROVIDER, 'llm')
  assert.equal(await page.evaluate('document.querySelector(".typesafe-fields").hidden'), true)
  assert.equal(calls, 1)
})

it('长对话底部提交后立即显示处理状态，滚动历史时仍能暂停并恢复', { skip: !hasChrome }, async (t) => {
  let release!: () => void
  const grading = new Promise<void>((resolve) => {
    release = resolve
  })
  t.after(() => release())
  const transport = scriptedTransport([toolReply('continue_activity', { reason: '继续下一题' })])
  const fixture = systemFixture(t, async (request, signal, onChunk) => {
    if (
      request.messages.some((message) => message.role === 'system' && message.content?.includes('独立阅卷员'))
    ) {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        grading.then(resolve)
      })
    }
    return transport(request, signal, onChunk)
  })
  const app = createTutorServer(fixture.options)
  app.system.service.create({ id: 'alpha', goal: '掌握整数加法' })
  app.system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
  longHistory(app.system)
  const content = activity()
  content.questions[0].type = 'open'
  content.questions.push({ ...content.questions[0], id: 'q2', prompt: '5+6=?', answer: '11' })
  app.system.service.presentActivity(
    'alpha',
    content,
    'present',
    app.system.repository.read('alpha').revision,
    'seed',
  )
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(async () => {
    app.server.closeAllConnections()
    await app.close()
  })
  const base = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port
  const page = await browser(t, base + '/app.html#/course/alpha')
  await page.wait('!!document.querySelector(".answer-box")')
  await page.command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await page.wait('innerWidth === 1280')
  const immediate = await page.evaluate<{
    label: string
    busy: string
    disabled: boolean
    visible: boolean
    scroll: number
  }>(
    'window.scrollTo(0,document.body.scrollHeight);window.__fetch=window.fetch;window.fetch=async(url,options)=>{const response=await window.__fetch(url,options);if(String(url).endsWith("/answer"))await new Promise(resolve=>window.__releaseAnswer=resolve);return response};document.querySelector(".answer-box").value="5";document.querySelector(".answer-box").dispatchEvent(new Event("input"));document.querySelector("#answer-form").requestSubmit();(()=>{const submit=document.querySelector(".submit-answer"),rect=document.querySelector("#tutor-status").getBoundingClientRect();return{label:submit.textContent,busy:submit.getAttribute("aria-busy"),disabled:submit.disabled,visible:rect.top>=0&&rect.bottom<=innerHeight,scroll:scrollY}})()',
  )
  assert.equal(immediate.busy, 'true')
  assert.match(immediate.label, /提交中/)
  assert.equal(immediate.disabled, true)
  assert.equal(immediate.visible, true)
  assert.ok(immediate.scroll > 1500)
  await page.wait('typeof window.__releaseAnswer === "function"')
  await page.evaluate('window.__releaseAnswer()')
  await page.wait(
    '!document.querySelector(".pause-processing").disabled && parseInt(document.querySelector("#tutor-status .elapsed").textContent)>=1',
  )
  await page.evaluate('window.scrollTo(0,100)')
  await page.wait('document.querySelector("#tutor-status").classList.contains("floating")')
  const floating = await page.evaluate(
    '(()=>{const r=document.querySelector("#tutor-status").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()',
  )
  assert.equal(floating, true)
  fs.mkdirSync(path.join(ROOT, 'data/evals/ui'), { recursive: true })
  await page.screenshot(path.join(ROOT, 'data/evals/ui/interaction-status-busy.png'), false)
  await page.command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await page.wait(
    'document.querySelector("#rail").getBoundingClientRect().right<=1 && document.querySelector("#tutor-status").getBoundingClientRect().right<=innerWidth',
  )
  assert.equal(
    await page.evaluate(
      'document.body.scrollWidth<=innerWidth && document.querySelector("#tutor-status").getBoundingClientRect().left>=0',
    ),
    true,
  )
  await page.screenshot(path.join(ROOT, 'data/evals/ui/interaction-status-mobile.png'), false)
  await page.evaluate('document.querySelector(".pause-processing").click()')
  await page.wait(
    'document.querySelector("#tutor-status .phase").textContent.includes("已暂停") && !document.querySelector("#tutor-status").classList.contains("floating")',
  )
  const paused = app.system.repository.read('alpha')
  assert.equal(paused.pendingAnswer!.questionId, 'q1')
  assert.equal(
    app.system.repository.asset<{ answer: string }>('alpha', paused.pendingAnswer!.asset).answer,
    '5',
  )
  release()
  await page.evaluate(
    'window.scrollTo(0,document.body.scrollHeight);[...document.querySelectorAll("#question-panel button")].find(button=>button.textContent.includes("恢复评分")).click()',
  )
  await page.wait(
    'document.querySelector(".question-prompt")?.textContent.includes("5+6") && !document.querySelector(".submit-answer").disabled',
  )
  assert.equal(
    app.system.repository.read('alpha').evidence.filter((item) => item.kind === 'answer').length,
    1,
  )
  assert.equal(
    await page.evaluate('document.querySelector(".send-message").getAttribute("aria-busy")'),
    'false',
  )
})

it(
  '反馈发送的等待提示靠近输入区，提前到达的 SSE 完成不会让按钮或状态卡住',
  { skip: !hasChrome },
  async (t) => {
    const fixture = systemFixture(
      t,
      scriptedTransport([
        toolReply('ask_learner', { question: '我们按这个思路继续看一个例子。', reason: '回答学员反馈' }),
      ]),
    )
    const app = createTutorServer(fixture.options)
    app.system.service.create({ id: 'alpha', goal: '掌握整数加法' })
    app.system.service.updateCurriculum('alpha', { skills: [SKILL], reason: '近期目标' }, 'seed', 0)
    longHistory(app.system)
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    t.after(async () => {
      app.server.closeAllConnections()
      await app.close()
    })
    const page = await browser(
      t,
      'http://127.0.0.1:' + (app.server.address() as { port: number }).port + '/app.html#/course/alpha',
    )
    await page.wait('!!document.querySelector("#feedback-input")')
    const immediate = await page.evaluate<{ label: string; busy: string; visible: boolean }>(
      'window.scrollTo(0,document.body.scrollHeight);window.__fetch=window.fetch;window.fetch=async(url,options)=>{const response=await window.__fetch(url,options);if(String(url).endsWith("/turn"))await new Promise(resolve=>window.__releaseTurn=resolve);return response};document.querySelector("#feedback-input").value="请进一步解释";document.querySelector(".send-message").click();(()=>{const button=document.querySelector(".send-message"),r=document.querySelector("#tutor-status").getBoundingClientRect();return{label:button.textContent,busy:button.getAttribute("aria-busy"),visible:r.top>=0&&r.bottom<=innerHeight}})()',
    )
    assert.match(immediate.label, /发送中/)
    assert.equal(immediate.busy, 'true')
    assert.equal(immediate.visible, true)
    await page.wait(
      'typeof window.__releaseTurn === "function" && document.body.innerText.includes("我们按这个思路继续看一个例子")',
    )
    assert.equal(await page.evaluate('document.querySelector(".send-message").disabled'), true)
    await page.evaluate('window.__releaseTurn()')
    await page.wait(
      '!document.querySelector(".send-message").disabled && document.querySelector("#feedback-input").value === ""',
    )
    assert.equal(
      await page.evaluate('document.querySelector(".send-message").getAttribute("aria-busy")'),
      'false',
    )
    assert.equal(
      await page.evaluate('document.querySelector("#tutor-status .phase").textContent'),
      '轮到你了',
    )
    assert.equal(
      app.system.repository
        .read('alpha')
        .evidence.filter((item) => item.kind === 'feedback' && item.summary === '请进一步解释').length,
      1,
    )
  },
)
