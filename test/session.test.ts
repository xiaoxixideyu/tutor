import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { decodeZstdFrames, SessionLog } from '../src/runtime/session.ts'

it('多帧 zstd 按帧头解码，压缩内容含魔数也不会错切', () => {
  const frames = ['第一帧\n', '第二帧\n', '第三帧\n'].map((text) => zlib.zstdCompressSync(Buffer.from(text)))
  assert.equal(decodeZstdFrames(Buffer.concat(frames)), '第一帧\n第二帧\n第三帧\n')
  const corruptTail = Buffer.concat([frames[0]!, frames[1]!.subarray(0, 3)])
  assert.equal(decodeZstdFrames(corruptTail), '第一帧\n')
})

it('SessionLog 追加的事件帧可以完整读回', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-session-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const log = new SessionLog(root, root)
  log.appendEvent('turn/end', { reason: { kind: 'completed' } })
  log.appendEvent('user/message', { message: { role: 'user', content: [{ type: 'text', text: '你好' }] } })
  const text = decodeZstdFrames(fs.readFileSync(path.join(log.directory, 'session.v3.jsonl.zstd')))
  const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'turn/end')
  assert.equal(events[1].type, 'user/message')
  assert.equal(events[1].seq, 1)
})
