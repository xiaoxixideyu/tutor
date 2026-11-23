import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TestContext } from 'node:test'
import { CourseRepository } from '../../src/application/repository.ts'
import { CourseService } from '../../src/application/course-service.ts'
import type { ActivityContent, Skill, CourseState } from '../../src/domain/model.ts'
import { gradeObjective } from '../../src/domain/evidence.ts'
import { TutorSystem } from '../../src/application/tutor-system.ts'
import { ChatRuntime, type ChatRuntimeOptions } from '../../src/runtime/chat.ts'
import type { LlmRequest, LlmResult, LlmTransport } from '../../src/runtime/llm.ts'
import { ModelRateLimiter } from '../../src/core/model-rate-limit.ts'

export const ROOT = path.resolve(import.meta.dirname, '../..')
export const SKILL: Skill = {
  id: 'addition',
  title: '整数加法',
  description: '独立计算两个整数的和',
  unit: '算术',
  prerequisites: [],
  related: [],
  criteria: [{ id: 'addition-result', description: '得到正确的和', critical: true }],
  evidencePolicy: { independentSamples: 2, requireApplication: true },
  required: true,
}

export function activity(
  prompt = '2+3=?',
  answer = '5',
  options: Partial<ActivityContent> = {},
): ActivityContent {
  return {
    kind: 'assessment',
    title: '独立计算',
    body: '独立完成计算，不先看答案。',
    skillIds: ['addition'],
    sourceIds: [],
    rationale: '验证是否能独立计算',
    questions: [
      {
        id: 'q1',
        type: 'numeric',
        prompt,
        answer,
        criterionIds: ['addition-result'],
        dimension: 'application',
        difficulty: 2,
      },
    ],
    ...options,
  }
}

export function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-domain-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const repository = new CourseRepository(path.join(directory, 'courses'))
  let day = '2026-11-20'
  const service = new CourseService(repository, () => day)
  const course = service.create({ id: 'alpha', goal: '掌握整数加法', background: '有基础' })
  service.updateCurriculum(
    course.id,
    { skills: [SKILL], reason: '可验证目标' },
    randomUUID(),
    repository.read(course.id).revision,
  )
  return {
    directory,
    repository,
    service,
    id: course.id,
    setDay: (value: string) => {
      day = value
    },
  }
}

export function present(service: CourseService, id: string, content = activity()) {
  const state = service.repository.read(id)
  return service.presentActivity(id, content, randomUUID(), state.revision, 'test-turn').result.activityId
}

export function submit(service: CourseService, id: string, answer = '5', requestId: string = randomUUID()) {
  const view = service.view(id)
  const state = service.repository.read(id)
  const content = service.activity(state)!.content
  const question = content.questions[view.active!.index]
  service.beginAnswer(id, {
    requestId,
    activityId: view.active!.id,
    questionId: question.id,
    contentHash: view.active!.contentHash,
    answer,
    expectedRevision: view.revision,
  })
  return service.commitAnswer(id, requestId, gradeObjective(question, answer))
}

export function toolReply(name: string, args: unknown, id = randomUUID()): LlmResult {
  return {
    finish: 'tool_calls',
    text: '',
    usage: { inputTokens: 40, outputTokens: 20 },
    toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  }
}

export function jsonReply(value: unknown): LlmResult {
  return { finish: 'stop', text: JSON.stringify(value), usage: { inputTokens: 40, outputTokens: 20 } }
}

export function scriptedTransport(
  actions: LlmResult[],
  options: {
    review?: (request: LlmRequest) => unknown
    grade?: (request: LlmRequest) => unknown
    primary?: (request: LlmRequest) => LlmResult
    called?: (request: LlmRequest) => void
  } = {},
): LlmTransport {
  return async (request) => {
    options.called?.(request)
    const system = request.messages.find((message) => message.role === 'system')?.content ?? ''
    if (request.tools?.some((tool) => tool.name === 'present_activity'))
      return (
        options.primary?.(request) ??
        actions.shift() ??
        toolReply('ask_learner', { question: '你希望继续哪个部分？', reason: '等待学员选择' })
      )
    if (system.includes('独立解题员')) {
      const input = JSON.parse(request.messages.at(-1)!.content!)
      return jsonReply({
        answers: input.questions.map((question: { id: string; prompt: string; type: string }) => ({
          id: question.id,
          answer:
            question.type === 'choice'
              ? 'A'
              : question.prompt.includes('6+7')
                ? '13'
                : question.prompt.includes('5+6')
                  ? '11'
                  : '5',
          status: 'solved',
        })),
      })
    }
    if (system.includes('独立阅卷员'))
      return jsonReply(
        options.grade?.(request) ?? {
          score: 1,
          feedback: '关键要求均满足',
          criteria: JSON.parse(request.messages.at(-1)!.content!).question.criterionIds.map((id: string) => ({
            id,
            met: true,
            note: '符合量规',
          })),
        },
      )
    if (system.includes('独立核对技能'))
      return jsonReply({ complete: true, reason: '当前目标范围与技能一致' })
    if (system.includes('推荐今天'))
      return jsonReply({
        courseId: 'alpha',
        intent: 'learn',
        label: '继续整数加法',
        reason: '当前目标适合今天的时间',
        minutes: 10,
      })
    return jsonReply(
      options.review?.(request) ?? { scope: 'pass', correctness: 'pass', issues: [], arithmetic: [] },
    )
  }
}

export function runtimeFactory(directory: string, transport: LlmTransport) {
  return (options: ChatRuntimeOptions) =>
    new ChatRuntime({
      ...options,
      transport,
      rateLimiter: new ModelRateLimiter({
        file: path.join(directory, 'queue.sqlite'),
        baseUrl: 'https://fixture.invalid/v1',
        apiKey: 'fixture',
        requestsPerMinute: 600,
        windowMs: 1,
      }),
    })
}

export function systemFixture(t: TestContext, transport: LlmTransport) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-system-'))
  const env = {
    TUTOR_LLM_BASE_URL: 'https://fixture.invalid/v1',
    TUTOR_LLM_API_KEY: 'fixture-key',
    TUTOR_LLM_MODEL: 'fixture',
    TUTOR_LLM_REQUESTS_PER_MINUTE: '600',
    TUTOR_MCP_SEARCH_URL: '',
    TUTOR_MCP_SEARCH_TOKEN: '',
    TUTOR_REVIEW_MODEL: '',
    TUTOR_JUDGMENT_PROVIDER: 'llm',
    TUTOR_JUDGMENT_API_KEY: '',
  }
  const options = {
    root: ROOT,
    dataRoot: path.join(directory, 'data'),
    coursesRoot: path.join(directory, 'courses'),
    modelConfigFile: path.join(directory, 'model-config.json'),
    env,
    runtimeFactory: runtimeFactory(directory, transport),
  }
  const system = new TutorSystem(options)
  t.after(async () => {
    await system.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, options, system }
}

export function stateOf(service: CourseService): CourseState {
  return service.repository.read('alpha')
}
