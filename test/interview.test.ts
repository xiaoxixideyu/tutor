import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractProfileJson, parseProfile, profileValidationError } from '../src/core/interview.ts'

const VALID_JSON = JSON.stringify({
  goal: '掌握 Go 后端开发',
  deadline: '2026-12-31',
  daily_minutes: 60,
  background: '5 年 Java 经验',
  style: '例子驱动',
})

describe('extractProfileJson', () => {
  it('从围栏代码块提取', () => {
    const text = `总结一下。\n\n\`\`\`json\n${VALID_JSON}\n\`\`\`\n`
    assert.deepEqual(extractProfileJson(text), JSON.parse(VALID_JSON))
  })

  it('从正文中的裸 JSON 提取', () => {
    const text = `好的，档案如下：${VALID_JSON} 请确认。`
    assert.deepEqual(extractProfileJson(text), JSON.parse(VALID_JSON))
  })

  it('无 JSON 返回 null', () => {
    assert.equal(extractProfileJson('你每天能投入多少时间学习？'), null)
  })

  it('残缺 JSON 返回 null', () => {
    assert.equal(extractProfileJson('档案：{"goal": " unfinished'), null)
  })
})

describe('parseProfile', () => {
  it('合法档案解析成功', () => {
    const profile = parseProfile(`\`\`\`json\n${VALID_JSON}\n\`\`\``)
    assert.ok(profile)
    assert.equal(profile.goal, '掌握 Go 后端开发')
    assert.equal(profile.daily_minutes, 60)
  })

  it('类型不合法返回 null（触发修正重试）', () => {
    const bad = JSON.stringify({ goal: 'x', daily_minutes: '60' })
    assert.equal(parseProfile(`\`\`\`json\n${bad}\n\`\`\``), null)
    assert.match(profileValidationError(`\`\`\`json\n${bad}\n\`\`\``) ?? '', /daily_minutes|number|expect/)
  })

  it('纯提问（无 JSON）返回 null 且无校验错误', () => {
    assert.equal(parseProfile('你想达到什么程度？'), null)
  })
})
