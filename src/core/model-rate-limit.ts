import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { ModelRecoveryError } from './model-recovery.ts'

// 比渠道的 60 秒窗口多留 1 秒余量，均匀发起请求，避免窗口边界的突发流量。
const WINDOW_MS = 61_000

export class ModelRateLimitError extends ModelRecoveryError {
  constructor(failures: number) {
    super('429', failures)
    this.name = 'ModelRateLimitError'
  }
}

export class ModelRequestQueueError extends Error {
  constructor() {
    super('无法读写共享模型请求队列，已停止请求；请检查本机数据目录权限和磁盘状态')
    this.name = 'ModelRequestQueueError'
  }
}

interface ChannelState {
  starts: number[]
  limits: { rpm: number; expiresAt: number }[]
  cooldownUntil: number
}

export interface ModelRateLimiterOptions {
  file: string
  baseUrl: string
  apiKey: string
  requestsPerMinute: number
  /** 生产环境固定为 61 秒；可缩短窗口做真实跨进程调度测试。 */
  windowMs?: number
}

// SQLite 事务让网页子进程、独立 DSH_HOME 和审查会话共用额度。
// 不预订未来名额：排队取消不会消耗一次请求，进程退出也不会留下死锁。
export class ModelRateLimiter {
  private readonly file: string
  private readonly bucket: string
  private readonly rpm: number
  private readonly windowMs: number

  constructor(options: ModelRateLimiterOptions) {
    this.file = path.resolve(options.file)
    this.rpm = options.requestsPerMinute
    this.windowMs = options.windowMs ?? WINDOW_MS
    if (!Number.isSafeInteger(this.rpm) || this.rpm < 1 || this.rpm > 600
      || !Number.isSafeInteger(this.windowMs) || this.windowMs < 1) throw new ModelRequestQueueError()
    const url = new URL(options.baseUrl).toString().replace(/\/+$/, '')
    // 同一渠道与密钥共用配额，不因模型名不同而分桶；磁盘不保存密钥或地址。
    this.bucket = createHash('sha256').update(JSON.stringify([url, options.apiKey])).digest('hex')
  }

  private transaction<T>(update: (state: ChannelState, now: number) => T): T {
    let db: DatabaseSync | undefined
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      try { fs.closeSync(fs.openSync(this.file, 'wx', 0o600)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      db = new DatabaseSync(this.file)
      db.exec('PRAGMA busy_timeout = 50; BEGIN IMMEDIATE')
      db.exec('CREATE TABLE IF NOT EXISTS channels (bucket TEXT PRIMARY KEY, state TEXT NOT NULL)')
      const row = db.prepare('SELECT state FROM channels WHERE bucket = ?').get(this.bucket)
      const state: ChannelState = row ? JSON.parse(String(row.state)) : { starts: [], limits: [], cooldownUntil: 0 }
      const now = Date.now()
      state.starts = state.starts.filter(time => time > now - this.windowMs)
      state.limits = state.limits.filter(limit => limit.expiresAt > now)
      const result = update(state, now)
      db.prepare('INSERT INTO channels VALUES (?, ?) ON CONFLICT(bucket) DO UPDATE SET state = excluded.state')
        .run(this.bucket, JSON.stringify(state))
      db.exec('COMMIT')
      return result
    } finally {
      // close() 会回滚失败事务；只在短事务内持锁，不在等待渠道期间占锁。
      db?.close()
    }
  }

  private async update<T>(signal: AbortSignal, change: (state: ChannelState, now: number) => T): Promise<T> {
    for (;;) {
      signal.throwIfAborted()
      try { return this.transaction(change) }
      catch (error) {
        const code = (error as { errcode?: number }).errcode
        if (code !== 5 && code !== 6) throw new ModelRequestQueueError()
        await delay(50, undefined, { signal })
      }
    }
  }

  async acquire(signal: AbortSignal, onWait: (ms: number) => void = () => {}): Promise<void> {
    let reportedAt = -Infinity
    let reportedUntil = 0
    for (;;) {
      const waitMs = await this.update(signal, (state, now) => {
        // 配置切换时，仍活跃的较低配额在一个窗口内优先；旧快照不会冲破新限制。
        const previous = state.limits.find(limit => limit.rpm === this.rpm)
        if (previous) previous.expiresAt = now + this.windowMs
        else state.limits.push({ rpm: this.rpm, expiresAt: now + this.windowMs })
        const rpm = Math.min(...state.limits.map(limit => limit.rpm))
        const last = state.starts.at(-1)
        const paced = last === undefined ? 0 : last + Math.ceil(this.windowMs / rpm)
        const rolling = state.starts.length >= rpm ? state.starts[state.starts.length - rpm] + this.windowMs : 0
        const wait = Math.max(0, state.cooldownUntil - now, paced - now, rolling - now)
        if (wait === 0) state.starts.push(now)
        return wait
      })
      if (waitMs === 0) return
      const now = Date.now()
      if (now - reportedAt >= 15_000 || now + waitMs > reportedUntil + 2000) {
        onWait(waitMs); reportedAt = now; reportedUntil = now + waitMs
      }
      // 定期重新检查其他进程发布的冷却时间；AbortSignal 立即取消本地等待。
      await delay(Math.min(waitMs, 1000), undefined, { signal })
    }
  }

  async cooldown(signal: AbortSignal, retryAfterMs = 0): Promise<number> {
    const duration = Math.max(this.windowMs, Number.isFinite(retryAfterMs) ? retryAfterMs : 0)
    await this.update(signal, (state, now) => { state.cooldownUntil = Math.max(state.cooldownUntil, now + duration) })
    return duration
  }
}

export function modelRateLimiterFromEnvironment(env: NodeJS.ProcessEnv = process.env): ModelRateLimiter {
  if (!env.TUTOR_LLM_BASE_URL || !env.TUTOR_LLM_API_KEY) throw new ModelRequestQueueError()
  return new ModelRateLimiter({ file: env.TUTOR_MODEL_RATE_LIMIT_FILE ?? fileURLToPath(new URL('../../data/model-rate-limits.sqlite', import.meta.url)), baseUrl: env.TUTOR_LLM_BASE_URL,
    apiKey: env.TUTOR_LLM_API_KEY, requestsPerMinute: Number(env.TUTOR_LLM_REQUESTS_PER_MINUTE || 8) })
}
