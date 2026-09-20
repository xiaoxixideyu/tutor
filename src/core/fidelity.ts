// 忠实度抽查（四期评测第一块）：从课堂会话日志事实中量化——计划覆盖率/引用纪律/超纲/成本
// 输入全部来自会话日志（唯一事实来源），规则层零模型成本

export interface LessonIntroView {
  node: string
  title: string
  structure: string[]
  resourceCount: number
}

export interface SessionEventView {
  type: string
  data?: {
    usage?: { inputTokens?: number; outputTokens?: number }
    message?: { content: { type: string; text?: string }[]; role?: string }
    inserted?: { content?: { type: string; text?: string }[] }[]
  }
}

export interface SessionLogView {
  intro: string
  assistantTexts: string[]
  userTexts: string[]
  usage: { inputTokens: number; outputTokens: number }[]
}

function textOf(blocks: { type: string; text?: string }[] | undefined): string {
  return (blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

export function parseSessionLog(events: SessionEventView[]): SessionLogView {
  let intro = ''
  const assistantTexts: string[] = []
  const userTexts: string[] = []
  const usage: { inputTokens: number; outputTokens: number }[] = []
  const considerIntro = (text: string) => {
    if (text.includes('【本课计划】') && intro === '') intro = text
  }
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      for (const item of event.data?.inserted ?? []) {
        const text = textOf(item.content)
        if (text === '') continue
        considerIntro(text)
        userTexts.push(text)
      }
    }
    if (event.type === 'user/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') {
        considerIntro(text)
        userTexts.push(text)
      }
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') assistantTexts.push(text)
      const usageSample = event.data?.usage
      if (usageSample && typeof usageSample.inputTokens === 'number' && typeof usageSample.outputTokens === 'number') {
        usage.push({ inputTokens: usageSample.inputTokens, outputTokens: usageSample.outputTokens })
      }
    }
  }
  return { intro, assistantTexts, userTexts, usage }
}

export function parseLessonIntro(intro: string): LessonIntroView | null {
  const nodeLine = intro.split('\n').find((line) => line.includes('【本课知识点】'))
  const nodeMatch = nodeLine?.match(/【本课知识点】(\S+)（(.+)）/)
  if (!nodeMatch) return null
  const planIndex = intro.indexOf('【本课计划】')
  if (planIndex < 0) return null
  const planText = intro.slice(planIndex + '【本课计划】'.length)
  const resourceIndex = intro.indexOf('【本课资料】')
  let resourceCount = 0
  if (resourceIndex >= 0) {
    const resourceText = intro.slice(resourceIndex, planIndex)
    resourceCount = (resourceText.match(/^\s*\d+\.\s/gm) ?? []).length
  }
  const structure: string[] = []
  for (const line of planText.split('\n')) {
    const point = line.match(/^\s*\d+\.\s+(.+)$/)
    if (point) structure.push(point[1].trim())
    else if (structure.length > 0 && !/^\s*核心例子/.test(line)) continue
    if (/^\s*核心例子/.test(line) && structure.length > 0) break
  }
  return { node: nodeMatch[1], title: nodeMatch[2], structure, resourceCount }
}

export function shingles(text: string): Set<string> {
  const normalized = text.toLowerCase()
  const result = new Set<string>()
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,}|[a-z0-9][a-z0-9.+-]*/g)) {
    const token = match[0]
    if (/^[\u4e00-\u9fff]/.test(token)) {
      for (let i = 0; i < token.length - 1; i++) result.add(token.slice(i, i + 2))
    } else {
      result.add(token)
    }
  }
  return result
}

export interface CoverageItem {
  point: string
  coverage: number
}

export function planCoverage(structure: string[], corpus: string): CoverageItem[] {
  const corpusShingles = shingles(corpus)
  return structure.map((point) => {
    const pointShingles = shingles(point)
    if (pointShingles.size === 0) return { point, coverage: 1 }
    let hit = 0
    for (const shingle of pointShingles) if (corpusShingles.has(shingle)) hit++
    return { point, coverage: Math.round((hit / pointShingles.size) * 100) / 100 }
  })
}

const ASSERTION_WORDS = /(事实上|一般来说|通常|必须|不能|标准|官方|规范|定义是|指的是|区别在于|核心是|原理是|本质上)/

export interface CitationAuditResult {
  totalCitations: number
  invalidCitations: number[]
  uncitedAssertions: number
  assertionSentences: number
}

export function citationAudit(messages: string[], resourceCount: number): CitationAuditResult {
  const all = messages.join('\n')
  const markers = [...all.matchAll(/\[资料[:：](\d+)\]/g)].map((m) => Number(m[1]))
  const invalid = [...new Set(markers.filter((n) => n < 1 || n > resourceCount))]
  let uncited = 0
  let assertionSentences = 0
  for (const message of messages) {
    for (const sentence of message.split(/(?<=[。！？])/)) {
      if (!ASSERTION_WORDS.test(sentence)) continue
      assertionSentences++
      if (!/\[资料[:：]\d+\]/.test(sentence)) uncited++
    }
  }
  return { totalCitations: markers.length, invalidCitations: invalid, uncitedAssertions: uncited, assertionSentences }
}

export interface DriftItem {
  id: string
  title?: string
  overlap: number
}

export function scopeDrift(corpus: string, lessonNode: string, otherNodes: { id: string; title?: string }[]): DriftItem[] {
  const corpusShingles = shingles(corpus)
  const results: DriftItem[] = []
  for (const node of otherNodes) {
    if (node.id === lessonNode) continue
    const nodeShingles = shingles(`${node.title ?? node.id} ${node.title ?? ''}`)
    if (nodeShingles.size === 0) continue
    let hit = 0
    for (const shingle of nodeShingles) if (corpusShingles.has(shingle)) hit++
    const overlap = Math.round((hit / nodeShingles.size) * 100) / 100
    if (overlap >= 0.5) results.push({ id: node.id, ...(node.title !== undefined ? { title: node.title } : {}), overlap })
  }
  return results.sort((a, b) => b.overlap - a.overlap)
}

export function sumUsage(usage: { inputTokens: number; outputTokens: number }[]): { inputTokens: number; outputTokens: number } {
  return usage.reduce(
    (acc, sample) => ({ inputTokens: acc.inputTokens + sample.inputTokens, outputTokens: acc.outputTokens + sample.outputTokens }),
    { inputTokens: 0, outputTokens: 0 }
  )
}

export interface FidelityReport {
  sessionId: string
  node: string
  title: string
  structure: CoverageItem[]
  coverageRate: number
  citations: CitationAuditResult
  drift: DriftItem[]
  cost: { inputTokens: number; outputTokens: number; turns: number }
  generatedAt: string
}

export function assembleReport(input: {
  sessionId: string
  introView: LessonIntroView
  assistantTexts: string[]
  usage: { inputTokens: number; outputTokens: number }[]
  otherNodes: { id: string; title?: string }[]
  generatedAt: string
}): FidelityReport {
  const corpus = input.assistantTexts.join('\n')
  const structure = planCoverage(input.introView.structure, corpus)
  const covered = structure.filter((item) => item.coverage >= 0.5).length
  return {
    sessionId: input.sessionId,
    node: input.introView.node,
    title: input.introView.title,
    structure,
    coverageRate: structure.length > 0 ? Math.round((covered / structure.length) * 100) / 100 : 1,
    citations: citationAudit(input.assistantTexts, input.introView.resourceCount),
    drift: scopeDrift(corpus, input.introView.node, input.otherNodes),
    cost: { ...sumUsage(input.usage), turns: input.assistantTexts.length },
    generatedAt: input.generatedAt,
  }
}
