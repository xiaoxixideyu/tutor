import { LessonDraftSchema, type KnowledgeMapResource, type KnowledgeMap, type LessonDraft, type Mastery, type Plan, type Profile, type Question, type QuestionBank } from './schema.ts'
import { courseNodeOrder } from './plan.ts'
import { profileScope } from './interview.ts'
import { ruleAnswerIssue } from './rule-grading.ts'
import { daysBetween, memoryCard, WARMUP_RETENTION_THRESHOLD } from './scheduler.ts'

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

export const MAX_STRUCTURE_POINTS = 5

// 单节课要点上限：按每日投入时长收紧（约每 15 分钟讲一个要点），夹在 3–5 之间。
// 备课容量必须匹配一次课能讲完的量——否则课会讲不完、断点续学也补不上（见忠实度审计）。
export function lessonStructureCap(dailyMinutes: number | undefined): number {
  return Math.max(3, Math.min(MAX_STRUCTURE_POINTS, Math.round((dailyMinutes ?? 30) / 15)))
}

export function validateLessonDraft(
  draft: unknown,
  expectedNode?: string,
  maxStructure: number = MAX_STRUCTURE_POINTS
): { ok: true; value: LessonDraft } | { ok: false; error: string } {
  let value: LessonDraft
  try {
    value = LessonDraftSchema(draft) as LessonDraft
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.replace(/\n+/g, ' ') : String(error) }
  }
  if (expectedNode && value.node !== expectedNode) {
    return { ok: false, error: `备课产物 node 为 "${value.node}"，应为 "${expectedNode}"` }
  }
  if (value.structure.length < 1 || value.structure.length > maxStructure) {
    return { ok: false, error: `structure 需 1-${maxStructure} 个要点，当前 ${value.structure.length}（一次课容量上限）` }
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
    const formatIssue = ruleAnswerIssue(item)
    if (formatIssue) return { ok: false, error: `小测题"${item.question}"：${formatIssue}` }
  }
  return { ok: true, value }
}

export function currentNode(plan: Plan, mastery: Mastery | undefined, map?: KnowledgeMap): string | null {
  const candidates = courseNodeOrder(plan, map)
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

function masteryLine(mastery: Mastery | undefined, node: string, title: string, today?: string): string {
  const entry = mastery?.[node]
  const status = entry?.status ?? 'unknown'
  const score = entry?.score !== undefined ? ` ${entry.score}` : ''
  const memory = today !== undefined && entry ? memorySummary(entry, today) : ''
  return `- ${node}（${title}）：${status}${score}${memory}`
}

// 记忆状态注记：距上次实测天数与保留率估计；低于热身阈值时建议先回忆。
function memorySummary(entry: Mastery[string], today: string): string {
  const card = memoryCard(entry, today)
  if (!card) return ''
  const pct = Math.round(card.retention * 100)
  const hint = card.retention < WARMUP_RETENTION_THRESHOLD ? '，建议先回忆热身' : ''
  return `（距上次实测 ${card.elapsedDays} 天，预计保留 ≈${pct}%${hint}）`
}

export function latestTouchedAt(mastery: Mastery | undefined): string | undefined {
  let latest: string | undefined
  for (const entry of Object.values(mastery ?? {})) {
    if (entry.last_touched_at !== undefined && (latest === undefined || entry.last_touched_at > latest)) latest = entry.last_touched_at
  }
  return latest
}

export interface WarmupQuestion {
  node: string
  title?: string
  question: Question
}

// 前置回忆热身：只挑"到期或保留率估计偏低"的前置节点，每点一题，最多 limit 点。
// 保留率不可估计（旧数据）且未到期的前置不打扰；热身走规则判分，零模型成本。
export function selectWarmupQuestions(map: KnowledgeMap, mastery: Mastery | undefined, bank: QuestionBank, node: string, today: string, limit = 2): WarmupQuestion[] {
  const candidates: { node: string; retention: number }[] = []
  for (const id of prerequisiteIds(map, node)) {
    const entry = mastery?.[id]
    if (!entry || entry.status === 'unknown') continue
    const due = entry.review_due !== undefined && entry.review_due <= today
    const retention = memoryCard(entry, today)?.retention
    if (!due && (retention === undefined || retention >= WARMUP_RETENTION_THRESHOLD)) continue
    if ((bank[id]?.length ?? 0) === 0) continue
    candidates.push({ node: id, retention: retention ?? -1 })
  }
  return candidates
    .sort((a, b) => a.retention - b.retention)
    .slice(0, limit)
    .map((candidate) => {
      const questions = bank[candidate.node] ?? []
      const question = questions.find((item) => item.difficulty === 2) ?? questions[0]!
      const title = map.nodes.find((item) => item.id === candidate.node)?.title
      return { node: candidate.node, ...(title !== undefined ? { title } : {}), question }
    })
}

export interface PretestPick {
  node: string
  title?: string
  question: Question
}

// 小测末尾的旧知识回访（交错练习 interleaving）：只从已掌握节点选一题，
// 保留率最低优先、到期优先；excludeQuestionIds 排除本节课热身已用过的题。
export function selectInterleaveQuestion(map: KnowledgeMap, mastery: Mastery | undefined, bank: QuestionBank, excludeNode: string, today: string, excludeQuestionIds: string[] = []): PretestPick | null {
  const candidates: { node: string; retention: number; dueDate: string }[] = []
  for (const [id, entry] of Object.entries(mastery ?? {})) {
    if (id === excludeNode || entry.status !== 'mastered') continue
    if (!map.nodes.some((item) => item.id === id)) continue
    const questions = (bank[id] ?? []).filter((item) => !excludeQuestionIds.includes(item.id))
    if (questions.length === 0) continue
    const due = entry.review_due !== undefined && entry.review_due <= today
    const retention = memoryCard(entry, today)?.retention ?? (due ? 0.5 : 0.95)
    candidates.push({ node: id, retention, dueDate: entry.review_due ?? '9999-12-31' })
  }
  const pick = candidates.sort((a, b) => a.retention - b.retention || a.dueDate.localeCompare(b.dueDate) || a.node.localeCompare(b.node))[0]
  if (!pick) return null
  const questions = (bank[pick.node] ?? []).filter((item) => !excludeQuestionIds.includes(item.id))
  const question = questions.find((item) => item.difficulty === 2) ?? questions[0]!
  const title = map.nodes.find((item) => item.id === pick.node)?.title
  return { node: pick.node, ...(title !== undefined ? { title } : {}), question }
}

export const STALE_PREREQ_RETENTION = 0.75
export const STALE_PREREQ_OVERDUE_DAYS = 14

export interface StalePrerequisite {
  node: string
  title?: string
  retention?: number
  elapsedDays?: number
  overdue_days?: number
}

// 前置新鲜度软门：只对已掌握但明显生疏的前置报警；无锚点旧数据按逾期天数兜底。
export function stalePrerequisites(map: KnowledgeMap, mastery: Mastery | undefined, node: string, today: string): StalePrerequisite[] {
  return prerequisiteIds(map, node).flatMap((id) => {
    const entry = mastery?.[id]
    if (!entry || entry.status !== 'mastered') return []
    const card = memoryCard(entry, today)
    const overdueDays = entry.review_due !== undefined ? Math.max(0, daysBetween(entry.review_due, today)) : 0
    const stale = card ? card.retention < STALE_PREREQ_RETENTION : overdueDays >= STALE_PREREQ_OVERDUE_DAYS
    if (!stale) return []
    const title = map.nodes.find((item) => item.id === id)?.title
    return [{
      node: id, ...(title !== undefined ? { title } : {}),
      ...(card ? { retention: card.retention, elapsedDays: card.elapsedDays } : {}),
      ...(overdueDays > 0 ? { overdue_days: overdueDays } : {}),
    }]
  })
}

export interface MemoryNote {
  node: string
  title?: string
  elapsedDays: number
  retention: number
}

// 目标节点与前置的记忆状态卡（供讲授首消息注入）；无锚点的旧数据不产生注记。
export function memoryNotes(map: KnowledgeMap, mastery: Mastery | undefined, node: string, today: string): MemoryNote[] {
  const ids = [...new Set([node, ...prerequisiteIds(map, node)])]
  return ids.flatMap((id) => {
    const card = memoryCard(mastery?.[id], today)
    if (!card) return []
    const title = map.nodes.find((item) => item.id === id)?.title
    return [{ node: id, ...(title !== undefined ? { title } : {}), elapsedDays: card.elapsedDays, retention: card.retention }]
  })
}

export interface PrepInput {
  courseId: string
  node: string
  map: KnowledgeMap
  plan: Plan
  profile: Profile
  mastery?: Mastery
  today?: string
  // 学员观察记录（错因/自评校准/课堂反馈）：按需注入，缺省保持旧行为。
  errors?: { node: string; question: string; your: string }[]
  calibration?: { at: string; predicted: number; actual: number }
  styleNotes?: { at: string; kind: 'confused' | 'resolved'; detail: string }[]
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export function buildPrepPrompt(input: PrepInput): string {
  const node = input.map.nodes.find((n) => n.id === input.node)
  const prerequisites = prerequisiteIds(input.map, input.node)
  const resources = resourcesForNode(input.map.resources, input.node)
  const minutes = input.profile.daily_minutes ?? 30
  const cap = lessonStructureCap(input.profile.daily_minutes)
  const recent = input.today !== undefined ? latestTouchedAt(input.mastery) : undefined
  const errors = input.errors ?? []
  const styleNotes = input.styleNotes ?? []
  const lines = [
    `任务：为课程《${input.courseId}》的下一节课备课。`,
    '',
    '【本课知识点】',
    `- ${input.node}（${node?.title ?? input.node}）：${node?.summary ?? '无摘要'}`,
    prerequisites.length > 0 ? `- 前置知识：${prerequisites.join('、')}（学员状态见下）` : '- 前置知识：无',
    '',
    '【学员档案】',
    `- 学习目的与原始范围：${profileScope(input.profile)}`,
    `- 现有基础：${input.profile.background || '未填写'}`,
    `- 讲解偏好：${input.profile.style || '未填写'}`,
    `- 每日投入：${input.profile.daily_minutes ? `${input.profile.daily_minutes} 分钟` : '未填写'}`,
    ...(recent !== undefined ? [`- 最近一次学习/复习：${recent}（距今 ${Math.max(0, daysBetween(recent, input.today!))} 天）`] : []),
    '',
    '【学员掌握度】',
    masteryLine(input.mastery, input.node, node?.title ?? input.node, input.today),
    ...prerequisites.map((p) => masteryLine(input.mastery, p, input.map.nodes.find((n) => n.id === p)?.title ?? p, input.today)),
    ...(errors.length > 0
      ? ['', '【学员常见错误】（历史作答原文，用于针对性设伏；不要照抄原题）', ...errors.map((e) => `- ${e.node}：在「${truncate(e.question, 24)}」上曾答成「${truncate(e.your, 24)}」`)]
      : []),
    ...(input.calibration
      ? ['', `【自我评估校准】最近小测：学员自评 ${input.calibration.predicted}%，实际 ${Math.round(input.calibration.actual * 100)}%${input.calibration.predicted > input.calibration.actual * 100 ? '（高估）——适当增加独立检验，不因自评高就跳步' : '（低估）——多给正向确认，避免过度重复已会内容'}`]
      : []),
    ...(styleNotes.length > 0
      ? ['', '【课堂反馈】', ...styleNotes.map((s) => `- ${s.at}：学员表示「${truncate(s.detail, 30)}」`),
        ...(styleNotes.some((s) => s.kind === 'confused') ? ['近期有跟不上信号：默认放慢节奏、先类比后细节、每讲一个要点停步检验。'] : [])]
      : []),
    ...(resources.length > 0
      ? ['', `【本课资料】（${node?.verified ? '已通过来源数量校验，仍须核对具体事实' : '尚未完成交叉验证，不能视为已证实的事实'}）`, ...resourceLines(resources, 400)]
      : []),
    '',
    '【要求】',
    `- 单节课容量（硬约束）：structure 最多 ${cap} 个要点，且必须能在学员每日约 ${minutes} 分钟内讲完`,
    `- 若该知识点内容超过一节课容量：只挑最核心的 ${cap} 个要点组织本课，其余留到后续，不要硬塞进这一节`,
    '- 保留率低的前置：开场先用类比或最小例子重建，再衔接新内容，避免默认学员还记得',
    '- 讲法贴合学员讲解偏好与现有基础',
    '- 严格遵守学习目的中的范围与排除项，资料中的超范围例子不进入本课；区分必要条件与推荐做法，不把一种示例写成唯一合法做法',
    '- example 给一个核心例子（如涉及代码给出完整可读的代码块）',
    '- practice 为 1-3 道课中练习（随讲授穿插），每题给出参考答案',
    '- quiz 为 2-3 道课后单元小测题，全部为客观题：四选一（choices 恰好 4 项、answer 为 A-D 字母），或单一数值填空（answer 仅整数、小数或分数，题干明确只填数值）；概念解释、代码、多项输出必须改成四选一，不得要求一句话说明再用整句精确匹配；不得与课中练习重复',
    '- misconceptions 列出该知识点常见误区（1-3 条）',
    '',
    '请输出备课 JSON（```json 代码块）：',
    '{"node": "' + input.node + '", "title": "…", "hook": "开场引入（1-2 句）", "structure": ["要点1", …], "example": "…", "practice": [{"question": "…", "answer": "…"}], "quiz": [{"question": "…", "choices": ["A. …","B. …","C. …","D. …"], "answer": "B"}, {"question": "…（只填数值）", "answer": "2"}], "misconceptions": ["…"]}',
    '除该 JSON 外不要输出其他内容。',
  ]
  return lines.join('\n')
}

export interface WarmupRecord {
  node: string
  title?: string
  question: string
  correct: boolean
  // 题库题号：供小测交错回访排除重复题（注入提示词时忽略）。
  questionId?: string
}

export interface TeachingIntroInput {
  courseId: string
  node: string
  plan: Plan
  profile: Profile
  mastery?: Mastery
  draft: LessonDraft
  resources?: LessonResourceView[]
  // 记忆状态与开课热身结果（由 learn 流程现场采集）；缺省时不注入，保持旧行为。
  memory?: MemoryNote[]
  warmup?: WarmupRecord[]
}

export function buildTeachingIntro(input: TeachingIntroInput): string {
  const resources = input.resources ?? []
  const memory = input.memory ?? []
  const warmup = input.warmup ?? []
  const lines = [
    `【课程】${input.courseId}`,
    `【学员档案】目的与原始范围：${profileScope(input.profile)}｜基础：${input.profile.background || '未填写'}｜偏好：${input.profile.style || '未填写'}｜每日投入：${input.profile.daily_minutes ?? '未填写'} 分钟`,
    `【本课知识点】${input.draft.node}（${input.draft.title}）`,
    ...(memory.length > 0
      ? ['', '【学员记忆状态】（估计值，用于决定讲法与热身）', ...memory.map((m) =>
          `- ${m.node}（${m.title ?? m.node}）：距上次实测 ${m.elapsedDays} 天，预计保留 ≈${Math.round(m.retention * 100)}%${m.retention < WARMUP_RETENTION_THRESHOLD ? '——低保留，讲新内容前先用类比或最小例子重建' : ''}`)]
      : []),
    ...(warmup.length > 0
      ? ['', '【开课热身】（学员刚做的前置回忆检查，不计分）', ...warmup.map((w) =>
          `- ${w.node}：${w.correct ? '✓ 答对' : '✗ 答错'}（${w.question}）`),
        ...(warmup.some((w) => !w.correct) ? ['热身有答错：先把对应前置讲清再进入本课，不要忽略。'] : [])]
      : []),
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
