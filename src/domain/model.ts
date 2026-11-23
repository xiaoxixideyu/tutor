export const STATE_VERSION = 2 as const
export type LearningIntent = 'learn' | 'review' | 'practice' | 'assess' | 'exam' | 'research' | 'repair'
export type ActivityKind = 'explanation' | 'diagnostic' | 'practice' | 'assessment' | 'recall' | 'transfer'
export type QuestionType = 'choice' | 'numeric' | 'open' | 'code'
export type CodeLanguage = 'javascript' | 'python' | 'go'
export type CompetencyStatus = 'needs_evidence' | 'developing' | 'supported'

export interface LearningGoal {
  text: string
  exclusions: string[]
  deadline?: string
  dailyMinutes: number
  priority: number
  requests: string[]
}

export interface LearnerProfile {
  background: string
  preferences: string[]
}

export interface Criterion {
  id: string
  description: string
  critical: boolean
}

export interface Skill {
  id: string
  title: string
  description: string
  unit: string
  prerequisites: string[]
  related: string[]
  criteria: Criterion[]
  evidencePolicy: { independentSamples: number; requireApplication: boolean }
  required: boolean
}

export interface Question {
  id: string
  type: QuestionType
  prompt: string
  choices?: string[]
  answer: string
  accept?: string[]
  criterionIds: string[]
  dimension: 'recognition' | 'application'
  difficulty: 1 | 2 | 3
  language?: CodeLanguage
  starterCode?: string
  tests?: { input: string; output: string }[]
}

export interface ActivityContent {
  kind: ActivityKind
  title: string
  body: string
  skillIds: string[]
  questions: Question[]
  sourceIds: string[]
  rationale: string
}

export interface ActivityRecord {
  id: string
  asset: string
  status: 'active' | 'paused' | 'completed'
  index: number
  answerIds: string[]
  startedAt: string
  completedAt?: string
  servedAt: string
  assistance: Record<string, number>
  activeMs: number
  decisionId: string
}

export interface CriterionResult {
  id: string
  met: boolean
  note: string
}

export interface Grade {
  score: number
  correct: boolean
  feedback: string
  criteria: CriterionResult[]
  execution?: {
    passed: number
    total: number
    results: { passed: boolean; actual: string; expected: string; error?: string }[]
  }
}

export interface AnswerEvidence {
  id: string
  kind: 'answer'
  activityId: string
  questionId: string
  questionHash: string
  problemFingerprint?: string
  contentHash: string
  asset: string
  skillIds: string[]
  questionType: QuestionType
  dimension: Question['dimension']
  difficulty: Question['difficulty']
  at: string
  independent: boolean
  assisted: boolean
  exposureCount: number
  grade: Grade
}

export interface FeedbackEvidence {
  id: string
  kind: 'feedback'
  at: string
  asset: string
  summary: string
  activityId?: string
}

export type Evidence = AnswerEvidence | FeedbackEvidence

export interface LearnerHypothesis {
  id: string
  description: string
  evidenceIds: string[]
  nextCheck: string
  status: 'tentative' | 'confirmed' | 'resolved'
  at: string
}

export interface CompetencyJudgment {
  skillId: string
  status: CompetencyStatus
  evidenceIds: string[]
  reason: string
  at: string
}

export interface SourceRecord {
  id: string
  url: string
  title: string
  asset: string
  fetchedAt: string
}

export interface MemoryState {
  stability: number
  lastTouchedAt: string
  reviewDue: string
  lapses: number
}

export interface TutorDecision {
  id: string
  basedOnRevision: number
  intent: LearningIntent
  reason: string
  action: string
  evidenceIds: string[]
  at: string
  status: 'proposed' | 'executed' | 'rejected'
}

export interface GoalProposal {
  id: string
  goal: LearningGoal
  explanation: string
  status: 'pending' | 'accepted' | 'rejected'
  at: string
}

export interface PendingAnswer {
  requestId: string
  activityId: string
  questionId: string
  questionHash: string
  inputHash: string
  asset: string
  activeMs: number
  startedAt: string
}

export interface Receipt {
  inputHash: string
  result: unknown
}

export type TeachingEventType =
  | 'course_created'
  | 'curriculum_updated'
  | 'goal_proposed'
  | 'goal_updated'
  | 'learner_feedback'
  | 'tutor_message'
  | 'activity_presented'
  | 'question_presented'
  | 'answer_evaluating'
  | 'answer_graded'
  | 'activity_completed'
  | 'activity_paused'
  | 'hypothesis_updated'
  | 'judgment_recorded'
  | 'source_saved'
  | 'tutor_busy'
  | 'tutor_ready'
  | 'tutor_failed'
  | 'session_paused'
  | 'content_reviewing'
  | 'content_rejected'
  | 'decision_recorded'
  | 'budget_updated'

export interface TeachingEvent {
  seq: number
  type: TeachingEventType
  at: string
  data: Record<string, unknown>
}

export interface ModelUsageEntry {
  id: string
  at: string
  model: string
  role: string
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  unknown: boolean
}

export interface CourseState {
  version: typeof STATE_VERSION
  id: string
  title: string
  revision: number
  creationHash?: string
  createdAt: string
  updatedAt: string
  goal: LearningGoal
  learner: LearnerProfile
  skills: Skill[]
  activities: ActivityRecord[]
  currentActivityId?: string
  evidence: Evidence[]
  hypotheses: LearnerHypothesis[]
  judgments: Record<string, CompetencyJudgment>
  memory: Record<string, MemoryState>
  sources: SourceRecord[]
  decisions: TutorDecision[]
  proposals: GoalProposal[]
  receipts: Record<string, Receipt>
  turns: Record<
    string,
    {
      intent: LearningIntent
      messageAsset: string
      status: 'pending' | 'completed' | 'failed'
      yielded: boolean
      at: string
      error?: string
      trigger?: 'user' | 'answer_result' | 'resume'
    }
  >
  pendingAnswer?: PendingAnswer
  sessionId?: string
  tutorStatus: 'idle' | 'working' | 'paused' | 'failed'
  tutorError?: string
  nextSuggestion?: { label: string; reason: string; intent: LearningIntent; basedOnRevision: number; date: string }
  goalCoverage?: { goalHash: string; skillsHash: string; complete: boolean; reason: string }
  reviewPlan?: { skillIds: string[]; date: string; reason: string }[]
  contentFailures?: { taskId: string; kind: 'activity' | 'curriculum'; issues: string[]; at: string }[]
  usage: ModelUsageEntry[]
  activeMs: number
  dailyActiveMs?: Record<string, number>
  events: TeachingEvent[]
  nextEventSeq: number
}

export class DomainError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.status = status
  }
}

export function domainAssert(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new DomainError(code, message, status)
}
