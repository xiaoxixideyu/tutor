// 在独立进程中运行正式 runner，模型边界用确定性响应替代；测试展示/落盘的位置。
import type { Context } from '@deepseek-ai/cordis'
import fs from 'node:fs'
import path from 'node:path'
import { CourseStore } from '../../src/core/store.ts'
import { requiredAssertions, type ContentInput } from '../../src/core/content-quality.ts'
import { apply as exam } from '../../src/plugin/exam-runner.ts'
import { apply as practice } from '../../src/plugin/practice-gen-runner.ts'
import { apply as learn } from '../../src/plugin/learn-runner.ts'

const [mode, root, behavior] = process.argv.slice(2)
const store = new CourseStore(root)
const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
let serial = 0
function agent(resumed: boolean) {
  const events: { type: string; data: unknown }[] = resumed ? [{ type: 'assistant/message', data: {
    message: { content: [{ type: 'text', text: 'REJECT_CANDIDATE 原始历史中未获批准的最后回复' }] } } }] : []
  let generation = 0
  let grading = false
  return {
    session: { id: `fake-${++serial}`, get seq() { return events.length }, eventAt: (seq: number) => events[seq] },
    whenIdle: async () => {},
    followup: (message: { content: { text?: string }[] }) => {
      const prompt = message.content.map(c => c.text ?? '').join('')
      let parsed: Record<string, any> | undefined
      try { parsed = JSON.parse(prompt) } catch {}
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
      } else if (mode === 'exam' && (grading || prompt.startsWith('任务：判分以下主观题作答。'))) {
        grading = true
        reply = json({ gradings: behavior === 'grading-success' ? [{ questionId: 'q4', score: 1, note: '解释正确' }] : [] })
      } else if (mode === 'learn' && prompt.startsWith('任务：为课程《') && prompt.includes('备课。')) {
        fs.appendFileSync(path.join(root, 'prep-count.txt'), 'prepared\n')
        const question = { question: '1+1=?', choices: ['2', '3', '4', '5'], answer: 'A' }
        reply = json({ node: 'topic', title: '加法', hook: '开始', structure: ['加法'], example: '1+1=2',
          practice: [question], quiz: [question, { ...question, question: '1+1 的结果？' }] })
      } else {
        generation++
        const approved = behavior !== 'fail' && generation === (mode === 'learn' ? 3 : 4)
        const text = approved ? 'APPROVED_CONTENT' : `REJECT_CANDIDATE-${generation}`
        if (mode === 'exam') reply = json({ milestone: 'm1', questions: Array.from({ length: 4 }, (_, i) => ({
          id: `q${i}`, node: 'topic', type: 'objective', question: `${text} 第${i}题`, choices: ['2', '3', '4', '5'], answer: 'A', points: 1,
        })) })
        else if (mode === 'practice-gen') reply = json({ edits: [{ path: '/0/prompt', before: 'REJECT_CANDIDATE 旧内容', after: text }] })
        else reply = text
      }
      events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    },
  }
}
const services: Record<string, unknown> = {
  courseState: { store }, appExit: (code: number) => process.exit(code),
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  agents: { create: async () => ({ agent: agent(false) }), resume: async () => ({ agent: agent(true) }) },
  sessions: { flush: async () => {} },
}
const ctx = { get: (name: string) => services[name] } as unknown as Context
if (mode === 'exam') exam(ctx, { courseId: 'alpha', milestoneId: behavior.startsWith('grading-') ? '' : 'm1' })
else if (mode === 'practice-gen') practice(ctx, { courseId: 'alpha', batchSize: 1, nodeId: 'topic' })
else if (mode === 'learn') learn(ctx, { courseId: 'alpha' })
else throw new Error('未知测试 runner')
