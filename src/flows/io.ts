// 流程运行壳：输入/输出/退出/中止的统一接口。
// CLI 与网页宿主都实现同一接口；流程代码不直接触碰 stdin/stdout/process.exit，退出以 FlowExit 抛出。
import readline from 'node:readline'

export class FlowExit extends Error {
  readonly code: number
  constructor(code: number) {
    super(`流程退出（${code}）`)
    this.name = 'FlowExit'
    this.code = code
  }
}

export interface FlowIO {
  out(text: string): void
  err(text: string): void
  readLine(): Promise<string | null>
  closeInput(): void
  readonly signal: AbortSignal
}

export interface LineQueue {
  read(): Promise<string | null>
  push(line: string): void
  close(): void
  readonly closed: boolean
  readonly overflowed: boolean
}

// 排队的待读行数上限：没有上限时，失控的输入源（`yes`、超大粘贴、异常客户端）会把队列撑到
// 触发 RangeError 的进程级崩溃。超出上限就停止接收输入（按 EOF 处理，流程据此保存进度后退出）。
export const MAX_QUEUED_LINES = 1000

// 行输入队列：把回推的整行排队；close 让所有等待者以 null 结束（对应 stdin EOF / 流程停止）。
export function createLineQueue(): LineQueue {
  const queue: string[] = []
  const waiters: ((line: string | null) => void)[] = []
  let closed = false
  let overflowed = false
  const close = () => {
    if (closed) return
    closed = true
    for (const waiter of waiters.splice(0)) waiter(null)
  }
  return {
    get closed() { return closed },
    get overflowed() { return overflowed },
    read(): Promise<string | null> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!)
      if (closed) return Promise.resolve(null)
      return new Promise(resolve => { waiters.push(resolve) })
    },
    push(line: string): void {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) { waiter(line); return }
      if (queue.length >= MAX_QUEUED_LINES) { overflowed = true; close(); return }
      queue.push(line)
    },
    close,
  }
}

export function createCliIO(options: { signal?: AbortSignal } = {}): FlowIO {
  const queue = createLineQueue()
  let rl: readline.Interface | undefined
  // 延迟到首次读取时再占用 stdin，避免无输入流程退出前被 readline 拖住。
  const ensureReader = () => {
    if (rl === undefined) {
      rl = readline.createInterface({ input: process.stdin, terminal: false })
      rl.on('line', line => queue.push(line))
      rl.on('close', () => queue.close())
    }
  }
  const controller = new AbortController()
  let onSignal: (() => void) | undefined
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(options.signal!.reason), { once: true })
  else {
    // CLI 的 Ctrl-C / SIGTERM 也要能中止模型请求或正在运行的实践测试，而不是把子进程留成孤儿。
    onSignal = () => {
      queue.close()
      controller.abort(new Error('用户中断'))
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }
  const stopSignal = () => {
    if (!onSignal) return
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    onSignal = undefined
  }
  return {
    out: text => { process.stdout.write(text) },
    err: text => { process.stderr.write(text) },
    async readLine(): Promise<string | null> {
      ensureReader()
      const line = await queue.read()
      // 输入量超上限时按 EOF 处理，但必须说清楚原因：否则用户只看到"未收到作答"。
      if (line === null && queue.overflowed) {
        process.stderr.write(`输入行数超过上限（${MAX_QUEUED_LINES} 行），已停止读取输入；进度已保存，可重新运行继续。\n`)
      }
      return line
    },
    closeInput(): void {
      stopSignal()
      queue.close()
      try { process.stdin.destroy() } catch { /* 已关闭 */ }
    },
    signal: controller.signal,
  }
}
