import { evaluateRational } from './rational.ts'

// 规则题只要求选择或填写一个数值；开放解释无法靠枚举措辞可靠判分。
export function numericAnswer(value: string): string | undefined {
  const text = value.trim()
  if (!/^[+-]?\d+(?:\.\d+)?(?:\s*\/\s*[+-]?\d+(?:\.\d+)?)?$/.test(text)) return undefined
  try { return evaluateRational(text) } catch { return undefined }
}

export function ruleAnswerIssue(item: { answer: string; choices?: string[] }): string | undefined {
  if (!item.choices?.length && numericAnswer(item.answer) === undefined) {
    return '规则判分题须为四选一或单一数值填空；概念解释、代码和多个结果请改为选择题或主观题，不能精确匹配整段文字'
  }
  return undefined
}

export function normalizeRuleText(value: string): string {
  return value.trim().toLowerCase().replace(/[\s，。,.;；:：!！?？"'“”‘’（）()[\]【】]+/g, '')
}

export function matchesRuleAnswer(raw: string, candidates: string[]): boolean {
  if (!raw.trim()) return false
  const number = numericAnswer(raw)
  return candidates.some(candidate => {
    const expected = numericAnswer(candidate)
    // 数值必须在移除标点之前判断，否则 0.5 会和 05 错误地变成同一答案。
    if (expected !== undefined) return number !== undefined && number === expected
    return normalizeRuleText(raw) === normalizeRuleText(candidate)
  })
}
