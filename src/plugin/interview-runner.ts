import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { extractProfileJson, parseProfile, profileValidationError } from '../core/interview.ts'

const name = 'tutor-interview-runner'
const inject = ['agentDefaultModel', 'agents', 'sessions', 'courseState']
const Config = z.object({
  courseId: z.string().required(),
  maxTurns: z.number().default(24),
})

const START_MESSAGE = '（学员已就座，请开始需求访谈）'
const REPLY_PROMPT = '\n> '

interface RunnerIo {
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  exit: (code: number) => void
}

interface SessionEventView {
  type: string
  data?: {
    message?: { content: { type: string; text?: string }[] }
    reason?: { kind: string; error?: { code: string; message: string } }
  }
}

interface SessionView {
  seq: number
  eventAt(seq: unknown): SessionEventView | undefined
}

function readNewEvents(session: SessionView, cursor: number): { text: string; turnError: string | null } {
  let text = ''
  let turnError: string | null = null
  for (let seq = cursor; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (!event) continue
    if (event.type === 'assistant/message' && event.data?.message) {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end' && event.data?.reason && event.data.reason.kind !== 'completed') {
      turnError = event.data.reason.error
        ? `${event.data.reason.error.code}: ${event.data.reason.error.message}`
        : event.data.reason.kind
    }
  }
  return { text, turnError }
}

async function run(ctx: Context, config: { courseId: string; maxTurns: number }, io: RunnerIo): Promise<void> {
  await (ctx.get('loader' as never) as { await(): Promise<void> } | undefined)?.await()
  const agentDefaultModel = ctx.get('agentDefaultModel')
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const courseState = ctx.get('courseState')
  if (!agentDefaultModel || !agents || !sessions || !courseState) {
    throw new Error('tutor-interview-runner: 核心服务未就绪')
  }
  const selection = agentDefaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: brandString(`session-${randomUUID()}`) as never,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx: Context) => {
      installModelSelection(agentCtx as never, { current: selection, assembled: undefined })
    },
  })
  await agent.whenIdle()

  const store = courseState.store
  const lineQueue: string[] = []
  let lineWaiter: ((line: string | null) => void) | null = null
  let stdinClosed = false
  const rl = readline.createInterface({ input: io.stdin, terminal: false })
  rl.on('line', (line: string) => {
    if (lineWaiter) {
      const resolveLine = lineWaiter
      lineWaiter = null
      resolveLine(line)
    } else {
      lineQueue.push(line)
    }
  })
  rl.on('close', () => {
    stdinClosed = true
    if (lineWaiter) {
      const resolveLine = lineWaiter
      lineWaiter = null
      resolveLine(null)
    }
  })
  const readAnswer = () =>
    new Promise<string | null>((resolve) => {
      if (lineQueue.length > 0) return resolve(lineQueue.shift()!)
      if (stdinClosed) return resolve(null)
      lineWaiter = resolve
    })
  let cursor = agent.session.seq
  let turns = 0

  const finish = async (code: number) => {
    await sessions.flush(agent.session)
    io.exit(code)
  }

  const send = (text: string) => {
    cursor = agent.session.seq
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
    )
  }

  send(START_MESSAGE)
  while (true) {
    await agent.whenIdle()
    const { text: reply, turnError } = readNewEvents(agent.session as unknown as SessionView, cursor)
    if (turnError) {
      io.stderr.write(`tutor: 访谈中断：${turnError}\n`)
      await finish(1)
      return
    }
    io.stdout.write(`${reply}${REPLY_PROMPT}`)

    const profile = parseProfile(reply)
    if (profile) {
      store.create(config.courseId, profile)
      io.stdout.write(`\n课程 "${config.courseId}" 已创建，档案位于 ${store.root}/${config.courseId}/profile.yaml\n`)
      await finish(0)
      return
    }

    if (extractProfileJson(reply) !== null) {
      send(`你输出的 JSON 档案校验失败：${profileValidationError(reply)}。请修正后重新输出完整 JSON 块。`)
      continue
    }

    turns += 1
    if (turns > config.maxTurns) {
      io.stderr.write('tutor: 超过最大访谈轮数\n')
      await finish(1)
      return
    }

    const answer = await readAnswer()
    if (!answer || !answer.trim()) {
      io.stderr.write('tutor: 未收到学员回答，访谈结束\n')
      await finish(1)
      return
    }
    send(answer.trim())
  }
}

export function apply(ctx: Context, config: { courseId: string; maxTurns: number }): void {
  const exit = ctx.get('appExit') as unknown as ((code: number) => void) | undefined
  if (!exit) throw new Error('tutor-interview-runner: 需要 ctx.appExit（仅支持经 dsh 启动）')
  const io: RunnerIo = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, exit }
  run(ctx, config, io).catch((error) => {
    io.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}

export { name, inject, Config }
