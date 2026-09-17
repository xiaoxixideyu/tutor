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

export type DocKind = 'profile' | 'knowledge-map' | 'learner-profile' | 'plan' | 'mastery'

export const DocumentSchemas = {
  profile: ProfileSchema,
  'knowledge-map': KnowledgeMapSchema,
  'learner-profile': LearnerProfileSchema,
  plan: PlanSchema,
  mastery: MasterySchema,
} satisfies Record<DocKind, Schema<any, unknown>>
