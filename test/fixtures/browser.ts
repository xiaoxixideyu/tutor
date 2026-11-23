import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { TestContext } from 'node:test'

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const hasChrome = fs.existsSync(chrome)

export async function browser(t: TestContext, url: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-browser-'))
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-component-update',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--user-data-dir=' + directory,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], detached: true },
  )
  let socket: WebSocket | undefined
  t.after(async () => {
    socket?.close()
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('close', () => resolve())
    })
    const stop = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        // Chrome 的辅助进程也会写入用户目录，清理前终止整个独立进程组。
        process.kill(-child.pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    stop('SIGTERM')
    const timer = setTimeout(() => stop('SIGKILL'), 2500)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const active = path.join(directory, 'DevToolsActivePort')
  const started = Date.now()
  while (!fs.existsSync(active)) {
    if (Date.now() - started > 10000) throw new Error('Chrome 未能启动')
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const [port, endpoint] = fs.readFileSync(active, 'utf8').trim().split('\n')
  socket = new WebSocket('ws://127.0.0.1:' + port + endpoint)
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve()
    socket!.onerror = reject
  })
  let sequence = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  socket.onmessage = (event) => {
    const value = JSON.parse(String(event.data))
    if (value.id && pending.has(value.id)) {
      const request = pending.get(value.id)!
      pending.delete(value.id)
      if (value.error) request.reject(new Error(value.error.message))
      else request.resolve(value.result)
    }
  }
  async function command(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
    const id = ++sequence
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('浏览器操作超时：' + method))
      }, 10000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
    socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return result
  }
  const target = await command('Target.createTarget', { url })
  const attached = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const sessionId = attached.sessionId
  await command('Runtime.enable', {}, sessionId)
  async function evaluate<T = any>(expression: string): Promise<T> {
    const result = await command(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    )
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description)
    return result.result.value
  }
  async function wait(expression: string, timeout = 8000): Promise<void> {
    const started = Date.now()
    for (;;) {
      if (await evaluate(expression)) return
      if (Date.now() - started > timeout) throw new Error('界面等待超时：' + expression)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  async function screenshot(file: string, fullPage = true) {
    const result = await command(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: fullPage },
      sessionId,
    )
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'))
  }
  return {
    command: (method: string, params: unknown) => command(method, params, sessionId),
    evaluate,
    wait,
    screenshot,
  }
}
