import { it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { ModelRateLimiter, ModelRequestQueueError, type ModelRateLimiterOptions } from '../src/core/model-rate-limit.ts'

function fixture(t: TestContext, changes: Partial<ModelRateLimiterOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-rate-limit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const options = { file: path.join(root, 'shared.sqlite'), baseUrl: 'https://channel.invalid/v1',
    apiKey: 'fixture-private-key', requestsPerMinute: 4, windowMs: 200, ...changes }
  return { root, options, limiter: new ModelRateLimiter(options), signal: new AbortController().signal }
}

function worker(t: TestContext, options: ModelRateLimiterOptions & { count?: number; cooldown?: number }, index = 0) {
  const child = fork(new URL('./fixtures/rate-limit-worker.ts', import.meta.url), [JSON.stringify(options)], {
    silent: true, execArgv: [], env: { ...process.env, DSH_HOME: `unused-independent-home-${index}` },
  })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const starts: number[] = []
  let errors = ''
  child.stderr!.on('data', chunk => { errors += String(chunk) })
  const ready = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('message', value => {
      const message = value as { ready?: boolean; startedAt?: number }
      if (message.ready) resolve()
      if (message.startedAt) starts.push(message.startedAt)
    })
  })
  const done = new Promise<number[]>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(starts) : reject(new Error(errors)))
  })
  return { ready, done, go: () => child.send({ go: true }) }
}

it('三个独立进程和 DSH_HOME 合计遵守渠道滚动窗口，而非各自获得完整额度', { timeout: 10000 }, async t => {
  const { options } = fixture(t)
  const workers = Array.from({ length: 3 }, (_, i) => worker(t, { ...options, count: 4 }, i))
  await Promise.all(workers.map(child => child.ready))
  workers.forEach(child => child.go())
  const starts = (await Promise.all(workers.map(child => child.done))).flat().sort((a, b) => a - b)
  assert.equal(starts.length, 12)
  for (let i = options.requestsPerMinute; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - options.requestsPerMinute] >= options.windowMs - 15, '配额必须跨进程共享')
  }
  const persisted = fs.readFileSync(options.file).toString()
  assert.ok(!persisted.includes(options.apiKey))
  assert.ok(!persisted.includes(options.baseUrl))
  assert.equal(fs.statSync(options.file).mode & 0o777, 0o600)
})

it('同一渠道地址规范化后共用额度，其他密钥独立；等待取消不预占后续名额', async t => {
  const { options, limiter, signal } = fixture(t, { requestsPerMinute: 1, windowMs: 250 })
  await limiter.acquire(signal)
  const other = new ModelRateLimiter({ ...options, apiKey: 'different-fixture-key' })
  await other.acquire(signal)
  const equivalent = new ModelRateLimiter({ ...options, baseUrl: 'https://CHANNEL.invalid:443/v1/' })
  const controller = new AbortController()
  let waiting = false
  const pending = equivalent.acquire(controller.signal, () => { waiting = true; controller.abort() })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(waiting, true)
  const db = new DatabaseSync(options.file)
  const states = db.prepare('SELECT state FROM channels').all().map(row => JSON.parse(String(row.state)))
  db.close()
  assert.equal(states.length, 2)
  assert.ok(states.every(state => state.starts.length === 1), '取消等待不能写入请求名额')
  await equivalent.acquire(signal)
})

it('较低的新配额约束旧快照，减少配额时还要等待已有请求退出窗口', async t => {
  const { options, limiter, signal } = fixture(t)
  const first = Date.now()
  await limiter.acquire(signal)
  await limiter.acquire(signal)
  const slower = new ModelRateLimiter({ ...options, requestsPerMinute: 2 })
  await slower.acquire(signal)
  assert.ok(Date.now() - first >= options.windowMs - 10)
  const controller = new AbortController()
  let wait = 0
  await assert.rejects(limiter.acquire(controller.signal, ms => { wait = ms; controller.abort() }), { name: 'AbortError' })
  assert.ok(wait >= 70, '旧的 4 次配额不能覆盖仍活跃的 2 次配额')
})

it('429 的冷却由其他进程读取，并遵守更长的 Retry-After', async t => {
  const { options, limiter, signal } = fixture(t, { windowMs: 80 })
  const child = worker(t, { ...options, cooldown: 240 })
  await child.ready
  const since = Date.now()
  child.go()
  await child.done
  await limiter.acquire(signal)
  assert.ok(Date.now() - since >= 230)
  assert.equal(await limiter.cooldown(signal, 1), 80, '短 Retry-After 仍至少等待完整窗口')
})

it('取消冷却等待立即结束；队列不可用时明确失败而非绕过限流', async t => {
  const { root, options, limiter, signal } = fixture(t)
  await limiter.cooldown(signal, 60_000)
  const controller = new AbortController()
  const since = Date.now()
  await assert.rejects(limiter.acquire(controller.signal, () => controller.abort()), { name: 'AbortError' })
  assert.ok(Date.now() - since < 1000)
  const parent = path.join(root, 'not-a-directory')
  fs.writeFileSync(parent, '')
  await assert.rejects(new ModelRateLimiter({ ...options, file: path.join(parent, 'queue.sqlite') }).acquire(signal), ModelRequestQueueError)
})
