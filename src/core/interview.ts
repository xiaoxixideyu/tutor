import { ProfileSchema, type Profile } from './schema.ts'

export function profileScope(profile: Profile): string {
  return [profile.goal, ...(profile.requests?.length ? ['学员访谈原话（明确范围优先于目标摘要）：', ...profile.requests] : [])].join('\n')
}

export function preserveLearnerRequests(profile: Profile, requests: string[]): Profile {
  return { ...profile, requests: [...requests] }
}

export function extractProfileJson(text: string): unknown | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/)
  const candidates: string[] = []
  if (fenced) candidates.push(fenced[1])
  const start = text.indexOf('{')
  if (start >= 0) {
    const candidate = text.slice(start)
    try {
      JSON.parse(candidate)
      candidates.push(candidate)
    } catch {
      const end = candidate.lastIndexOf('}')
      if (end > 0) candidates.push(candidate.slice(0, end + 1))
      // 模型偶发输出空键项（`,"":…` 或 `,""]`）、键名轻微错位（如 claims 项漏 verdict）——
      // 前者是唯一可机械修复的语法损坏；后者是内容缺失，交给 generateTurn 的重试带 issue 修正。
      const repaired = candidate
        .replace(/,\s*""(?=\s*[}\]])/g, '')   // 数组/对象尾部的悬垂空项 `,""`（本故障样本形态）
        .replace(/,?\s*""\s*:\s*""/g, '')     // 空键空值对 `"":"":` 残片
        .replace(/,(\s*[}\]])/g, '$1')        // 清理修复后残留的尾逗号
      if (repaired !== candidate) {
        for (const slice of [repaired, repaired.slice(0, repaired.lastIndexOf('}') + 1)]) {
          try {
            JSON.parse(slice)
            candidates.push(slice)
            break
          } catch { /* 该形态修复无效，试下一形态 */ }
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }
  return null
}

export function parseProfile(text: string): Profile | null {
  const data = extractProfileJson(text)
  if (data === null) return null
  try {
    return ProfileSchema(data) as Profile
  } catch {
    return null
  }
}

export function profileValidationError(text: string): string | null {
  const data = extractProfileJson(text)
  if (data === null) return '未找到 JSON 档案块'
  try {
    ProfileSchema(data)
    return null
  } catch (error) {
    return error instanceof Error ? error.message.replace(/\n+/g, ' ') : String(error)
  }
}
