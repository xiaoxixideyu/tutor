import { it } from 'node:test'
import assert from 'node:assert/strict'
import { dateInTimeZone, localDate } from '../src/core/dates.ts'

it('按指定时区计算日历日，支持跨 UTC 日界', () => {
  const date = new Date('2026-10-19T17:30:00.000Z')
  assert.equal(dateInTimeZone('UTC', date), '2026-10-19')
  assert.equal(dateInTimeZone('Asia/Shanghai', date), '2026-10-20')
  assert.equal(dateInTimeZone('America/Los_Angeles', date), '2026-10-19')
})

it('非法时区回退本机日期', () => {
  const date = new Date('2026-10-19T12:00:00.000Z')
  assert.equal(dateInTimeZone('Not/AZone', date), dateInTimeZone(undefined, date))
  assert.match(dateInTimeZone('Not/AZone', date), /^\d{4}-\d{2}-\d{2}$/)
})

it('TUTOR_TIMEZONE 影响默认 today', () => {
  const previous = process.env.TUTOR_TIMEZONE
  process.env.TUTOR_TIMEZONE = 'Asia/Shanghai'
  try {
    assert.equal(localDate(new Date('2026-10-19T17:30:00.000Z')), '2026-10-20')
  } finally {
    if (previous === undefined) delete process.env.TUTOR_TIMEZONE
    else process.env.TUTOR_TIMEZONE = previous
  }
})
