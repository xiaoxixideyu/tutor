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
