import type { Context } from '@deepseek-ai/cordis'

export const name = 'exit-probe'

export function apply(ctx: Context) {
  console.error('[exit-probe] booted ok')
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  console.error('[exit-probe] appExit:', typeof exit)
  process.nextTick(() => exit(0))
}
