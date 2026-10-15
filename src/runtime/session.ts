// 会话事实存储：事件日志（多帧 zstd JSONL）+ 消息转录（messages.jsonl）。
// 事件名与字段对齐原 Harness 会话格式，audit / fidelity 不需要任何改动即可解析。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import type { ApiMessage } from './llm.ts'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export interface SessionEvent {
  seq: number
  type: string
  data?: Record<string, unknown>
  at: string
}

export function encodeWorkspace(workspace: string): string {
  return `-${workspace.replaceAll('/', '-')}--`
}

export function decodeZstdFrames(buffer: Buffer): string {
  let offset = 0
  let text = ''
  while (offset < buffer.length) {
    const start = buffer.indexOf(MAGIC, offset)
    if (start < 0) break
    let end = buffer.indexOf(MAGIC, start + 4)
    if (end < 0) end = buffer.length
    try { text += zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8') }
    catch { /* 尾部不完整帧忽略 */ }
    offset = end
  }
  return text
}

function writeFileAtomic(file: string, content: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch { /* 已原子替换或未创建 */ }
  }
}

export class SessionLog {
  readonly id: string
  readonly directory: string
  private readonly eventFile: string
  readonly events: SessionEvent[] = []
  messages: ApiMessage[] = []

  constructor(sessionsRoot: string, workspace: string, id?: string) {
    this.id = id ?? `session-${randomUUID()}`
    this.directory = path.join(sessionsRoot, encodeWorkspace(workspace), this.id)
    this.eventFile = path.join(this.directory, 'session.v3.jsonl.zstd')
  }

  appendEvent(type: string, data?: Record<string, unknown>): number {
    const event: SessionEvent = { seq: this.events.length, type, ...(data !== undefined ? { data } : {}), at: new Date().toISOString() }
    this.events.push(event)
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    fs.appendFileSync(this.eventFile, zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n')), { mode: 0o600 })
    return event.seq
  }

  persistMessages(): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const lines = this.messages.map(message => JSON.stringify(message)).join('\n')
    writeFileAtomic(path.join(this.directory, 'messages.jsonl'), lines === '' ? '' : lines + '\n')
  }

  // 恢复已有会话：事件与消息任一缺失都视为不可恢复（返回 null）。
  static load(sessionsRoot: string, workspace: string, id: string): SessionLog | null {
    try {
      const log = new SessionLog(sessionsRoot, workspace, id)
      const eventsText = decodeZstdFrames(fs.readFileSync(log.eventFile))
      for (const line of eventsText.split('\n')) {
        if (!line.trim()) continue
        try { log.events.push(JSON.parse(line) as SessionEvent) } catch { /* 容忍截断的最后一行 */ }
      }
      const messagesText = fs.readFileSync(path.join(log.directory, 'messages.jsonl'), 'utf8')
      for (const line of messagesText.split('\n')) {
        if (!line.trim()) continue
        try { log.messages.push(JSON.parse(line) as ApiMessage) } catch { /* 忽略坏行 */ }
      }
      if (log.messages.length === 0) return null
      return log
    } catch {
      return null
    }
  }
}
