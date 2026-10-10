import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const RESEARCH_LIMITS = {
  searches: 3, fetches: 2, toolRounds: 3, modelRequests: 5,
  resultChars: 6000, totalChars: 24000,
} as const

export class ResearchBudgetError extends Error {
  constructor() {
    super('本知识点已达到教研请求预算，尚未完成；已保存的其他知识点不受影响')
    this.name = 'ResearchBudgetError'
  }
}

// 按一个知识点计数。JSON 修复不重置预算，同一步的传输重试使用单独的恢复上限。
export class ResearchBudget {
  requests = 0
  searches = 0
  fetches = 0
  characters = 0
  failure?: ResearchBudgetError
  private readonly unavailable = new Set<string>()
  private readonly requestKeys = new Set<string>()
  private readonly progress: (message: string) => void

  constructor(progress: (message: string) => void = () => {}) { this.progress = progress }

  private kind(name: string): 'search' | 'fetch' | undefined {
    if (name.startsWith('mcp__searchix__') && name.endsWith('_search')) return 'search'
    if (name === 'web_fetch') return 'fetch'
    return undefined
  }

  available(name: string, nextRequest = true): boolean {
    if (this.requests + (nextRequest ? 1 : 0) > RESEARCH_LIMITS.toolRounds
      || this.characters >= RESEARCH_LIMITS.totalChars || this.unavailable.has(name)) return false
    const kind = this.kind(name)
    return kind === 'search' ? this.searches < RESEARCH_LIMITS.searches
      : kind === 'fetch' ? this.fetches < RESEARCH_LIMITS.fetches : false
  }

  hasRequest(key?: string): boolean { return key !== undefined && this.requestKeys.has(key) }

  checkRequest(key?: string): void {
    if (this.hasRequest(key)) return
    if (this.requests >= RESEARCH_LIMITS.modelRequests) {
      this.failure = new ResearchBudgetError()
      throw this.failure
    }
  }

  startRequest(key?: string): void {
    this.checkRequest(key)
    if (this.hasRequest(key)) return
    if (key !== undefined) this.requestKeys.add(key)
    this.requests++
    this.progress(this.requests > RESEARCH_LIMITS.toolRounds ? '正在汇总本知识点的资料…' : '正在核对本知识点的资料…')
  }

  claim(name: string): string | undefined {
    if (!this.available(name, false)) return '本知识点的该工具预算已用完或不可用。请依据已取得的资料输出最终 JSON；证据不足时保留 verified=false，不要继续调用工具。'
    if (this.kind(name) === 'search') {
      this.searches++
      this.progress('检索资料（' + this.searches + '/' + RESEARCH_LIMITS.searches + '）…')
    } else {
      this.fetches++
      this.progress('读取来源正文（' + this.fetches + '/' + RESEARCH_LIMITS.fetches + '）…')
    }
    return undefined
  }

  result(name: string, content: ContentBlock[], isError: boolean): ContentBlock[] {
    if (isError && this.kind(name) === 'search') {
      this.unavailable.add(name)
      this.progress('该搜索服务本次不可用，保留失败记录并使用剩余检索预算。')
    }
    const source = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const available = Math.max(0, Math.min(RESEARCH_LIMITS.resultChars, RESEARCH_LIMITS.totalChars - this.characters))
    const note = '\n[正文已按教研预算截断；未展示部分不作为已核实证据。依据现有片段收束，不追读本地缓存。]'
    const text = source.length <= available ? source
      : available >= note.length ? source.slice(0, available - note.length) + note : note.slice(0, available)
    this.characters += text.length
    return [{ type: 'text', text }]
  }

  instruction(): string {
    return '本次只教研一个知识点。最多进行 ' + RESEARCH_LIMITS.searches + ' 次搜索（包括失败后换服务）、'
      + RESEARCH_LIMITS.fetches + ' 次正文抓取；前 ' + RESEARCH_LIMITS.toolRounds + ' 轮可用工具，后续只输出或修复最终 JSON。'
      + '资料只保留有限片段，内容不足时标记未验证，不扩大搜索、不使用本地文件工具。'
      + '已用搜索 ' + this.searches + ' 次、抓取 ' + this.fetches + ' 次。'
  }
}
