// 会话事实存储：事件日志（多帧 zstd JSONL）+ 消息转录（messages.jsonl）。
// 事件名与字段对齐原 Harness 会话格式，audit / fidelity 不需要任何改动即可解析。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import type { ApiMessage } from './llm.ts'

// 按 zstd 帧头/块头计算帧边界。不能搜索魔数：压缩数据内部可能偶然出现同样的 4 字节，
// 会把一帧误切两半并让整段事件静默丢失。
function zstdFrameEnd(buffer: Buffer, start: number): number | undefined {
  if (start + 5 > buffer.length || buffer.readUInt32LE(start) !== 0xfd2fb528) return undefined
  const descriptor = buffer[start + 4]
  const fcsFlag = descriptor >> 6
  const singleSegment = ((descriptor >> 5) & 1) === 1
  const checksum = ((descriptor >> 2) & 1) === 1
  const dictFlag = descriptor & 3
  let offset = start + 5
  if (!singleSegment) offset += 1
  offset += [0, 1, 2, 4][dictFlag]!
  offset += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]!
  for (;;) {
    if (offset + 3 > buffer.length) return undefined
    const header = buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16)
    offset += 3
    const last = (header & 1) === 1
    const blockType = (header >> 1) & 3
    const blockSize = header >>> 3
    if (blockType === 3) return undefined
    offset += blockType === 1 ? 1 : blockSize
    if (offset > buffer.length) return undefined
    if (last) break
  }
  if (checksum) offset += 4
  return offset <= buffer.length ? offset : undefined
}

export function decodeZstdFrames(buffer: Buffer): string {
  let offset = 0
  let text = ''
  while (offset < buffer.length) {
    // skippable frame（0x184D2A50–0x184D2A5F）：跳过 length 指定的负载。
    if (offset + 8 <= buffer.length) {
      const skippable = buffer.readUInt32LE(offset)
      if (skippable >= 0x184d2a50 && skippable <= 0x184d2a5f) {
        const size = buffer.readUInt32LE(offset + 4)
        offset += 8 + size
        continue
      }
    }
    const end = zstdFrameEnd(buffer, offset)
    if (end === undefined) break
    try { text += zlib.zstdDecompressSync(buffer.subarray(offset, end)).toString('utf8') }
    catch { /* 单帧损坏不影响后续帧 */ }
    offset = end
  }
  return text
}

export interface SessionEvent {
  seq: number
  type: string
  data?: Record<string, unknown>
  at: string
}

export function encodeWorkspace(workspace: string): string {
  return `-${workspace.replaceAll('/', '-')}--`
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
    // 会话 id 来自课程 YAML，必须限制为单段目录名，防止被篡改成路径穿越。
    if (!/^session-[A-Za-z0-9._-]+$/.test(id)) return null
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
