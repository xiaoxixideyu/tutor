// 回归：停滞看门狗的两条不同路径。
// 现场事故（2026-11-05 05:50–05:56，教研 exam-overview）：模型请求带着搜索结果发出后，
// 网关 300s 没送出一个流式帧，看门狗按"无进展"判死，整个知识点作废。
// 区分：首字节之前没有任何数据 = 请求可能没开始产出，重来一次代价很小；
//      流已经吐出内容后再卡住 = 重试只会把半截内容丢掉重新烧一遍。
// 注意“本次请求”而不是整个 ask：教研会先搜索/抓取，再带工具结果发下一次请求；
// 前一次请求的流式块不能让下一次请求被误判成“已经吐过内容”。
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatRuntime, type ModelSettings } from '../src/runtime/chat.ts'
import type { LlmTransport } from '../src/runtime/llm.ts'

const MODEL: ModelSettings = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model',
  thinking: 'default', contextWindow: 262144, maxOutputTokens: 8192, requestsPerMinute: 8, researchDeadlineMs: 480_000 }

class NoLimiter {
  async acquire(): Promise<void> {}
  async cooldown(): Promise<number> { return 0 }
}

function tmp(t: { after(cb: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-stall-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function runtime(root: string, transport: LlmTransport, stallMs: number, signal?: AbortSignal): ChatRuntime {
  return new ChatRuntime({
    model: MODEL, sessionsRoot: root, workspace: root,
    env: { ...process.env, TUTOR_MODEL_RATE_LIMIT_FILE: path.join(root, 'limits.sqlite'), TUTOR_LLM_TIMEOUT_MS: String(stallMs) },
    transport, rateLimiter: new NoLimiter() as never,
    ...(signal ? { signal } : {}),
  })
}

// 真实传输会在中止时抛 AbortError；假传输同样必须响应信号，否则测试要等满收敛时限。
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
}

it('首字节前卡住（一个流式帧都没有）→ 重试一次并成功，不判死整个回合', async (t) => {
  const root = tmp(t)
  let calls = 0
  const transport: LlmTransport = async (_request, signal, onChunk) => {
    calls += 1
    // 模拟网关收下请求却迟迟不产出：既不吐正文也不吐推理。
    if (calls === 1) return hangUntilAborted(signal)
    onChunk(true)
    return { finish: 'stop', text: '第二次成功' }
  }
  const chat = (await runtime(root, transport, 60).createChat())!
  assert.equal(await chat.ask('会先无响应再成功'), '第二次成功')
  assert.equal(calls, 2)
})

it('工具结果后的下一次请求首字节前卡住 → 仍重试一次，不把整个知识点判死', async (t) => {
  const root = tmp(t)
  let calls = 0
  const transport: LlmTransport = async (_request, signal, onChunk) => {
    calls += 1
    if (calls === 1) {
      // 第一次请求在工具调用参数流里已经吐过帧；这不能代表第二次请求也已经开始。
      onChunk(false)
      return { finish: 'tool_calls', text: '', toolCalls: [{ id: 'call-1', type: 'function',
        function: { name: 'web_fetch', arguments: '{"url":"https://example.com"}' } }] }
    }
    // 现场事故：模型带着搜索结果发出下一次请求后，网关 300s 没送出一个流式帧。
    if (calls === 2) return hangUntilAborted(signal)
    onChunk(true)
    return { finish: 'stop', text: '工具结果后的第二次尝试成功' }
  }
  const chat = (await runtime(root, transport, 60).createChat())!
  assert.equal(await chat.ask('先调用工具，再在无响应后重试'), '工具结果后的第二次尝试成功')
  assert.equal(calls, 3)
})

it('流已经吐出内容后再卡住 → 不重试，直接失败（避免丢弃半截内容重烧）', async (t) => {
  const root = tmp(t)
  let calls = 0
  const transport: LlmTransport = async (_request, signal, onChunk) => {
    calls += 1
    onChunk(true)
    return hangUntilAborted(signal)
  }
  const chat = (await runtime(root, transport, 60).createChat())!
  await assert.rejects(chat.ask('会吐一半再卡住'), /无进展|模型回合失败/)
  assert.equal(calls, 1)
})

it('外部取消不与停滞重试混在一起：取消后不重发请求', async (t) => {
  const root = tmp(t)
  const external = new AbortController()
  let calls = 0
  const transport: LlmTransport = async (_request, signal, onChunk) => {
    calls += 1
    onChunk(true)
    setTimeout(() => external.abort(new Error('用户停止')), 20)
    return hangUntilAborted(signal)
  }
  const chat = (await runtime(root, transport, 5000, external.signal).createChat())!
  await assert.rejects(chat.ask('会被取消'))
  assert.equal(calls, 1)
})
