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
  readonly tty: boolean
}

export interface LineQueue {
  read(): Promise<string | null>
  push(line: string): void
  close(): void
  readonly closed: boolean
}

// 行输入队列：把回推的整行排队；close 让所有等待者以 null 结束（对应 stdin EOF / 流程停止）。
export function createLineQueue(): LineQueue {
  const queue: string[] = []
  const waiters: ((line: string | null) => void)[] = []
  let closed = false
  return {
    get closed() { return closed },
    read(): Promise<string | null> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!)
      if (closed) return Promise.resolve(null)
      return new Promise(resolve => { waiters.push(resolve) })
    },
    push(line: string): void {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else queue.push(line)
    },
    close(): void {
      if (closed) return
      closed = true
      for (const waiter of waiters.splice(0)) waiter(null)
    },
  }
}

export function createCliIO(options: { tty?: boolean; signal?: AbortSignal } = {}): FlowIO {
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
      return queue.read()
    },
    closeInput(): void {
      stopSignal()
      queue.close()
      try { process.stdin.destroy() } catch { /* 已关闭 */ }
    },
    signal: controller.signal,
    tty: options.tty ?? process.stdout.isTTY === true,
  }
}
