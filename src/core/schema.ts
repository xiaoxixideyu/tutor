import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

export const MasteryStatus = ['mastered', 'learning', 'weak', 'unknown'] as const
export type MasteryStatusId = (typeof MasteryStatus)[number]

const dateStr = z.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
const nodeId = z.string().pattern(/^[a-z0-9][a-z0-9-]*$/)

export interface Profile {
  goal: string
  deadline?: string
  daily_minutes?: number
  background?: string
  style?: string
}

export interface KnowledgeMapResource {
  node: string
  title: string
  url?: string
  note?: string
  material?: string
}

export interface KnowledgeMap {
  verified: boolean
  researched_at?: string
  nodes: { id: string; title: string; summary?: string; verified?: boolean }[]
  edges: [string, string][]
  resources?: KnowledgeMapResource[]
}

export interface LearnerProfile {
  assessed_at: string
  nodes: Record<string, { score: number; evidence?: string }>
  summary?: string
}

export interface Plan {
  path: string[]
  milestones: { id: string; title: string; nodes: string[]; exam_date?: string; exam_score?: number; exam_passed?: boolean }[]
  current?: string
}

export interface MasteryEntry {
  status: MasteryStatusId
  score?: number
  review_due?: string
  review_stage?: number
}

export type Mastery = Record<string, MasteryEntry>

export const ProfileSchema = z.object({
  goal: z.string().required(),
  deadline: dateStr,
  daily_minutes: z.number().min(1).max(600),
  background: z.string(),
  style: z.string(),
}) as unknown as Schema<any, Profile>

export const KnowledgeMapSchema = z.object({
  verified: z.boolean().default(false),
  researched_at: dateStr,
  nodes: z
    .array(z.object({ id: nodeId.required(), title: z.string().required(), summary: z.string(), verified: z.boolean() }))
    .required(),
  edges: z.array(z.tuple([z.string(), z.string()])).default([]),
  resources: z
    .array(
      z.object({
        node: z.string().required(),
        title: z.string().required(),
        url: z.string(),
        note: z.string(),
        material: z.string(),
      })
    )
    .default([]),
}) as unknown as Schema<any, KnowledgeMap>

export const LearnerProfileSchema = z.object({
  assessed_at: dateStr.required(),
  nodes: z.dict(z.object({ score: z.number().min(0).max(1).required(), evidence: z.string() })).default({}),
  summary: z.string(),
}) as unknown as Schema<any, LearnerProfile>

export const PlanSchema = z.object({
  path: z.array(z.string()).required(),
  milestones: z
    .array(
      z.object({
        id: nodeId.required(),
        title: z.string().required(),
        nodes: z.array(z.string()).default([]),
        exam_date: dateStr,
        exam_score: z.number().min(0).max(1),
        exam_passed: z.boolean(),
      })
    )
    .default([]),
  current: z.string(),
}) as unknown as Schema<any, Plan>

const MasteryEntrySchema = z.object({
  status: z
    .union([z.const('mastered'), z.const('learning'), z.const('weak'), z.const('unknown')])
    .required(),
  score: z.number().min(0).max(1),
  review_due: dateStr,
  review_stage: z.number().min(1).max(4),
}) as unknown as Schema<any, Mastery[string]>

export const MasterySchema = z.dict(MasteryEntrySchema) as unknown as Schema<any, Mastery>

export interface Question {
  id: string
  difficulty: 1 | 2 | 3
  type: 'choice' | 'short'
  question: string
  choices?: string[]
  answer: string
  accept?: string[]
}

export interface QuestionBank {
  [nodeId: string]: Question[]
}

export interface AssessmentState {
  node_order: string[]
  current_node: string
  asked: { node: string; qid: string; difficulty: 1 | 2 | 3; correct: boolean }[]
  scores: Record<string, number>
}

const questionChoiceSchema = z.object({
  id: z.string().required(),
  difficulty: z.union([z.const(1), z.const(2), z.const(3)]).required(),
  type: z.union([z.const('choice'), z.const('short')]).required(),
  question: z.string().required(),
  choices: z.array(z.string()),
  answer: z.string().required(),
  accept: z.array(z.string()),
})

export const QuestionBankSchema = z.dict(z.array(questionChoiceSchema).default([])) as unknown as Schema<any, QuestionBank>

export const AssessmentStateSchema = z.object({
  node_order: z.array(z.string()).required(),
  current_node: z.string().required(),
  asked: z
    .array(
      z.object({
        node: z.string().required(),
        qid: z.string().required(),
        difficulty: z.union([z.const(1), z.const(2), z.const(3)]).required(),
        correct: z.boolean().required(),
      })
    )
    .default([]),
  scores: z.dict(z.number().min(0).max(1)).default({}),
}) as unknown as Schema<any, AssessmentState>

export type DocKind =
  | 'profile'
  | 'knowledge-map'
  | 'learner-profile'
  | 'plan'
  | 'mastery'
  | 'question-bank'
  | 'assessment'
  | 'lesson'
  | 'practice'
  | 'practice-state'

export interface LessonPractice {
  question: string
  answer: string
  accept?: string[]
  choices?: string[]
}

export interface LessonDraft {
  node: string
  title: string
  hook: string
  structure: string[]
  example: string
  practice: LessonPractice[]
  quiz: LessonPractice[]
  misconceptions?: string[]
}

export const LessonPracticeSchema = z.object({
  question: z.string().required(),
  answer: z.string().required(),
  accept: z.array(z.string()),
  choices: z.array(z.string()),
})

export const LessonDraftSchema = z.object({
  node: z.string().required(),
  title: z.string().required(),
  hook: z.string().required(),
  structure: z.array(z.string()).required(),
  example: z.string().required(),
  practice: z.array(LessonPracticeSchema).required(),
  quiz: z.array(LessonPracticeSchema).required(),
  misconceptions: z.array(z.string()),
}) as unknown as Schema<any, LessonDraft>

export interface LessonState {
  session_id: string
  node: string
  started_at: string
  draft: LessonDraft
}

export const LessonStateSchema = z.object({
  session_id: z.string().required(),
  node: z.string().required(),
  started_at: z.string().required(),
  draft: LessonDraftSchema.required(),
}) as unknown as Schema<any, LessonState>

export interface PracticeTest {
  name: string
  command: string
  expect_exit?: number
  expect_output_contains?: string[]
}

export interface PracticeTask {
  id: string
  node: string
  title: string
  prompt: string
  starter_files?: { path: string; content: string }[]
  tests: PracticeTest[]
  hints?: string[]
}

export interface PracticeTaskFile {
  generated_at: string
  tasks: PracticeTask[]
}

export interface PracticeTaskState {
  node: string
  task_id: string
  updated_at: string
  done_tests: string[]
  done: boolean
  attempts: number
}

const starterFileSchema = z.object({ path: z.string().required(), content: z.string().required() })

const practiceTestSchema = z.object({
  name: z.string().required(),
  command: z.string().required(),
  expect_exit: z.number(),
  expect_output_contains: z.array(z.string()),
})

const practiceTaskSchema = z.object({
  id: nodeId.required(),
  node: nodeId.required(),
  title: z.string().required(),
  prompt: z.string().required(),
  starter_files: z.array(starterFileSchema),
  tests: z.array(practiceTestSchema).required(),
  hints: z.array(z.string()),
})

export const PracticeTaskFileSchema = z.object({
  generated_at: dateStr.required(),
  // 注：schemastery 的 array.min 对 object 元素不生效（实测），非空约束由 validatePracticeTasks 负责
  tasks: z.array(practiceTaskSchema).required(),
}) as unknown as Schema<any, PracticeTaskFile>

export const PracticeTaskStateSchema = z.object({
  node: nodeId.required(),
  task_id: nodeId.required(),
  updated_at: dateStr.required(),
  done_tests: z.array(z.string()).default([]),
  done: z.boolean().required(),
  attempts: z.number().min(0).default(0),
}) as unknown as Schema<any, PracticeTaskState>

export const DocumentSchemas = {
  profile: ProfileSchema,
  'knowledge-map': KnowledgeMapSchema,
  'learner-profile': LearnerProfileSchema,
  plan: PlanSchema,
  mastery: MasterySchema,
  'question-bank': QuestionBankSchema,
  assessment: AssessmentStateSchema,
  lesson: LessonStateSchema,
  practice: PracticeTaskFileSchema,
  'practice-state': PracticeTaskStateSchema,
} satisfies Record<DocKind, Schema<any, unknown>>
