import { AssessmentEngine, formatChoice } from '../core/assessment.ts'
import { assertKnowledgeMap, topoOrder, validateBank } from '../core/knowledge.ts'
import { KnowledgeMapSchema, QuestionBankSchema, type AssessmentState, type KnowledgeMap, type Profile, type Question, type QuestionBank } from '../core/schema.ts'
import { parseJsonBlock, trySchema } from './generation.ts'
import { printSessionTotal } from './cost-line.ts'
import { recordChatTotal } from './cost-ledger.ts'
import { bankContent, mapContent } from '../core/content-quality.ts'
import { createContentGate, generateApproved } from './content-gate.ts'
import { profileScope } from '../core/interview.ts'
import { capKnowledgeMap, mapNodeBudget, type MapBudget } from './map-budget.ts'
import type { FlowDeps } from './deps.ts'
import { FlowExit } from './io.ts'

export function mapPrompt(profile: Profile, budget: MapBudget): string {
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
    `- nodes: 知识点对象 {id, title, summary}，id 用小写英文连字符（如 goroutines、channels），按学习进阶排列；每节点为一节课；节点总数控制在 ${budget.min}–${budget.max} 个之间，覆盖目标范围即可，不要为凑数拆分；每个 summary 不超过 40 字`,
    '- edges: 依赖对数组，格式 [知识点, 前置知识点]',
    '- resources: 空数组',
    '- 除该 JSON 外不要输出任何内容：不要写解释、前言、推理过程或总结',
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

export async function runAssess(deps: FlowDeps, config: { courseId: string; reset?: boolean }): Promise<void> {
  const { store, io } = deps
  if (!store.exists(config.courseId)) {
    io.err(`tutor: 课程 "${config.courseId}" 不存在，请先运行 npm run agent -- new ${config.courseId}\n`)
    io.closeInput()
    throw new FlowExit(1)
  }
  if (config.reset) {
    if (!store.has(config.courseId, 'assessment')) {
      io.out('没有未完成的摸底进度。\n')
    } else {
      const archive = store.archive(config.courseId, ['assessment'], { label: 'assessment-reset', removeKinds: ['assessment'] })
      io.out(`已清理未完成的摸底进度（原文件归档到 ${archive}）。\n`)
    }
    io.closeInput()
    throw new FlowExit(0)
  }
  const profile = store.read(config.courseId, 'profile') as Profile
  const gate = createContentGate(deps, config.courseId)
  if (!store.has(config.courseId, 'knowledge-map')) {
    const chat = await deps.createChat({ retryOnLength: false })
    const budget = mapNodeBudget(profile)
    io.out('正在生成知识地图（可稍后用 research 联网升级为带来源版本）…\n')
    const mapValue = await generateApproved<KnowledgeMap>(chat, mapPrompt(profile, budget), (text) => {
      const data = parseJsonBlock(text)
      if (!data.ok) return data
      const schemaResult = trySchema(KnowledgeMapSchema, data.value)
      if (!schemaResult.ok) return schemaResult
      // 超体量的地图先按学习进阶截断，再做自洽校验：审查与落盘看到的是同一份最终地图。
      const capped = capKnowledgeMap(schemaResult.value as KnowledgeMap, budget)
      if (capped.truncated > 0) io.out(`知识地图超出体量上限（${budget.max} 个知识点），已保留前 ${budget.max} 个。\n`)
      try {
        assertKnowledgeMap(capped.map)
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true as const, value: capped.map }
    }, gate, value => mapContent(value, profile))
    store.write(config.courseId, 'knowledge-map', mapValue)
    await chat.flush()
    recordChatTotal(deps.costs, chat, 'map')
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
    const bankChat = await deps.createChat({ retryOnLength: false })
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
    recordChatTotal(deps.costs, bankChat, 'bank')
    io.out('该知识点出题开销：')
    printSessionTotal(bankChat, deps)
  }

  const resumed = store.has(config.courseId, 'assessment')
  const state = resumed ? (store.read(config.courseId, 'assessment') as AssessmentState) : AssessmentEngine.create(topoOrder(map))
  const engine = new AssessmentEngine(bank, state)
  io.out(resumed ? '检测到未完成的摸底，从上次进度继续。\n' : '摸底测评开始（每知识点最多 3 题，答对加深、答错收窄；随时 Ctrl-C 中断，进度已保存）。\n')
  await runQuiz(deps, config.courseId, engine, map, prepareNode)

  const learner = engine.buildLearnerProfile(deps.today())
  // 摸底成功后才归档旧状态：中途失败/中断保留原掌握度、计划与断点，不提前清空。
  // 旧计划/实践/考试与新掌握度不再匹配，归档后要求重新规划。
  const hasPriorState = store.has(config.courseId, 'mastery') || store.has(config.courseId, 'learner-profile')
    || store.has(config.courseId, 'plan') || store.has(config.courseId, 'lesson') || store.has(config.courseId, 'practice-state')
  let planArchive: string | undefined
  if (hasPriorState) {
    planArchive = store.archive(config.courseId, ['mastery', 'learner-profile', 'plan', 'lesson', 'practice-state'], {
      label: 'reassessed', files: ['exam-attempt.json'], removeKinds: ['plan', 'lesson', 'practice-state'], removeFiles: ['exam-attempt.json'],
    })
  }
  store.write(config.courseId, 'learner-profile', learner)
  store.write(config.courseId, 'mastery', engine.buildMastery())
  store.remove(config.courseId, 'assessment')
  io.out(`\n摸底完成。${learner.summary}\n能力画像已写入 ${store.root}/${config.courseId}/learner-profile.yaml\n`)
  if (planArchive) io.out(`旧掌握度/计划已归档到 ${planArchive}；请重新运行 plan 生成与新掌握度匹配的计划。\n`)
  io.closeInput()
  throw new FlowExit(0)
}
