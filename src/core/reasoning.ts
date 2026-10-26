// 推理档位的统一表示：具体参数名和可用取值由模型族在运输层映射。
// default 表示不注入参数、跟随渠道默认；on 是旧版保存值的兼容别名，按最高档处理。
export const REASONING_LEVELS = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'max'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export function parseReasoning(value: unknown): ReasoningLevel {
  if (value === undefined || value === null || value === '') return 'default'
  if (value === 'on') return 'max'
  if (typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value)) return value as ReasoningLevel
  throw new Error('推理档位必须是 default、off、minimal、low、medium、high 或 max')
}

export function normalizeReasoning(value: unknown): ReasoningLevel {
  try { return parseReasoning(value) } catch { return 'default' }
}
