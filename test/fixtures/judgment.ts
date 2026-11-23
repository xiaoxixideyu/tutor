export interface JudgmentRequest {
  model: string
  state: unknown
  questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>
}

export function judgmentReply(
  request: JudgmentRequest,
  choice: 'pass' | 'fail' | 'uncertain' = 'pass',
  confidence = 0.99,
) {
  const probabilities = { pass: 0.005, fail: 0.005, uncertain: 0.005 }
  probabilities[choice] = 0.99
  return {
    model: 'jev-fixture-1',
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [
        id,
        {
          type: 'choice',
          choice,
          confidence,
          probabilities,
        },
      ]),
    ),
    usage: { input_tokens: 120, output_tokens: 12 },
  }
}

export function judgmentFetch(
  called?: (request: JudgmentRequest, url: string, init?: RequestInit) => void,
  reply: (request: JudgmentRequest) => unknown = judgmentReply,
): typeof fetch {
  return async (url, init) => {
    const request = JSON.parse(String(init?.body)) as JudgmentRequest
    called?.(request, String(url), init)
    return new Response(JSON.stringify(reply(request)), { headers: { 'content-type': 'application/json' } })
  }
}

export function noulReply(request: JudgmentRequest, probability = 0.99) {
  return {
    model: 'jev-fixture-1',
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: probability }]),
    ),
    usage: { input_tokens: 120, output_tokens: 12 },
  }
}

export const FAST_JUDGMENT_ENV = {
  TUTOR_JUDGMENT_PROVIDER: 'typesafe',
  TUTOR_JUDGMENT_BASE_URL: 'https://judge.invalid/v1',
  TUTOR_JUDGMENT_MODEL: 'jev-fixture',
  TUTOR_JUDGMENT_API_KEY: 'fast-fixture-key',
  TUTOR_JUDGMENT_MIN_CONFIDENCE: '0.95',
  TUTOR_JUDGMENT_TIMEOUT_MS: '5000',
  TUTOR_JUDGMENT_REQUESTS_PER_MINUTE: '60',
}
