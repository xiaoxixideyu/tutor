import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireCourseLock } from '../core/course-lock.ts'
import { DomainError, type ModelUsageEntry } from '../domain/model.ts'

export interface UsageRecord extends ModelUsageEntry {
  courseId: string
  day: string
}

export class UsageLedger {
  readonly file: string
  constructor(directory: string) {
    this.file = path.join(path.resolve(directory), 'model-usage.json')
  }
  read(): UsageRecord[] {
    if (!fs.existsSync(this.file)) return []
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!Array.isArray(value)) throw new Error('invalid')
      return value
    } catch {
      throw new DomainError('USAGE_UNAVAILABLE', '用量记录无法读取，已停止新的模型请求', 503)
    }
  }
  record(record: UsageRecord): void {
    const lock = acquireCourseLock(path.dirname(this.file), 'model-usage')
    try {
      const entries = this.read()
      const existing = entries.findIndex((item) => item.id === record.id)
      if (existing >= 0) entries[existing] = record
      else entries.push(record)
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(temporary, JSON.stringify(entries.slice(-10000)), { mode: 0o600 })
      fs.renameSync(temporary, this.file)
    } finally {
      lock.release()
    }
  }
  daily(day: string) {
    const entries = this.read().filter((item) => item.day === day)
    return {
      requests: entries.length,
      estimatedCost: entries.reduce((sum, item) => sum + item.estimatedCost, 0),
      unknown: entries.filter((item) => item.unknown).length,
    }
  }
}
