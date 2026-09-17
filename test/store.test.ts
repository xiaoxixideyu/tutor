import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CourseStore } from '../src/core/store.ts'

const profile = {
  goal: '掌握 Go 后端开发，能独立完成 Web 服务',
  deadline: '2026-12-31',
  daily_minutes: 60,
  background: '有 5 年 Java 后端经验',
  style: '例子驱动，先动手后理论',
}

const tmpRoots: string[] = []

function makeStore(): CourseStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-test-'))
  tmpRoots.push(dir)
  return new CourseStore(dir)
}

after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
})

describe('CourseStore', () => {
  it('create 脚手架目录 + 写 profile，list/exists 可见', () => {
    const store = makeStore()
    store.create('golang', profile)
    assert.equal(store.exists('golang'), true)
    assert.deepEqual(store.list(), ['golang'])
    const dir = path.join(store.root, 'golang')
    for (const entry of ['profile.yaml', 'materials', 'sessions']) {
      assert.equal(fs.existsSync(path.join(dir, entry)), true, entry)
    }
  })

  it('重复 create 报错', () => {
    const store = makeStore()
    store.create('golang', profile)
    assert.throws(() => store.create('golang', profile), /已存在/)
  })

  it('非法课程 id 报错（含路径穿越）', () => {
    const store = makeStore()
    assert.throws(() => store.create('../evil', profile), /非法/)
    assert.throws(() => store.create('Big Cat', profile), /非法/)
  })

  it('profile 非法时 create 失败且不留半成品目录', () => {
    const store = makeStore()
    assert.throws(() => store.create('golang', { goal: 123 }), /校验失败/)
    assert.equal(fs.existsSync(path.join(store.root, 'golang')), false)
  })

  it('mastery 写入并读回，round-trip 保真', () => {
    const store = makeStore()
    store.create('golang', profile)
    const mastery = { goroutines: { status: 'learning', score: 0.6, review_due: '2026-09-09' } }
    store.write('golang', 'mastery', mastery)
    assert.deepEqual(store.read('golang', 'mastery'), mastery)
  })

  it('不存在的课程读写报错', () => {
    const store = makeStore()
    assert.throws(() => store.read('nope', 'profile'), /不存在/)
    assert.throws(() => store.write('nope', 'plan', { path: [] }), /不存在/)
  })

  it('缺少对应文档时 read 报错', () => {
    const store = makeStore()
    store.create('golang', profile)
    assert.throws(() => store.read('golang', 'plan'), /缺少 plan\.yaml/)
  })

  it('改写保留未动字段的注释，删除不再存在的键', () => {
    const store = makeStore()
    store.create('golang', profile)
    const file = path.join(store.root, 'golang', 'profile.yaml')
    const withComments = [
      '# 手改注释：目标不要动',
      'goal: 掌握 Go 后端开发，能独立完成 Web 服务',
      'deadline: "2026-12-31"',
      'daily_minutes: 60',
      'background: 有 5 年 Java 后端经验',
      'style: 例子驱动，先动手后理论',
      '',
    ].join('\n')
    fs.writeFileSync(file, withComments)

    store.write('golang', 'profile', {
      goal: '掌握 Go 后端开发，能独立完成 Web 服务',
      deadline: '2026-12-31',
      daily_minutes: 90,
    })

    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /# 手改注释：目标不要动/)
    assert.match(text, /daily_minutes: 90/)
    assert.doesNotMatch(text, /background/)
    const out = store.read('golang', 'profile') as Record<string, unknown>
    assert.equal(out.daily_minutes, 90)
    assert.equal('background' in out, false)
  })

  it('写盘原子：不残留临时文件', () => {
    const store = makeStore()
    store.create('golang', profile)
    store.write('golang', 'mastery', { goroutines: { status: 'mastered', score: 1 } })
    const leftovers = fs.readdirSync(path.join(store.root, 'golang')).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
  })
})
