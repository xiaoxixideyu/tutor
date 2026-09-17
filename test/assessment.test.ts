import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AssessmentEngine, judgeAnswer } from '../src/core/assessment.ts'
import { topoOrder, validateBank } from '../src/core/knowledge.ts'
import type { AssessmentState, KnowledgeMap, Question, QuestionBank } from '../src/core/schema.ts'

function choice(id: string, difficulty: 1 | 2 | 3, answer = 'B'): Question {
  return { id, difficulty, type: 'choice', question: `Q ${id}`, choices: ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁'], answer }
}

function bankWith(nodes: string[]): QuestionBank {
  const bank: QuestionBank = {}
  for (const node of nodes) {
    bank[node] = [choice(`${node}-d1`, 1), choice(`${node}-d2`, 2), choice(`${node}-d3`, 3)]
  }
  return bank
}

function runNode(engine: AssessmentEngine, answers: string[]): void {
  engine.advanceNode()
  while (engine.nextQuestion()) {
    engine.submitAnswer(answers.shift() ?? '')
  }
  engine.finalizeNode()
}

describe('judgeAnswer', () => {
  const q: Question = choice('x-d2', 2)

  it('选择题：字母大小写不敏感', () => {
    assert.equal(judgeAnswer(q, 'b'), true)
    assert.equal(judgeAnswer(q, 'B'), true)
    assert.equal(judgeAnswer(q, 'A'), false)
  })

  it('选择题：可直接回答选项全文', () => {
    assert.equal(judgeAnswer(q, 'B. 乙'), true)
    assert.equal(judgeAnswer(q, '乙'), true)
  })

  it('简答题：归一化后匹配 answer/accept', () => {
    const short: Question = {
      id: 's1',
      difficulty: 1,
      type: 'short',
      question: '并发安全的队列？',
      answer: 'channel',
      accept: ['chan', '通道'],
    }
    assert.equal(judgeAnswer(short, ' Channel '), true)
    assert.equal(judgeAnswer(short, '通道'), true)
    assert.equal(judgeAnswer(short, 'mutex'), false)
  })
})

describe('AssessmentEngine 自适应路径', () => {
  it('d2 对 → d3 对：提前停止，满分', () => {
    const engine = new AssessmentEngine(bankWith(['a']), AssessmentEngine.create(['a']))
    runNode(engine, ['B', 'B'])
    assert.equal(engine.state.scores.a, 1)
    assert.equal(engine.state.asked.length, 2)
  })

  it('d2 对 → d3 错 → d1 对：0.5', () => {
    const engine = new AssessmentEngine(bankWith(['a']), AssessmentEngine.create(['a']))
    runNode(engine, ['B', 'A', 'B'])
    assert.equal(engine.state.scores.a, 0.5)
    assert.equal(engine.state.asked.length, 3)
  })

  it('d2 错 → d1 对：收窄后停止，0.33', () => {
    const engine = new AssessmentEngine(bankWith(['a']), AssessmentEngine.create(['a']))
    runNode(engine, ['A', 'B'])
    assert.equal(engine.state.scores.a, 0.33)
    assert.equal(engine.state.asked.length, 2)
  })

  it('d2 错 → d1 错：提前停止，0', () => {
    const engine = new AssessmentEngine(bankWith(['a']), AssessmentEngine.create(['a']))
    runNode(engine, ['A', 'A'])
    assert.equal(engine.state.scores.a, 0)
    assert.equal(engine.state.asked.length, 2)
  })
})

describe('AssessmentEngine 断点恢复与产出', () => {
  const nodes = ['interfaces', 'goroutines', 'channels']

  function persistedState(engine: AssessmentEngine): AssessmentState {
    return JSON.parse(JSON.stringify(engine.state)) as AssessmentState
  }

  it('恢复后不重复已答节点，完成全部节点', () => {
    const bank = bankWith(nodes)
    const first = new AssessmentEngine(bank, AssessmentEngine.create(nodes))
    runNode(first, ['B', 'B'])
    const restored = new AssessmentEngine(bank, persistedState(first))
    runNode(restored, ['A', 'B'])
    runNode(restored, ['B', 'B'])
    assert.ok(restored.isFinished())
    assert.equal(Object.keys(restored.state.scores).length, 3)
  })

  it('有基础 vs 零基础画像可区分', () => {
    const bank = bankWith(nodes)
    const experienced = new AssessmentEngine(bank, AssessmentEngine.create(nodes))
    for (let i = 0; i < nodes.length; i++) runNode(experienced, i === 0 ? ['B', 'B'] : ['B', 'B'])
    const novice = new AssessmentEngine(bank, AssessmentEngine.create(nodes))
    for (let i = 0; i < nodes.length; i++) runNode(novice, ['A', 'A'])

    const strongProfile = experienced.buildLearnerProfile('2026-09-17')
    const weakProfile = novice.buildLearnerProfile('2026-09-17')
    const strongAvg = Object.values(strongProfile.nodes).reduce((s, n) => s + n.score, 0) / nodes.length
    const weakAvg = Object.values(weakProfile.nodes).reduce((s, n) => s + n.score, 0) / nodes.length
    assert.ok(strongAvg > weakAvg + 0.3, `strong=${strongAvg} weak=${weakAvg}`)
    assert.match(strongProfile.summary ?? '', /较强/)
    assert.match(weakProfile.summary ?? '', /薄弱/)

    const strongMastery = experienced.buildMastery()
    const weakMastery = novice.buildMastery()
    assert.equal(strongMastery.interfaces.status, 'mastered')
    assert.equal(weakMastery.goroutines.status, 'weak')
  })

  it('buildMastery：未入题库的知识点为 unknown', () => {
    const bank = bankWith(['a'])
    bank.a.push(choice('a-extra', 2, 'C'))
    const engine = new AssessmentEngine(bank, AssessmentEngine.create(['a', 'ghost']))
    runNode(engine, ['B', 'B'])
    const mastery = engine.buildMastery()
    assert.equal(mastery.a.status, 'mastered')
    assert.equal(mastery.ghost.status, 'unknown')
  })
})

describe('topoOrder', () => {
  it('前置先行，无关节点保持原序', () => {
    const map: KnowledgeMap = {
      verified: false,
      nodes: [
        { id: 'channels', title: 'channels' },
        { id: 'goroutines', title: 'goroutines' },
        { id: 'tools', title: 'tools' },
      ],
      edges: [['channels', 'goroutines']],
      resources: [],
    }
    assert.deepEqual(topoOrder(map), ['goroutines', 'channels', 'tools'])
  })

  it('环与悬空边不致崩溃，全部节点保留', () => {
    const map: KnowledgeMap = {
      verified: false,
      nodes: [
        { id: 'a', title: 'a' },
        { id: 'b', title: 'b' },
      ],
      edges: [['a', 'b'], ['b', 'a'], ['a', 'ghost']],
      resources: [],
    }
    const order = topoOrder(map)
    assert.equal(order.length, 2)
  })
})

describe('validateBank', () => {
  it('结构不合规返回错误信息', () => {
    const bank = bankWith(['a'])
    bank.a = bank.a.slice(0, 2)
    assert.match(validateBank(bank, ['a']) ?? '', /数量/)
    const badChoice = bankWith(['a'])
    badChoice.a[0].answer = 'E'
    assert.match(validateBank(badChoice, ['a']) ?? '', /A-D/)
    const okBank = bankWith(['a'])
    assert.equal(validateBank(okBank, ['a']), null)
  })
})
