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

export interface KnowledgeMap {
  verified: boolean
  nodes: { id: string; title: string; summary?: string }[]
  edges: [string, string][]
  resources?: { node: string; title: string; url?: string; note?: string }[]
}

export interface LearnerProfile {
  assessed_at: string
  nodes: Record<string, { score: number; evidence?: string }>
  summary?: string
}

export interface Plan {
  path: string[]
  milestones: { id: string; title: string; nodes: string[] }[]
  current?: string
}

export type Mastery = Record<string, { status: MasteryStatusId; score?: number; review_due?: string }>

export const ProfileSchema = z.object({
  goal: z.string().required(),
  deadline: dateStr,
  daily_minutes: z.number().min(1).max(600),
  background: z.string(),
  style: z.string(),
}) as unknown as Schema<any, Profile>

export const KnowledgeMapSchema = z.object({
  verified: z.boolean().default(false),
  nodes: z.array(z.object({ id: nodeId.required(), title: z.string().required(), summary: z.string() })).required(),
  edges: z.array(z.tuple([z.string(), z.string()])).default([]),
  resources: z
    .array(z.object({ node: z.string().required(), title: z.string().required(), url: z.string(), note: z.string() }))
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
    .array(z.object({ id: nodeId.required(), title: z.string().required(), nodes: z.array(z.string()).default([]) }))
    .default([]),
  current: z.string(),
}) as unknown as Schema<any, Plan>

const MasteryEntrySchema = z.object({
  status: z
    .union([z.const('mastered'), z.const('learning'), z.const('weak'), z.const('unknown')])
    .required(),
  score: z.number().min(0).max(1),
  review_due: dateStr,
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

export const DocumentSchemas = {
  profile: ProfileSchema,
  'knowledge-map': KnowledgeMapSchema,
  'learner-profile': LearnerProfileSchema,
  plan: PlanSchema,
  mastery: MasterySchema,
  'question-bank': QuestionBankSchema,
  assessment: AssessmentStateSchema,
} satisfies Record<DocKind, Schema<any, unknown>>
