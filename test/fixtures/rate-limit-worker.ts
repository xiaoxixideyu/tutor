import { ModelRateLimiter } from '../../src/core/model-rate-limit.ts'

const options = JSON.parse(process.argv[2])
const limiter = new ModelRateLimiter(options)
process.once('message', async () => {
  try {
    if (options.cooldown) await limiter.cooldown(new AbortController().signal, options.cooldown)
    else for (let i = 0; i < options.count; i++) {
      await limiter.acquire(new AbortController().signal)
      process.send!({ startedAt: Date.now() })
    }
    process.disconnect()
  } catch (error) { process.stderr.write(String(error)); process.exit(1) }
})
process.send!({ ready: true })
