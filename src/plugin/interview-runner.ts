import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { extractProfileJson, parseProfile, preserveLearnerRequests, profileValidationError } from '../core/interview.ts'
import { createAgentChat } from './agent-chat.ts'
import { createLineReader } from './line-reader.ts'
import { printSessionTotal } from './cost-line.ts'

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
  if (!chat) throw new Error('tutor: 模型会话创建失败')
  const readAnswer = createLineReader(process.stdin)

  let reply = await chat.ask(START_MESSAGE)
  let turns = 0
  const requests: string[] = []
  while (true) {
    process.stdout.write(`${reply}\n> `)

    const profile = parseProfile(reply)
    if (profile) {
      store.create(config.courseId, preserveLearnerRequests(profile, requests))
      process.stdout.write(`\n课程 "${config.courseId}" 已创建，档案位于 ${store.root}/${config.courseId}/profile.yaml\n`)
      await chat.flush()
      printSessionTotal(chat, process.stdout)
      process.stdin.destroy()
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
      process.stdin.destroy()
  exit(1)
      return
    }

    // 空行不等于「学员没答」：可能是多按了一次回车，或共享流程桥上别的页面发来的空 /flow/input。
    // 重新提示即可，别把访谈判死。只有 stdin 真正 EOF（answer===null，如 CLI 下 Ctrl-D）才收尾退出。
    let answer = await readAnswer()
    while (answer !== null && !answer.trim()) {
      process.stdout.write('（还没收到回答，输入内容后回车；要中断请按 Ctrl-C）\n> ')
      answer = await readAnswer()
    }
    if (answer === null) {
      process.stderr.write('tutor: 输入已结束，访谈中止\n')
      await chat.flush()
      process.stdin.destroy()
      exit(1)
      return
    }
    requests.push(answer.trim())
    reply = await chat.ask(answer.trim())
  }
}

export function apply(ctx: Context, config: { courseId: string; maxTurns: number }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-interview-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  run(ctx, config).catch((error) => {
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stdin.destroy()
  exit(1)
  })
}

export { name, inject, Config }
