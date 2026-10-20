// 课程日期统一按“学习者当地日历日”计算。默认跟随本机时区；可用 TUTOR_TIMEZONE
// （IANA 名称，如 Asia/Shanghai）固定时区，避免 UTC+8 凌晨的学习被记到前一天。
export function dateInTimeZone(timeZone: string | undefined, date = new Date()): string {
  const zone = timeZone?.trim()
  if (zone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(date)
      const get = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value
      const year = get('year'), month = get('month'), day = get('day')
      if (year && month && day) return `${year}-${month}-${day}`
    } catch { /* 非法时区回退本机 */ }
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function localDate(date = new Date(), timeZone = process.env.TUTOR_TIMEZONE): string {
  return dateInTimeZone(timeZone, date)
}
