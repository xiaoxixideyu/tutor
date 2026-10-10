import path from 'node:path'
import { inspect } from 'node:util'

const escape = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const property = value => escape(value).replace(/,/g, '%2C').replace(/:/g, '%3A')

// 让失败详情也进入 Checks annotations；无需下载整份 Actions 日志即可定位断言。
export default async function* annotations(events) {
  for await (const event of events) {
    if (event.type !== 'test:fail') continue
    const data = event.data
    if (data.details?.error?.failureType === 'subtestsFailed') continue
    const location = data.file ? `file=${property(path.relative(process.cwd(), data.file))},line=${data.line ?? 1},` : ''
    const detail = inspect(data.details?.error, { depth: 5, colors: false }).slice(0, 12000)
    yield `::error ${location}title=${property(data.name)}::${escape(detail)}\n`
  }
}
