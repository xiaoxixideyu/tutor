import { AssessmentEngine, formatChoice } from '../core/assessment.ts'
import { topoOrder, validateBank } from '../core/knowledge.ts'
import { KnowledgeMapSchema, QuestionBankSchema, type AssessmentState, type KnowledgeMap, type Profile, type Question, type QuestionBank } from '../core/schema.ts'
import { parseJsonBlock, trySchema } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'
import { bankContent, mapContent } from '../core/content-quality.ts'
import { createContentGate, generateApproved } from './content-gate.ts'
import { profileScope } from '../core/interview.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'
import { today } from './deps.ts'

function mapPrompt(profile: Profile): string {
  return [
    '任务 1/2：生成知识地图。',
    '',
    '学员档案：',
    `- 学习目的与原始范围：${profileScope(profile)}`,
    `- 现有基础：${profile.background || '未填写'}`,
    `- 讲解偏好：${profile.style || '未填写'}`,
    `- 每日投入：${profile.daily_minutes ? `${profile.daily_minutes} 分钟` : '未填写'}`,
    '',
    '请输出知识地图 JSON（```json 代码块）：',
    '- verified: false（未联网验证）',
    '- nodes: 知识点对象 {id, title, summary}，id 用小写英文连字符（如 goroutines、channels），按学习进阶排列；每节点为一节课，数量遵守学员目标范围与明确课时，没有最低数量，不加入已排除或已会的内容',
    '- edges: 依赖对数组，格式 [知识点, 前置知识点]',
    '- resources: 空数组',
  ].join('\n')
}

function bankPrompt(map: KnowledgeMap, profile: Profile): string {
  const nodes = topoOrder(map)
    .map((id) => {
      const node = map.nodes.find((n) => n.id === id)
      return `${id}（${node?.title ?? id}）`
    })
    .join('、')
  return [
    '任务 2/2：生成摸底题库。需覆盖以下知识点：',
    nodes,
    `学习目的与范围：${profileScope(profile)}`,
    `现有基础：${profile.background || '未填写'}`,
    '题目严格遵守上述范围与排除项，不借综合题引入未要求的内容。',
    '',
    '对每个知识点出恰好 3 道题，难度 1（基础概念）/ 2（简单应用）/ 3（综合分析）各一道，全部为四选一单选题。',
    '',
    '干扰项质量（关键，直接决定摸底能否区分「真会」与「蒙对」）：',
    '- 三个错误项都要“看起来像对的”：是本知识点里真实存在的概念、常见误区，或与正解只差一处关键点的近似说法；不能放明显无关或荒谬的选项（反例：问「幻觉」却把干扰项写成「梯度爆炸」「灾难性遗忘」这种一眼可排除的词）。',
    '- 四个选项同一类型、同一粒度、长度相近，不靠字数长短暴露正解；不用「以上皆是/皆非」「完全不/绝不」这类可直接排除的表述。',
    '- 正解在 A/B/C/D 间尽量均匀分布，不要集中在某个字母。',
    '',
    '输出 JSON（```json 代码块）：以知识点 id 为键，值为题目数组，每题字段：',
    '- id: 唯一题号（如 "goroutines-d2"）',
    '- difficulty: 1 或 2 或 3',
    '- type: 固定为 "choice"',
    '- question: 题干（中文，自然表述，不出现编号，不泄露答案）',
    '- choices: 恰好 4 个选项字符串（不带 A./B. 前缀，数组顺序即 A、B、C、D）',
    '- answer: 正确选项字母（A-D）',
    '所有知识点都必须出现在 JSON 中。',
  ].join('\n')
}

function answerText(q: Question): string {
  if (q.type !== 'choice') return q.answer
  const letter = q.answer.trim().toUpperCase()
  const idx = 'ABCD'.indexOf(letter)
  const text = idx >= 0 ? q.choices?.[idx] : undefined
  return text ? formatChoice(text, idx) : letter
}

async function runQuiz(deps: FlowDeps, courseId: string, engine: AssessmentEngine, map: KnowledgeMap,
  prepareNode: (node: string) => Promise<void>): Promise<void> {
  const { store, io } = deps
  const titles = new Map(map.nodes.map((n) => [n.id, n.title]))
  for (const node of engine.state.node_order) {
    if (node in engine.state.scores) continue
    // 缺题不能被当作已完成跳过。先准备当前节点，首题无需等待整门课出题。
    await prepareNode(node)
    engine.state.current_node = node
    store.write(courseId, 'assessment', engine.state)
    io.out(`\n【知识点：${node} · ${titles.get(node) ?? ''}】\n`)
    while (true) {
      const current = engine.nextQuestion()
      if (!current) break
      const q = current.question
      io.out(`\n（难度 ${q.difficulty}，第 ${current.askedCount + 1} 题）${q.question}\n`)
      if (q.type === 'choice') {
        // 带定位字母（A/B/C…，与题库里 answer 的字母语义一致）：CLI 端看得清，Web 端才能把这些行解析成可点选项。
        for (const [i, choice] of (q.choices ?? []).entries()) io.out(`  ${formatChoice(choice, i)}\n`)
        io.out('（回答选项字母，如 A）\n')
      }
      io.out('\n> ') // 轮到学员作答：前端靠这个提示符收起忙态、把选项渲染成可点选项
      // 空行不等于「没作答」：可能是多按了一次回车，或共享的流程桥上别的页面（如 practice 的
      // 「运行测试」发空行）把一个空 /flow/input 打到了当前 assess 子进程。这种情况重新提示即可，
      // 绝不能把整轮摸底判死。只有输入真正 EOF（answer===null，如 CLI 下 Ctrl-D）才存档退出。
      let answer = await io.readLine()
      while (answer !== null && !answer.trim()) {
        io.out('（请输入选项字母，如 A；要中断请按 Ctrl-C）\n> ')
        answer = await io.readLine()
      }
      if (answer === null) {
        store.write(courseId, 'assessment', engine.state)
        throw new Error('未收到作答——进度已保存，重新运行 assess 即可继续')
      }
      const { correct } = engine.submitAnswer(answer)
      io.out(correct ? '✓ 正确\n' : `✗ 错误（正确答案：${answerText(q)}）\n`)
      store.write(courseId, 'assessment', engine.state)
    }
    engine.finalizeNode()
    store.write(courseId, 'assessment', engine.state)
  }
}

export async function runAssess(deps: FlowDeps, config: { courseId: string }): Promise<void> {
  const { store, io } = deps
  if (!store.exists(config.courseId)) {
    io.err(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    io.closeInput()
    throw new FlowExit(1)
  }
  const profile = store.read(config.courseId, 'profile') as Profile
  const gate = createContentGate(deps, config.courseId)
  if (!store.has(config.courseId, 'knowledge-map')) {
    const chat = await deps.createChat()
    io.out('正在生成知识地图（可稍后用 research 联网升级为带来源版本）…\n')
    const mapValue = await generateApproved<KnowledgeMap>(chat, mapPrompt(profile), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      return trySchema(KnowledgeMapSchema, data.value)
    }, gate, value => mapContent(value, profile))
    store.write(config.courseId, 'knowledge-map', mapValue)
    await chat.flush()
    io.out('知识地图生成开销：')
    printSessionTotal(chat, deps)
  }
  const map = store.read(config.courseId, 'knowledge-map') as KnowledgeMap
  await gate.require(mapContent(map, profile))
  io.out(`知识地图就绪：${map.nodes.length} 个知识点。\n`)

  // 按作答进度准备题目；只有当前节点通过准入后才提问，保留已完成的题库和作答。
  const bank: QuestionBank = store.has(config.courseId, 'question-bank')
    ? (store.read(config.courseId, 'question-bank') as QuestionBank) : {}
  const prepareNode = async (nodeId: string): Promise<void> => {
    const node = map.nodes.find(item => item.id === nodeId)
    if (!node) throw new Error(`摸底进度中的知识点 "${nodeId}" 不在当前课程地图中，原作答已保留`)
    if (!validateBank(bank, [node.id]) && (await gate.review(bankContent(bank, node.id, profile, map))).approved) return
    io.out(`正在生成摸底题库：${node.id}（每点 3 题，完成即保存）…\n`)
    const bankChat = await deps.createChat()
    const nodeMap = { ...map, nodes: [node], edges: [] }
    const bankValue = await generateApproved<QuestionBank>(bankChat, bankPrompt(nodeMap, profile), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      const schemaResult = trySchema(QuestionBankSchema, data.value)
      if (!schemaResult.ok) return schemaResult
      const bankError = validateBank(schemaResult.value as QuestionBank, [node.id])
      if (bankError) return { ok: false as const, error: bankError }
      return schemaResult
    }, gate, value => bankContent(value, node.id, profile, map))
    bank[node.id] = (bankValue as QuestionBank)[node.id]
    store.write(config.courseId, 'question-bank', bank)
    await bankChat.flush()
    io.out('该知识点出题开销：')
    printSessionTotal(bankChat, deps)
  }

  const resumed = store.has(config.courseId, 'assessment')
  const state = resumed ? (store.read(config.courseId, 'assessment') as AssessmentState) : AssessmentEngine.create(topoOrder(map))
  const engine = new AssessmentEngine(bank, state)
  io.out(resumed ? '检测到未完成的摸底，从上次进度继续。\n' : '摸底测评开始（每知识点最多 3 题，答对加深、答错收窄；随时 Ctrl-C 中断，进度已保存）。\n')
  await runQuiz(deps, config.courseId, engine, map, prepareNode)

  const learner = engine.buildLearnerProfile(today())
  store.write(config.courseId, 'learner-profile', learner)
  store.write(config.courseId, 'mastery', engine.buildMastery())
  store.remove(config.courseId, 'assessment')
  io.out(`\n摸底完成。${learner.summary}\n能力画像已写入 ${store.root}/${config.courseId}/learner-profile.yaml\n`)
  io.closeInput()
  throw new FlowExit(0)
}
