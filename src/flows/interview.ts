import { extractProfileJson, parseProfile, preserveLearnerRequests, profileValidationError } from '../core/interview.ts'
import { recordChatTotal } from './cost-ledger.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'

const START_MESSAGE = '（学员已就座，请开始需求访谈）'
// 模型连续输出 schema 不合法的档案时最多要求它修正几次；不设上限会让坏模型无限烧调用。
export const MAX_PROFILE_REPAIRS = 3

export async function runInterview(deps: FlowDeps, config: { courseId: string; maxTurns?: number }): Promise<void> {
  const maxTurns = config.maxTurns ?? 24
  const { store, io } = deps
  const chat = await deps.createChat({ retryOnLength: false })

  let reply = await chat.ask(START_MESSAGE)
  let turns = 0
  let profileRepairs = 0
  const requests: string[] = []
  while (true) {
    io.out(`${reply}\n> `)

    const profile = parseProfile(reply)
    if (profile) {
      store.create(config.courseId, preserveLearnerRequests(profile, requests))
      io.out(`\n课程 "${config.courseId}" 已创建，档案位于 ${store.root}/${config.courseId}/profile.yaml\n`)
      await chat.flush()
      recordChatTotal(deps.costs, chat, 'interview')
      io.closeInput()
      throw new FlowExit(0)
    }

    if (extractProfileJson(reply) !== null) {
      profileRepairs += 1
      if (profileRepairs > MAX_PROFILE_REPAIRS) {
        io.err(`tutor: 模型连续 ${MAX_PROFILE_REPAIRS + 1} 次输出无效档案，已中止；最后错误：${profileValidationError(reply) ?? '未知'}\n`)
        await chat.flush()
        recordChatTotal(deps.costs, chat, 'interview')
        io.closeInput()
        throw new FlowExit(1)
      }
      reply = await chat.ask(`你输出的 JSON 档案校验失败：${profileValidationError(reply)}。请修正后重新输出完整 JSON 块。`)
      continue
    }

    turns += 1
    if (turns > maxTurns) {
      io.err('tutor: 超过最大访谈轮数\n')
      await chat.flush()
      recordChatTotal(deps.costs, chat, 'interview')
      io.closeInput()
      throw new FlowExit(1)
    }

    // 空行不等于「学员没答」：可能是多按了一次回车，或共享流程桥上别的页面发来的空 /flow/input。
    // 重新提示即可，别把访谈判死。只有输入真正 EOF（answer===null，如 CLI 下 Ctrl-D）才收尾退出。
    let answer = await io.readLine()
    while (answer !== null && !answer.trim()) {
      io.out('（还没收到回答，输入内容后回车）\n> ')
      answer = await io.readLine()
    }
    if (answer === null) {
      io.err('tutor: 输入已结束，访谈中止\n')
      await chat.flush()
      recordChatTotal(deps.costs, chat, 'interview')
      io.closeInput()
      throw new FlowExit(1)
    }
    requests.push(answer.trim())
    profileRepairs = 0
    reply = await chat.ask(answer.trim())
  }
}
