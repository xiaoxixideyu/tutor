import readline from 'node:readline'

export function createLineReader(stdin: NodeJS.ReadStream): () => Promise<string | null> {
  const queue: string[] = []
  let waiter: ((line: string | null) => void) | null = null
  let closed = false
  const rl = readline.createInterface({ input: stdin, terminal: false })
  rl.on('line', (line: string) => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve(line)
    } else {
      queue.push(line)
    }
  })
  rl.on('close', () => {
    closed = true
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve(null)
    }
  })
  return () =>
    new Promise<string | null>((resolve) => {
      if (queue.length > 0) return resolve(queue.shift()!)
      if (closed) return resolve(null)
      waiter = resolve
    })
}
