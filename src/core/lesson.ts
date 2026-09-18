import { LessonDraftSchema, type KnowledgeMap, type LessonDraft, type Mastery, type Plan, type Profile } from './schema.ts'

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
  return { ok: true, value }
}

export function currentNode(plan: Plan, mastery: Mastery | undefined): string | null {
  const candidates = plan.path.length > 0 ? plan.path : plan.current ? [plan.current] : []
  for (const node of candidates) {
    if (mastery?.[node]?.status !== 'mastered') return node
  }
  return null
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
    '',
    '【要求】',
    '- 单节课容量：适合 1 次课讲完（学员每日约 ' + (input.profile.daily_minutes ?? 30) + ' 分钟）',
    '- 讲法贴合学员讲解偏好与现有基础',
    '- example 给一个核心例子（如涉及代码给出完整可读的代码块）',
    '- practice 为 1-3 道课中练习（随讲授穿插），每题给出参考答案',
    '- misconceptions 列出该知识点常见误区（1-3 条）',
    '',
    '请输出备课 JSON（```json 代码块）：',
    '{"node": "' + input.node + '", "title": "…", "hook": "开场引入（1-2 句）", "structure": ["要点1", …], "example": "…", "practice": [{"question": "…", "answer": "…"}], "misconceptions": ["…"]}',
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
}

export function buildTeachingIntro(input: TeachingIntroInput): string {
  const lines = [
    `【课程】${input.courseId}`,
    `【学员档案】目的：${input.profile.goal}｜基础：${input.profile.background || '未填写'}｜偏好：${input.profile.style || '未填写'}｜每日投入：${input.profile.daily_minutes ?? '未填写'} 分钟`,
    `【本课知识点】${input.draft.node}（${input.draft.title}）`,
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
