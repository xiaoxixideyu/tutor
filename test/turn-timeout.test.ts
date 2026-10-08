import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TurnTimeoutError, turnTimeoutMs, whenIdleOrStalled, whenIdleWithin } from '../src/plugin/turn-timeout.ts'

describe('whenIdleWithin', () => {
  it('idle 先落地则正常返回', async () => {
    await whenIdleWithin(() => new Promise<void>((resolve) => setTimeout(resolve, 10)), 1000)
  })

  it('idle 永不落地则超时抛 TurnTimeoutError', async () => {
    await assert.rejects(
      () => whenIdleWithin(() => new Promise<void>(() => {}), 20),
      (error: unknown) => error instanceof TurnTimeoutError,
    )
  })

  it('idle 抛错则原样透传（非超时错误不被吞）', async () => {
    await assert.rejects(
      () => whenIdleWithin(() => Promise.reject(new Error('boom')), 1000),
      (error: unknown) => error instanceof Error && error.message === 'boom' && !(error instanceof TurnTimeoutError),
    )
  })

  it('竞速落地后清掉定时器（不因残留 timer 拖住事件循环）', async () => {
    const start = Date.now()
    await whenIdleWithin(() => Promise.resolve(), 5000)
    // 定时器若未清，进程会额外挂 ~5s；这里立即返回即证明 finally 里 clearTimeout 生效
    assert.ok(Date.now() - start < 1000)
  })
})

describe('whenIdleOrStalled', () => {
  const noProgress = () => 0

  it('持续输出也受总时限约束', async () => {
    let progress = 0
    const tick = setInterval(() => progress++, 2)
    try {
      await assert.rejects(whenIdleOrStalled(() => new Promise<void>(() => {}), () => progress, 1000, 5, 25), /总时限/)
    } finally { clearInterval(tick) }
  })

  it('idle 先落地则正常返回', async () => {
    await whenIdleOrStalled(() => new Promise<void>((resolve) => setTimeout(resolve, 10)), noProgress, 1000, 50)
  })

  it('长但活跃的回合不被误杀：progress 一直在涨就不超时', async () => {
    let seq = 0
    const tick = setInterval(() => { seq++ }, 10)
    try {
      // 整轮 200ms 远超 stall 阈值 50ms，但 seq 每 10ms 涨一次 → 不应超时（这是教研一批多次工具调用的场景）
      await whenIdleOrStalled(() => new Promise<void>((resolve) => setTimeout(resolve, 200)), () => seq, 50, 15)
    } finally {
      clearInterval(tick)
    }
  })

  it('真卡死（progress 冻结且 idle 不落地）→ 超时抛 TurnTimeoutError', async () => {
    await assert.rejects(
      () => whenIdleOrStalled(() => new Promise<void>(() => {}), noProgress, 40, 15),
      (error: unknown) => error instanceof TurnTimeoutError,
    )
  })

  it('idle 抛错则原样透传（非超时错误不被吞）', async () => {
    await assert.rejects(
      () => whenIdleOrStalled(() => Promise.reject(new Error('boom')), noProgress, 1000, 50),
      (error: unknown) => error instanceof Error && error.message === 'boom' && !(error instanceof TurnTimeoutError),
    )
  })
})

describe('turnTimeoutMs', () => {
  const KEY = 'TUTOR_LLM_TIMEOUT_MS'
  const withEnv = (value: string | undefined, run: () => void) => {
    const saved = process.env[KEY]
    try {
      if (value === undefined) delete process.env[KEY]
      else process.env[KEY] = value
      run()
    } finally {
      if (saved === undefined) delete process.env[KEY]
      else process.env[KEY] = saved
    }
  }

  it('缺省回落 300000', () => {
    withEnv(undefined, () => assert.equal(turnTimeoutMs(), 300_000))
  })

  it('合法数值按配置生效', () => {
    withEnv('5000', () => assert.equal(turnTimeoutMs(), 5000))
  })

  it('非法值（非数字 / <=0 / 空串）回落默认', () => {
    withEnv('garbage', () => assert.equal(turnTimeoutMs(), 300_000))
    withEnv('0', () => assert.equal(turnTimeoutMs(), 300_000))
    withEnv('-1', () => assert.equal(turnTimeoutMs(), 300_000))
    withEnv('   ', () => assert.equal(turnTimeoutMs(), 300_000))
  })
})
