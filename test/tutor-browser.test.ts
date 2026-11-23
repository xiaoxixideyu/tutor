import { it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createTutorServer } from '../src/server/http.ts'
import { activity, SKILL, scriptedTransport, systemFixture, toolReply } from './fixtures/tutor.ts'
import { browser, hasChrome } from './fixtures/browser.ts'

it('网页能创建目标、接受 agent 活动、选择答案并显示真实反馈', { skip: !hasChrome }, async (t) => {
  const content = activity()
  content.kind = 'diagnostic'
  content.questions[0] = { ...content.questions[0], type: 'choice', answer: 'A', choices: ['5', '6', '7', '8'] }
  const fixture = systemFixture(
    t,
    scriptedTransport([
      toolReply('update_curriculum', { skills: [SKILL], reason: '先明确需要检验的能力' }),
      toolReply('present_activity', content),
      toolReply('ask_learner', { question: '你希望继续还是先回顾一下？', reason: '根据刚才的作答决定下一步' }),
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
  await page.wait('document.querySelector(".question-error") && !document.querySelector(".submit-answer").disabled')
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
  content.questions[0] = { ...content.questions[0], type: 'open', prompt: '解释合并过程', answer: '合并得到五个' }
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
  assert.equal(app.system.repository.read('alpha').evidence.filter((item) => item.kind === 'answer').length, 0)
})
