import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { extractProfileJson, parseProfile, profileValidationError } from '../core/interview.ts'
import { createAgentChat } from './agent-chat.ts'
import { createLineReader } from './line-reader.ts'

const name = 'tutor-interview-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({
  courseId: z.string().required(),
  maxTurns: z.number().default(24),
})

const START_MESSAGE = '（学员已就座，请开始需求访谈）'

async function run(ctx: Context, config: { courseId: string; maxTurns: number }): Promise<void> {
  const courseState = ctx.get('courseState') as
    | { store: { create(id: string, profile: unknown): void; root: string } }
    | undefined
  if (!courseState) throw new Error('tutor: 核心服务未就绪')
  const store = courseState.store
  const exit = ctx.get('appExit') as unknown as (code: number) => void
  const chat = await createAgentChat(ctx)
  const readAnswer = createLineReader(process.stdin)

  let reply = await chat.ask(START_MESSAGE)
  let turns = 0
  while (true) {
    process.stdout.write(`${reply}\n> `)

    const profile = parseProfile(reply)
    if (profile) {
      store.create(config.courseId, profile)
      process.stdout.write(`\n课程 "${config.courseId}" 已创建，档案位于 ${store.root}/${config.courseId}/profile.yaml\n`)
      await chat.flush()
      exit(0)
      return
    }

    if (extractProfileJson(reply) !== null) {
      reply = await chat.ask(`你输出的 JSON 档案校验失败：${profileValidationError(reply)}。请修正后重新输出完整 JSON 块。`)
      continue
    }

    turns += 1
    if (turns > config.maxTurns) {
      process.stderr.write('tutor: 超过最大访谈轮数\n')
      await chat.flush()
      exit(1)
      return
    }

    const answer = await readAnswer()
    if (!answer || !answer.trim()) {
      process.stderr.write('tutor: 未收到学员回答，访谈结束\n')
      await chat.flush()
      exit(1)
      return
    }
    reply = await chat.ask(answer.trim())
  }
}

export function apply(ctx: Context, config: { courseId: string; maxTurns: number }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-interview-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}

export { name, inject, Config }
