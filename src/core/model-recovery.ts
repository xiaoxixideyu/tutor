// 传输失败不等于内容失败。成功进入下一步后重新计算恢复次数，持续没有响应仍有边界。
export const MODEL_RECOVERY_LIMITS = { retries: 8, waitingMs: 30 * 60_000, maxDelayMs: 300_000 } as const

export interface ModelFailure { code: string; message: string; status?: number; providerRetryAfterMs?: number }

export function transientModelFailure(failure: ModelFailure): boolean {
  if (/insufficient_quota|billing_hard_limit|credit balance is too low/i.test(failure.message)) return false
  if (failure.status && [400, 401, 403, 404, 422].includes(failure.status)) {
    return failure.status === 404 && transientRouteFailure(failure.message)
  }
  if (failure.status === 429 || (failure.status && failure.status >= 500)) return true
  return ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'].includes(failure.code)
    || transientRouteFailure(failure.message)
}

export function transientRouteFailure(message: string): boolean {
  return /404:\s*\{\s*"message"\s*:\s*"404 Route Not Found"/i.test(message)
    && /"type"\s*:\s*"bad_response_status_code"/i.test(message)
}

export function recoveryDelay(failure: ModelFailure, retry: number, random = Math.random): number {
  const base = failure.code === 'RATE_LIMIT' ? 61_000 : 10_000
  const local = Math.min(MODEL_RECOVERY_LIMITS.maxDelayMs, base * 2 ** Math.min(retry - 1, 10))
  const jittered = Math.min(MODEL_RECOVERY_LIMITS.maxDelayMs, Math.ceil(local * (1 + random() * 0.1)))
  const provider = failure.providerRetryAfterMs
  return Math.max(jittered, provider && Number.isFinite(provider) ? provider : 0)
}

export class ModelRecoveryError extends Error {
  constructor(code: string, failures: number) {
    super(`模型渠道连续 ${failures} 次未恢复（${code}），已保留进度并暂停本次运行；可稍后从断点继续`)
    this.name = 'ModelRecoveryError'
  }
}
