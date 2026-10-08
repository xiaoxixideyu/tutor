// 模型回合超时护栏：dsh 的 agent.whenIdle() 不带请求超时，若中转站/模型卡住会永久挂起
// （曾观测到备课在“正在备课…”僵死 15+ 分钟）。超时即抛 TurnTimeoutError，交由调用方 fail-fast
// 退出——调用方取消 Harness 当前请求，不在未收敛的会话里叠加重试。
//
// 两种护栏：
//  - whenIdleWithin：固定上限。用于 bootstrap 这类“一次性、无工具调用”的等待。
//  - whenIdleOrStalled：停滞看门狗。用于会跑很久的 agentic 回合（如联网教研一批要多次搜索+抓取，
//    整轮好几分钟很正常）——只要 progress() 还在前进就一直等，连续 stallMs 完全不动才判死。调用方喂的
//    progress 是「session 事件序号 + 流式块计数」：工具调用/结果、单条消息生成完毕会让事件序号前进，
//    而单条消息「流式吐字」期间靠流式块计数前进。这样”长但活跃”（含一次性大生成的持续吐字）不被误杀，
//    deadlineMs 另外限制总时长，持续输出也不能无限等待。
// 纯函数、无 dsh 依赖，便于单测。

const DEFAULT_TIMEOUT_MS = 300_000

export class TurnTimeoutError extends Error {
  constructor(ms: number, deadline = false) {
    super(deadline
      ? `模型回合达到 ${Math.round(ms / 1000)}s 总时限；未发布未完成内容。请缩小任务或调整该调用的时限。`
      : `模型回合超时（${Math.round(ms / 1000)}s 无进展）；未发布未完成内容。可用 TUTOR_LLM_TIMEOUT_MS 调整（毫秒）。`)
    this.name = 'TurnTimeoutError'
  }
}

// 读取超时配置（毫秒）。缺省 / 非法值（非数字、<=0）一律回落到默认 300s。
export function turnTimeoutMs(): number {
  const raw = process.env.TUTOR_LLM_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS
  return parsed
}

// 给一个“等待空闲”的 thunk 套超时。idle 先落地 → 正常返回；ms 先到 → 抛 TurnTimeoutError。
// 无论哪条路径都会清掉定时器，避免残留 timer 拖住事件循环。
// 超时不会自行取消底层请求；调用方负责 cancel 并等待收敛，不能直接叠加 followup。
export async function whenIdleWithin(idle: () => Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TurnTimeoutError(ms)), ms)
  })
  try {
    await Promise.race([idle(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// 停滞看门狗：只要 progress() 在变化（session 有新事件）就继续等；连续 stallMs 毫秒无变化且 idle
// 仍未落地，才判定为真卡死并抛 TurnTimeoutError。idle 先落地 → 正常返回；idle 抛错 → 原样透传。
// 与 whenIdleWithin 不同，它不会误杀“长但活跃”的回合（工具调用密集、整轮耗时远超 stallMs）。
export async function whenIdleOrStalled(
  idle: () => Promise<void>,
  progress: () => number,
  stallMs: number,
  pollMs = 3_000,
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<void> {
  let done = false
  let failed = false
  let failure: unknown
  const settled = idle().then(
    () => { done = true },
    (error) => { done = true; failed = true; failure = error },
  )
  const step = Math.max(1, Math.min(pollMs, stallMs, deadlineMs))
  const startedAt = Date.now()
  let lastSeq = progress()
  let lastProgressAt = Date.now()
  while (!done) {
    let poll: ReturnType<typeof setTimeout> | undefined
    await Promise.race([settled, new Promise<void>((resolve) => { poll = setTimeout(resolve, step) })])
    if (poll !== undefined) clearTimeout(poll)
    if (done) break
    if (Date.now() - startedAt >= deadlineMs) throw new TurnTimeoutError(deadlineMs, true)
    const seq = progress()
    if (seq !== lastSeq) {
      lastSeq = seq
      lastProgressAt = Date.now()
    } else if (Date.now() - lastProgressAt >= stallMs) {
      throw new TurnTimeoutError(stallMs)
    }
  }
  if (failed) throw failure
}
