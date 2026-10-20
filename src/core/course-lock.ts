// 课程级跨进程写锁：网页服务、CLI 流程和复习回写共用同一份课程状态，
// 不能只靠单进程内存互斥。锁文件放在 <coursesRoot>/.locks/，不参与课程枚举。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { COURSE_ID_PATTERN } from './store.ts'

const MALFORMED_LOCK_GRACE_MS = 30_000
const DEFAULT_STALE_MS = 24 * 60 * 60_000

interface LockInfo {
  pid: number
  hostname: string
  startedAt: string
  nonce: string
}

export interface CourseLock {
  release(): void
}

export class CourseBusyError extends Error {
  constructor(courseId: string, detail?: string) {
    super(`课程 "${courseId}" 正在被另一个进程/流程使用${detail ? `（${detail}）` : ''}；请先结束该流程，避免状态互相覆盖`)
    this.name = 'CourseBusyError'
  }
}

function lockFile(root: string, courseId: string): string {
  return path.join(path.resolve(root), '.locks', `${courseId}.lock`)
}

function readLock(file: string): LockInfo | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.hostname !== 'string' || !value.hostname
      || typeof value.startedAt !== 'string' || !value.startedAt
      || typeof value.nonce !== 'string' || !value.nonce) return undefined
    return value as LockInfo
  } catch {
    return undefined
  }
}

function ageMs(file: string): number {
  try { return Date.now() - fs.statSync(file).mtimeMs } catch { return 0 }
}

function stale(info: LockInfo | undefined, file: string, staleMs: number): boolean {
  // 刚创建、还没来得及写入内容的锁不能被后来者当成陈旧锁抢走。
  if (!info) return ageMs(file) > MALFORMED_LOCK_GRACE_MS
  if (info.hostname === os.hostname()) {
    if (info.pid === process.pid) return false
    try {
      process.kill(info.pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }
  // 不同主机无法可靠探测 pid，只在明显过久时回收，避免永久锁死共享目录。
  const started = Date.parse(info.startedAt)
  return Number.isFinite(started) ? Date.now() - started > staleMs : ageMs(file) > staleMs
}

function release(file: string, nonce: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>
    if (current.nonce !== nonce) return
    fs.unlinkSync(file)
  } catch { /* 已被回收或从未写入 */ }
}

export function acquireCourseLock(root: string, courseId: string, options: { staleMs?: number } = {}): CourseLock {
  if (!COURSE_ID_PATTERN.test(courseId)) throw new Error(`课程 id "${courseId}" 非法`)
  const file = lockFile(root, courseId)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const nonce = randomUUID()
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), nonce }
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  for (let attempt = 0; attempt < 3; attempt++) {
    let created = false
    let fd: number | undefined
    try {
      fd = fs.openSync(file, 'wx', 0o600)
      created = true
      fs.writeFileSync(fd, JSON.stringify(info) + '\n')
      fs.closeSync(fd)
      fd = undefined
      return { release: () => release(file, nonce) }
    } catch (error) {
      if (fd !== undefined) try { fs.closeSync(fd) } catch { /* 已关闭 */ }
      if (created) try { fs.unlinkSync(file) } catch { /* 已删除 */ }
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      const existing = readLock(file)
      if (!stale(existing, file, staleMs)) {
        throw new CourseBusyError(courseId, existing
          ? `pid ${existing.pid}，开始于 ${existing.startedAt}`
          : '锁文件存在但暂时无法读取')
      }
      try { fs.unlinkSync(file) } catch { /* 另一个进程已回收 */ }
    }
  }
  throw new CourseBusyError(courseId)
}

export function withCourseLock<T>(root: string, courseId: string, work: () => T): T {
  const lock = acquireCourseLock(root, courseId)
  try { return work() } finally { lock.release() }
}
