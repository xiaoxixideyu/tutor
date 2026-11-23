import { createHash } from 'node:crypto'
import { numericAnswer } from '../core/rule-grading.ts'
import {
  domainAssert,
  type ActivityContent,
  type ActivityKind,
  type Criterion,
  type LearningGoal,
  type Question,
  type Skill,
  type CourseState,
} from './model.ts'

export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/
export const COURSE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const ACTIVITY_KINDS: ActivityKind[] = [
  'explanation',
  'diagnostic',
  'practice',
  'assessment',
  'recall',
  'transfer',
]

export function object(value: unknown, label = '数据'): Record<string, unknown> {
  domainAssert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', label + '必须是对象')
  return value as Record<string, unknown>
}

export function text(value: unknown, label: string, limit = 8000, allowEmpty = false): string {
  domainAssert(typeof value === 'string', 'INVALID_INPUT', label + '必须是文本')
  const result = value.trim()
  domainAssert(
    (allowEmpty || result.length > 0) && result.length <= limit,
    'INVALID_INPUT',
    label + '为空或超过长度限制',
  )
  return result
}

export function id(value: unknown, label = '标识'): string {
  const result = text(value, label, 96)
  domainAssert(ID_PATTERN.test(result), 'INVALID_INPUT', label + '只能包含小写英文、数字、点、下划线和连字符')
  return result
}

export function strings(value: unknown, label: string, limit = 30): string[] {
  if (value === undefined) return []
  domainAssert(Array.isArray(value) && value.length <= limit, 'INVALID_INPUT', label + '必须是数量受限的数组')
  return value.map((item) => text(item, label, 2000))
}

export function integer(value: unknown, label: string, minimum: number, maximum: number, fallback?: number): number {
  const result = value === undefined && fallback !== undefined ? fallback : value
  domainAssert(
    typeof result === 'number' && Number.isSafeInteger(result) && result >= minimum && result <= maximum,
    'INVALID_INPUT',
    label + '必须是 ' + minimum + '–' + maximum + ' 的整数',
  )
  return result
}

export function date(value: unknown, label: string): string | undefined {
  if (value === undefined || value === '') return undefined
  const result = text(value, label, 10)
  const parsed = new Date(result + 'T00:00:00Z')
  domainAssert(
    /^\d{4}-\d{2}-\d{2}$/.test(result) &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === result,
    'INVALID_INPUT',
    label + '必须是有效日期',
  )
  return result
}

export function parseGoal(value: unknown): LearningGoal {
  const raw = object(value, '学习目标')
  const deadline = date(raw.deadline, '目标日期')
  return {
    text: text(raw.text, '学习目标', 4000),
    exclusions: strings(raw.exclusions, '排除项', 20),
    ...(deadline ? { deadline } : {}),
    dailyMinutes: integer(raw.dailyMinutes, '每日可用分钟', 5, 600, 20),
    priority: integer(raw.priority, '优先级', 1, 5, 3),
    requests: strings(raw.requests, '用户原话', 100),
  }
}

export function digest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
  return createHash('sha256').update(canonical).digest('hex')
}

export function questionHash(question: Question): string {
  return digest({
    type: question.type,
    prompt: question.prompt.replace(/\s+/g, ' '),
    choices: question.choices,
    answer: question.answer,
    criterionIds: question.criterionIds,
    language: question.language,
    tests: question.tests,
  })
}

export function problemFingerprint(question: Question): string {
  return digest({
    type: question.type,
    prompt: question.prompt.replace(/\s+/g, ' ').trim().toLowerCase(),
    choices: question.choices?.map((value) => value.trim().toLowerCase()).sort(),
    language: question.language,
  })
}

function criterion(value: unknown): Criterion {
  const raw = object(value, '验收标准')
  domainAssert(typeof raw.critical === 'boolean', 'INVALID_INPUT', '验收标准必须声明是否为关键要求')
  return { id: id(raw.id, '标准标识'), description: text(raw.description, '验收标准', 800), critical: raw.critical }
}

export function parseSkills(value: unknown, previous: Skill[] = []): Skill[] {
  domainAssert(
    Array.isArray(value) && value.length > 0 && value.length <= 24,
    'INVALID_INPUT',
    '每次课程调整需提供 1–24 个技能',
  )
  const added: Skill[] = value.map((item) => {
    const raw = object(item, '技能')
    domainAssert(
      Array.isArray(raw.criteria) && raw.criteria.length > 0 && raw.criteria.length <= 8,
      'INVALID_INPUT',
      '每个技能必须有 1–8 项可观察的验收标准',
    )
    const criteria = raw.criteria.map(criterion)
    domainAssert(
      new Set(criteria.map((item) => item.id)).size === criteria.length,
      'INVALID_INPUT',
      '技能的验收标准不能重复',
    )
    const policy = raw.evidencePolicy === undefined ? {} : object(raw.evidencePolicy, '证据要求')
    return {
      id: id(raw.id, '技能标识'),
      title: text(raw.title, '技能标题', 120),
      description: text(raw.description, '技能说明', 1600),
      unit: text(raw.unit ?? '学习目标', '单元', 120),
      prerequisites: strings(raw.prerequisites, '前置技能', 24).map((item) => id(item)),
      related: strings(raw.related, '关联技能', 24).map((item) => id(item)),
      criteria,
      evidencePolicy: {
        independentSamples: integer(policy.independentSamples, '独立证据数', 1, 5, 2),
        requireApplication: policy.requireApplication !== false,
      },
      required: raw.required !== false,
    }
  })
  domainAssert(new Set(added.map((item) => item.id)).size === added.length, 'INVALID_INPUT', '技能标识不能重复')
  const map = new Map(previous.map((item) => [item.id, item]))
  for (const skill of added) map.set(skill.id, skill)
  const all = [...map.values()]
  const criteria = all.flatMap((skill) => skill.criteria.map((item) => item.id))
  domainAssert(new Set(criteria).size === criteria.length, 'INVALID_INPUT', '验收标准标识必须全课程唯一')
  for (const skill of all) {
    for (const prerequisite of skill.prerequisites)
      domainAssert(map.has(prerequisite), 'UNKNOWN_SKILL', '前置技能不存在：' + prerequisite)
    for (const related of skill.related) domainAssert(map.has(related), 'UNKNOWN_SKILL', '关联技能不存在：' + related)
  }
  const visiting = new Set<string>(),
    complete = new Set<string>()
  const visit = (skillId: string): void => {
    if (complete.has(skillId)) return
    domainAssert(!visiting.has(skillId), 'CYCLIC_PREREQUISITE', '前置关系存在循环：' + skillId)
    visiting.add(skillId)
    for (const prerequisite of map.get(skillId)!.prerequisites) visit(prerequisite)
    visiting.delete(skillId)
    complete.add(skillId)
  }
  for (const skill of all) visit(skill.id)
  return all
}

export function parseActivity(value: unknown, state: CourseState): ActivityContent {
  const raw = object(value, '教学活动')
  domainAssert(ACTIVITY_KINDS.includes(raw.kind as ActivityKind), 'INVALID_INPUT', '教学活动类型不合法')
  const skillIds = strings(raw.skillIds, '活动技能', 8).map((item) => id(item))
  domainAssert(skillIds.length > 0, 'INVALID_INPUT', '教学活动至少关联一个课程技能')
  const selected = state.skills.filter((skill) => skillIds.includes(skill.id))
  domainAssert(selected.length === new Set(skillIds).size, 'UNKNOWN_SKILL', '活动引用了不存在的技能')
  const criteria = new Set(selected.flatMap((skill) => skill.criteria.map((item) => item.id)))
  const sourceIds = strings(raw.sourceIds, '资料', 12)
  for (const source of sourceIds)
    domainAssert(
      state.sources.some((item) => item.id === source),
      'UNKNOWN_SOURCE',
      '只能引用实际取得的资料',
    )
  domainAssert(
    Array.isArray(raw.questions) && raw.questions.length <= 10,
    'INVALID_INPUT',
    '活动必须提供 questions 数组，最多十题',
  )
  domainAssert(raw.kind === 'explanation' || raw.questions.length > 0, 'INVALID_INPUT', '检验活动不能没有题目')
  const questions: Question[] = raw.questions.map((value) => {
    const q = object(value, '题目')
    domainAssert(['choice', 'numeric', 'open', 'code'].includes(q.type as string), 'INVALID_INPUT', '题型不合法')
    const criterionIds = strings(q.criterionIds, '题目标准', 12)
    domainAssert(
      criterionIds.length > 0 && new Set(criterionIds).size === criterionIds.length,
      'INVALID_INPUT',
      '题目必须关联不重复的验收标准',
    )
    for (const item of criterionIds)
      domainAssert(criteria.has(item), 'UNKNOWN_CRITERION', '题目标准不属于本次技能：' + item)
    const type = q.type as Question['type']
    const question: Question = {
      id: id(q.id, '题号'),
      type,
      prompt: text(q.prompt, '题干', 12000),
      answer: text(q.answer, '参考答案', 20000),
      criterionIds,
      dimension: q.dimension === 'recognition' ? 'recognition' : 'application',
      difficulty: integer(q.difficulty, '难度', 1, 3, 2) as Question['difficulty'],
    }
    if (type === 'choice') {
      const choices = strings(q.choices, '选项', 4)
      domainAssert(
        choices.length === 4 && new Set(choices).size === 4 && /^[A-D]$/i.test(question.answer),
        'INVALID_INPUT',
        '单选题需四个不同选项，答案为 A–D',
      )
      question.choices = choices
      question.answer = question.answer.toUpperCase()
    }
    if (type === 'numeric') {
      domainAssert(numericAnswer(question.answer) !== undefined, 'INVALID_INPUT', '数值题参考答案必须是一个有效数值')
      question.accept = strings(q.accept, '等价答案', 10)
      domainAssert(
        question.accept.every((item) => numericAnswer(item) === numericAnswer(question.answer)),
        'INVALID_INPUT',
        '等价答案必须与参考数值数学等价',
      )
    }
    if (type === 'code') {
      domainAssert(
        ['javascript', 'python', 'go'].includes(q.language as string),
        'INVALID_INPUT',
        '代码任务支持 JavaScript、Python 或 Go',
      )
      domainAssert(
        Array.isArray(q.tests) && q.tests.length >= 2 && q.tests.length <= 12,
        'INVALID_INPUT',
        '代码任务需要 2–12 个输入输出检查',
      )
      question.language = q.language as Question['language']
      question.starterCode = text(q.starterCode ?? '', '初始代码', 20000, true)
      question.tests = q.tests.map((item) => {
        const test = object(item, '输入输出检查')
        return { input: text(test.input, '输入', 8000, true), output: text(test.output, '预期输出', 8000, true) }
      })
    }
    return question
  })
  domainAssert(
    new Set(questions.map((question) => question.id)).size === questions.length,
    'INVALID_INPUT',
    '题号不能重复',
  )
  return {
    kind: raw.kind as ActivityKind,
    title: text(raw.title, '活动标题', 160),
    body: text(raw.body, '教学正文', 20000, true),
    skillIds: [...new Set(skillIds)],
    questions,
    sourceIds,
    rationale: text(raw.rationale, '教学依据', 1200),
  }
}

export function validateState(value: unknown): asserts value is CourseState {
  const state = object(value, '课程状态')
  domainAssert(
    state.version === 2 && typeof state.id === 'string' && COURSE_ID_PATTERN.test(state.id),
    'INVALID_STATE',
    '课程状态版本或标识不合法',
    500,
  )
  integer(state.revision, '状态版本', 0, Number.MAX_SAFE_INTEGER)
  parseGoal(state.goal)
  for (const key of [
    'skills',
    'activities',
    'evidence',
    'hypotheses',
    'sources',
    'decisions',
    'proposals',
    'events',
    'usage',
  ]) {
    domainAssert(Array.isArray(state[key]), 'INVALID_STATE', '课程状态缺少数组：' + key, 500)
  }
  const data = value as CourseState
  domainAssert(
    new Set(data.skills.map((item) => item.id)).size === data.skills.length,
    'INVALID_STATE',
    '技能重复',
    500,
  )
  domainAssert(
    new Set(data.activities.map((item) => item.id)).size === data.activities.length,
    'INVALID_STATE',
    '活动重复',
    500,
  )
  domainAssert(
    new Set(data.evidence.map((item) => item.id)).size === data.evidence.length,
    'INVALID_STATE',
    '证据重复',
    500,
  )
  if (data.currentActivityId)
    domainAssert(
      data.activities.some((item) => item.id === data.currentActivityId && item.status !== 'completed'),
      'INVALID_STATE',
      '当前活动断点不合法',
      500,
    )
  if (data.pendingAnswer)
    domainAssert(
      data.activities.some((item) => item.id === data.pendingAnswer!.activityId),
      'INVALID_STATE',
      '待评分作答丢失活动',
      500,
    )
}
