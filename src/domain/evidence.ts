import { matchesRuleAnswer } from '../core/rule-grading.ts'
import { addDays, daysBetween, gradeForScore, intervalDays, nextStability } from '../core/scheduler.ts'
import type {
  AnswerEvidence,
  CourseState,
  Grade,
  LearningProgress,
  MemoryState,
  Question,
  Skill,
} from './model.ts'
import { digest } from './validation.ts'

export function gradeObjective(question: Question, answer: string): Grade {
  let correct: boolean
  if (question.type === 'choice') {
    const letter = answer
      .trim()
      .toUpperCase()
      .replace(/[.、．)\s]+$/, '')
    const expected = question.answer.toUpperCase()
    const index = 'ABCD'.indexOf(expected)
    correct = letter === expected || matchesRuleAnswer(answer, [question.choices![index]])
  } else correct = matchesRuleAnswer(answer, [question.answer, ...(question.accept ?? [])])
  return {
    score: correct ? 1 : 0,
    correct,
    feedback: correct ? '回答正确。' : '这次还没有答对，参考答案：' + question.answer,
    criteria: question.criterionIds.map((id) => ({
      id,
      met: correct,
      note: correct ? '本题作答符合要求' : '本题作答未满足要求',
    })),
  }
}

export function eligibleEvidence(state: CourseState, skill: Skill): AnswerEvidence[] {
  return state.evidence.filter(
    (evidence): evidence is AnswerEvidence =>
      evidence.kind === 'answer' &&
      evidence.skillIds.includes(skill.id) &&
      evidence.independent &&
      !evidence.assisted &&
      evidence.exposureCount === 1 &&
      evidence.difficulty >= 2,
  )
}

export function competencyEligibility(
  state: CourseState,
  skill: Skill,
): { eligible: boolean; reasons: string[]; evidenceIds: string[] } {
  const all = eligibleEvidence(state, skill)
  const successes = all.filter((item) => item.grade.correct)
  const distinct = new Set(successes.map((item) => item.problemFingerprint ?? item.questionHash))
  const reasons: string[] = []
  if (skill.evidencePolicy.independentSamples === 1) {
    const critical = skill.criteria.filter((item) => item.critical).map((item) => item.id)
    const strong = successes.some(
      (item) =>
        item.difficulty === 3 &&
        item.dimension === 'application' &&
        (item.questionType === 'open' || item.questionType === 'code') &&
        critical.length >= 2 &&
        critical.every((id) => item.grade.criteria.some((result) => result.id === id && result.met)) &&
        (item.questionType !== 'code' ||
          (!!item.grade.execution &&
            item.grade.execution.total >= 3 &&
            item.grade.execution.passed === item.grade.execution.total)),
    )
    if (!strong) reasons.push('单条证据必须是覆盖多个关键要求的独立高级应用任务；基础题或单项辨认不足以达成')
  }
  if (distinct.size < skill.evidencePolicy.independentSamples) {
    reasons.push(
      '还需要不同题目或任务的独立成功证据（目前 ' +
        distinct.size +
        '/' +
        skill.evidencePolicy.independentSamples +
        '）',
    )
  }
  for (const criterion of skill.criteria) {
    const covered = all.filter((item) => item.grade.criteria.some((result) => result.id === criterion.id))
    const latest = covered.at(-1)
    if (
      !covered.some((item) => item.grade.criteria.some((result) => result.id === criterion.id && result.met))
    ) {
      reasons.push('尚未验证：' + criterion.description)
    } else if (
      criterion.critical &&
      latest &&
      !latest.grade.criteria.find((result) => result.id === criterion.id)!.met
    ) {
      reasons.push('关键要求最近出现冲突证据：' + criterion.description)
    }
  }
  if (
    skill.evidencePolicy.requireApplication &&
    !successes.some((item) => item.dimension === 'application' && item.questionType !== 'choice')
  ) {
    reasons.push('还缺少无提示的实际应用或独立任务证据')
  }
  return { eligible: reasons.length === 0, reasons, evidenceIds: all.map((item) => item.id) }
}

export function competencyStatus(
  state: CourseState,
  skill: Skill,
): 'supported' | 'developing' | 'needs_evidence' {
  const judgment = state.judgments[skill.id]
  if (judgment?.status === 'supported')
    return competencyEligibility(state, skill).eligible ? 'supported' : 'needs_evidence'
  return (
    judgment?.status ??
    (state.evidence.some((item) => item.kind === 'answer' && item.skillIds.includes(skill.id))
      ? 'developing'
      : 'needs_evidence')
  )
}

export function learningProgress(state: CourseState): LearningProgress {
  const statuses = state.skills
    .filter((skill) => skill.required)
    .map((skill) => competencyStatus(state, skill))
  return {
    completedAnswers: state.evidence.filter((evidence) => evidence.kind === 'answer').length,
    developing: statuses.filter((status) => status === 'developing').length,
    supported: statuses.filter((status) => status === 'supported').length,
    needsEvidence: statuses.filter((status) => status === 'needs_evidence').length,
    total: statuses.length,
  }
}

export function updateMemory(previous: MemoryState | undefined, score: number, day: string): MemoryState {
  const elapsed = previous ? daysBetween(previous.lastTouchedAt, day) : undefined
  const stability = nextStability(previous?.stability, gradeForScore(score), elapsed)
  return {
    stability,
    lastTouchedAt: day,
    reviewDue: addDays(day, score < 0.5 ? 1 : intervalDays(stability)),
    lapses: (previous?.lapses ?? 0) + (score < 0.5 ? 1 : 0),
  }
}

export function goalSupported(state: CourseState): boolean {
  const required = state.skills.filter((skill) => skill.required)
  return (
    state.goalCoverage?.complete === true &&
    state.goalCoverage.goalHash === digest(state.goal) &&
    state.goalCoverage.skillsHash === digest(state.skills) &&
    required.length > 0 &&
    required.every((skill) => competencyStatus(state, skill) === 'supported')
  )
}
