// 在独立进程中运行正式流程，模型边界用确定性响应替代；测试展示/落盘的位置。
import fs from 'node:fs'
import path from 'node:path'
import { CourseStore } from '../../src/core/store.ts'
import { requiredAssertions, type ContentInput } from '../../src/core/content-quality.ts'
import { createCliIO, FlowExit } from '../../src/flows/io.ts'
import type { FlowDeps } from '../../src/flows/deps.ts'
import { today } from '../../src/flows/deps.ts'
import { runExam } from '../../src/flows/exam.ts'
import { runPracticeGen } from '../../src/flows/practice-gen.ts'
import { runLearn } from '../../src/flows/learn.ts'
import { runAssess } from '../../src/flows/assess.ts'
import { runResearch } from '../../src/flows/research.ts'
import type { AgentChat } from '../../src/runtime/chat.ts'
import type { UsageSample } from '../../src/core/cost.ts'

const [mode, root, behavior] = process.argv.slice(2)
const store = new CourseStore(root)
const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
let serial = 0

interface FakeEvent { seq: number; type: string; data?: unknown }

class FakeChat implements AgentChat {
  readonly sessionId = `fake-${++serial}`
  readonly model = 'test'
  private readonly events: FakeEvent[] = []
  private readonly resumed: boolean
  private generation = 0
  private grading = false
  private assessmentNode = ''

  constructor(resumed: boolean) {
    this.resumed = resumed
    if (resumed) this.events.push({ seq: 0, type: 'assistant/message', data: {
      message: { content: [{ type: 'text', text: 'REJECT_CANDIDATE 原始历史中未获批准的最后回复' }] } } })
  }

  private replyFor(prompt: string): string {
    let parsed: Record<string, any> | undefined
    try { parsed = JSON.parse(prompt) } catch { /* 讲授与备课提示词不是 JSON */ }
    let reply: string
    if (parsed?.content) {
      const input = parsed.content as ContentInput
      reply = json({ units: input.units.map(unit => ({ id: unit.id, scope: JSON.stringify(unit.content).includes('REJECT_CANDIDATE') ? 'fail' : 'pass',
        correctness: 'pass', explanation: '固定审查结果', arithmetic: [],
        assertions: requiredAssertions(input, unit).map(a => ({ id: a.id, verdict: 'pass', explanation: '固定断言核查' })) })) })
    } else if (parsed?.claims) {
      reply = json({ claims: parsed.claims.map((q: { id: string }) => ({ id: q.id, verdict: 'pass', explanation: '固定断言核查', arithmetic: [] })) })
    } else if (parsed?.questions) {
      reply = json({ solutions: parsed.questions.map((q: { id: string }) => ({ id: q.id, status: 'solved', answer: 'A', reasoning: '固定解答', arithmetic: [] })) })
    } else if (mode === 'exam' && (this.grading || prompt.startsWith('任务：判分以下主观题作答。'))) {
      this.grading = true
      reply = json({ gradings: behavior === 'grading-success' ? [{ questionId: 'q4', score: 1, note: '解释正确' }] : [] })
    } else if (mode === 'learn' && prompt.startsWith('任务：为课程《') && prompt.includes('备课。')) {
      fs.appendFileSync(path.join(root, 'prep-count.txt'), 'prepared\n')
      const question = { question: '1+1=?', choices: ['2', '3', '4', '5'], answer: 'A' }
      reply = json({ node: 'topic', title: '加法', hook: '开始', structure: ['加法'], example: '1+1=2',
        practice: [question], quiz: [question, { ...question, question: '1+1 的结果？' }] })
    } else if (mode === 'assess') {
      this.assessmentNode = prompt.match(/需覆盖以下知识点：\n([a-z0-9-]+)（/)?.[1] ?? this.assessmentNode
      if (!this.assessmentNode) throw new Error('测试未收到单知识点出题任务')
      fs.appendFileSync(path.join(root, 'bank-count.txt'), `${this.assessmentNode}\n`)
      const approved = behavior !== 'fail' && !(behavior === 'assessment-second-fail' && this.assessmentNode === 'later')
      const text = approved ? 'APPROVED_CONTENT' : 'REJECT_CANDIDATE'
      reply = json({ [this.assessmentNode]: [1, 2, 3].map(difficulty => ({ id: `${this.assessmentNode}-d${difficulty}`,
        difficulty, type: 'choice', question: `${text} ${this.assessmentNode} d${difficulty}：1+1=?`, choices: ['2', '3', '4', '5'], answer: 'A' })) })
    } else {
      if (mode === 'research') fs.appendFileSync(path.join(root, 'research-generation.txt'), 'generated\n')
      this.generation++
      const approved = behavior !== 'fail' && this.generation === (mode === 'learn' ? 3 : 4)
      const text = approved ? 'APPROVED_CONTENT' : `REJECT_CANDIDATE-${this.generation}`
      if (mode === 'exam') reply = json({ milestone: 'm1', questions: Array.from({ length: 4 }, (_, i) => ({
        id: `q${i}`, node: 'topic', type: 'objective', question: `${text} 第${i}题`, choices: ['2', '3', '4', '5'], answer: 'A', points: 1,
      })) })
      else if (mode === 'practice-gen') reply = json({ edits: [{ path: '/0/prompt', before: 'REJECT_CANDIDATE 旧内容', after: text }] })
      else reply = text
    }
    return reply
  }

  async ask(prompt: string): Promise<string> {
    const reply = this.replyFor(prompt)
    this.events.push({ seq: this.events.length, type: 'user/message', data: { message: { content: [{ type: 'text', text: prompt }] } } })
    this.events.push({ seq: this.events.length, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } })
    return reply
  }

  lastTurnUsage(): UsageSample { return { inputTokens: 0, outputTokens: 0 } }
  totalUsage(): UsageSample { return { inputTokens: 0, outputTokens: 0 } }
  lastReply(): string {
    let text = ''
    for (const event of this.events) {
      if (event.type !== 'assistant/message') continue
      const message = (event.data as { message?: { content?: { type: string; text?: string }[] } } | undefined)?.message
      const joined = (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (joined !== '') text = joined
    }
    return text
  }
  lastReplySeq(): number | null {
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index]
      const message = (event.data as { message?: { content?: { type: string; text?: string }[] } } | undefined)?.message
      if (event.type === 'assistant/message' && (message?.content ?? []).some(block => block.type === 'text' && block.text)) return event.seq
    }
    return null
  }
  async flush(): Promise<void> {}
}

const io = createCliIO()
const deps: FlowDeps = {
  store, io, status: () => {}, env: { ...process.env, TUTOR_COURSES_ROOT: root }, workspace: root, today,
  createChat: (async (options?: { resumeSessionId?: string }) => new FakeChat(Boolean(options?.resumeSessionId))) as FlowDeps['createChat'],
}

async function main(): Promise<number> {
  try {
    if (mode === 'exam') await runExam(deps, { courseId: 'alpha', ...(behavior.startsWith('grading-') ? {} : { milestoneId: 'm1' }) })
    else if (mode === 'practice-gen') await runPracticeGen(deps, { courseId: 'alpha', batchSize: 1, nodeId: 'topic' })
    else if (mode === 'learn') await runLearn(deps, { courseId: 'alpha' })
    else if (mode === 'assess') await runAssess(deps, { courseId: 'alpha' })
    else if (mode === 'research') await runResearch(deps, { courseId: 'alpha', ...(behavior === 'single-node' ? { nodeId: 'topic' } : {}) })
    else throw new Error('未知测试 runner')
    return 0
  } catch (error) {
    if (error instanceof FlowExit) return error.code
    process.stderr.write(`tutor: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

process.exit(await main())
