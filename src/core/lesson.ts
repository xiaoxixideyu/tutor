import { LessonDraftSchema, type KnowledgeMapResource, type KnowledgeMap, type LessonDraft, type Mastery, type Plan, type Profile } from './schema.ts'

export interface LessonResourceView {
  index: number
  title: string
  url?: string
  note?: string
  material?: string
}

export function resourcesForNode(resources: KnowledgeMapResource[] | undefined, node: string): LessonResourceView[] {
  return (resources ?? [])
    .filter((r) => r.node === node)
    .map((r, i) => ({ index: i + 1, title: r.title, ...(r.url !== undefined ? { url: r.url } : {}), ...(r.note !== undefined ? { note: r.note } : {}), ...(r.material !== undefined ? { material: r.material } : {}) }))
}

function resourceLines(resources: LessonResourceView[], materialLimit: number): string[] {
  const lines: string[] = []
  for (const r of resources) {
    lines.push(`${r.index}. ${r.title}${r.url ? ` ${r.url}` : ''}`)
    if (r.note) lines.push(`   评注：${r.note}`)
    if (r.material) lines.push(`   摘要：${r.material.slice(0, materialLimit)}`)
  }
  return lines
}

export function validateLessonDraft(draft: unknown, expectedNode?: string): { ok: true; value: LessonDraft } | { ok: false; error: string } {
  let value: LessonDraft
  try {
    value = LessonDraftSchema(draft) as LessonDraft
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.replace(/\n+/g, ' ') : String(error) }
  }
  if (expectedNode && value.node !== expectedNode) {
    return { ok: false, error: `备课产物 node 为 "${value.node}"，应为 "${expectedNode}"` }
  }
  if (value.structure.length < 1 || value.structure.length > 8) {
    return { ok: false, error: `structure 需 1-8 个要点，当前 ${value.structure.length}` }
  }
  if (value.practice.length < 1 || value.practice.length > 3) {
    return { ok: false, error: `practice 需 1-3 道课中练习，当前 ${value.practice.length}` }
  }
  if (value.quiz.length < 2 || value.quiz.length > 3) {
    return { ok: false, error: `quiz 需 2-3 道单元小测题，当前 ${value.quiz.length}` }
  }
  for (const item of value.quiz) {
    if ((item.choices?.length ?? 0) > 0) {
      if (item.choices!.length !== 4) return { ok: false, error: `小测题"${item.question}"的选项数不是 4` }
      if (!/^[a-d]$/i.test(item.answer.trim())) return { ok: false, error: `小测题"${item.question}"的答案不是 A-D 字母` }
    } else if (item.answer.trim() === '') {
      return { ok: false, error: `小测题"${item.question}"缺少答案` }
    }
  }
  return { ok: true, value }
}

export function currentNode(plan: Plan, mastery: Mastery | undefined): string | null {
  const candidates = plan.path.length > 0 ? plan.path : plan.current ? [plan.current] : []
  for (const node of candidates) {
    if (mastery?.[node]?.status !== 'mastered') return node
  }
  return null
}

export function extractCitations(text: string): number[] {
  const markers = [...text.matchAll(/\[资料[:：](\d+)\]/g)].map((m) => Number(m[1]))
  return [...new Set(markers)].sort((a, b) => a - b)
}

export function checkCitations(text: string, resourceCount: number): { cited: number[]; invalid: number[]; uncitedWarning: boolean } {
  const cited = extractCitations(text)
  const invalid = cited.filter((n) => n < 1 || n > resourceCount)
  const assertionWords = /(事实上|一般来说|通常|必须|不能|标准|官方|规范|定义是|指的是|区别在于|核心是)/
  return { cited, invalid, uncitedWarning: resourceCount > 0 && cited.length === 0 && assertionWords.test(text) }
}

export function buildCheckPrompt(replies: string[], resources: LessonResourceView[]): string {
  return [
    '任务：核对一节课中助教（模型）的事实断言是否与资料一致。',
    '',
    '【资料】',
    ...resourceLines(resources, 500),
    '',
    '【本课讲授记录（助教发言）】',
    ...replies.map((r, i) => `--- 第${i + 1}段 ---\n${r.slice(0, 1500)}`),
    '',
    '输出 JSON（```json 代码块）：',
    '{"claims": [{"claim": "断言原文（≤50字）", "verdict": "supported 或 unverified 或 contradicted", "evidence": "资料编号或说明"}]}',
    'verdict 判定：断言被资料直接支撑=supported；资料无法证实=unverified；与资料矛盾=contradicted。只列事实断言（方法性建议、类比不算）。',
  ].join('\n')
}

export function prerequisiteIds(map: KnowledgeMap, node: string): string[] {
  return map.edges.filter(([target]) => target === node).map(([, prerequisite]) => prerequisite)
}

function masteryLine(mastery: Mastery | undefined, node: string, title: string): string {
  const entry = mastery?.[node]
  const status = entry?.status ?? 'unknown'
  const score = entry?.score !== undefined ? ` ${entry.score}` : ''
  return `- ${node}（${title}）：${status}${score}`
}

export interface PrepInput {
  courseId: string
  node: string
  map: KnowledgeMap
  plan: Plan
  profile: Profile
  mastery?: Mastery
}

export function buildPrepPrompt(input: PrepInput): string {
  const node = input.map.nodes.find((n) => n.id === input.node)
  const prerequisites = prerequisiteIds(input.map, input.node)
  const resources = resourcesForNode(input.map.resources, input.node)
  const lines = [
    `任务：为课程《${input.courseId}》的下一节课备课。`,
    '',
    '【本课知识点】',
    `- ${input.node}（${node?.title ?? input.node}）：${node?.summary ?? '无摘要'}`,
    prerequisites.length > 0 ? `- 前置知识：${prerequisites.join('、')}（学员状态见下）` : '- 前置知识：无',
    '',
    '【学员档案】',
    `- 学习目的：${input.profile.goal}`,
    `- 现有基础：${input.profile.background || '未填写'}`,
    `- 讲解偏好：${input.profile.style || '未填写'}`,
    `- 每日投入：${input.profile.daily_minutes ? `${input.profile.daily_minutes} 分钟` : '未填写'}`,
    '',
    '【学员掌握度】',
    masteryLine(input.mastery, input.node, node?.title ?? input.node),
    ...prerequisites.map((p) => masteryLine(input.mastery, p, input.map.nodes.find((n) => n.id === p)?.title ?? p)),
    ...(resources.length > 0
      ? ['', '【已验证资料】（教学设计应基于这些资料；不得引入与其矛盾的说法）', ...resourceLines(resources, 400)]
      : []),
    '',
    '【要求】',
    '- 单节课容量：适合 1 次课讲完（学员每日约 ' + (input.profile.daily_minutes ?? 30) + ' 分钟）',
    '- 讲法贴合学员讲解偏好与现有基础',
    '- example 给一个核心例子（如涉及代码给出完整可读的代码块）',
    '- practice 为 1-3 道课中练习（随讲授穿插），每题给出参考答案',
    '- quiz 为 2-3 道课后单元小测题，全部为客观题：要么选择题（choices 恰好 4 项、answer 为 A-D 字母），要么唯一简短答案（answer 必填、accept 列出等价表述）；不得与课中练习重复',
    '- misconceptions 列出该知识点常见误区（1-3 条）',
    '',
    '请输出备课 JSON（```json 代码块）：',
    '{"node": "' + input.node + '", "title": "…", "hook": "开场引入（1-2 句）", "structure": ["要点1", …], "example": "…", "practice": [{"question": "…", "answer": "…"}], "quiz": [{"question": "…", "choices": ["A. …","B. …","C. …","D. …"], "answer": "B"}, {"question": "…", "answer": "…", "accept": ["…"]}], "misconceptions": ["…"]}',
    '除该 JSON 外不要输出其他内容。',
  ]
  return lines.join('\n')
}

export interface TeachingIntroInput {
  courseId: string
  node: string
  plan: Plan
  profile: Profile
  mastery?: Mastery
  draft: LessonDraft
  resources?: LessonResourceView[]
}

export function buildTeachingIntro(input: TeachingIntroInput): string {
  const resources = input.resources ?? []
  const lines = [
    `【课程】${input.courseId}`,
    `【学员档案】目的：${input.profile.goal}｜基础：${input.profile.background || '未填写'}｜偏好：${input.profile.style || '未填写'}｜每日投入：${input.profile.daily_minutes ?? '未填写'} 分钟`,
    `【本课知识点】${input.draft.node}（${input.draft.title}）`,
    ...(resources.length > 0
      ? ['', '【本课资料】（讲授中引用事实时标注 [资料:编号]）', ...resourceLines(resources, 500)]
      : []),
    '',
    '【本课计划】',
    `开场：${input.draft.hook}`,
    ...input.draft.structure.map((s, i) => `${i + 1}. ${s}`),
    `核心例子：${input.draft.example}`,
    ...input.draft.practice.map((p, i) => `课中练习${i + 1}：${p.question}（参考答案：${p.answer}）`),
    ...(input.draft.misconceptions?.length ? [`常见误区：${input.draft.misconceptions.join('；')}`] : []),
    '',
    '（学员已就座，请按本课计划开始讲授；全程中文）',
  ]
  return lines.join('\n')
}
