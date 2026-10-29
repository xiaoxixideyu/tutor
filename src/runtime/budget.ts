import { MCP_SEARCH_PREFIX } from './tools.ts'

export interface TextContentBlock {
  type: 'text'
  text: string
}

export const RESEARCH_LIMITS = {
  searches: 3, fetches: 2, toolRounds: 3, modelRequests: 6,
  resultChars: 6000, totalChars: 24000,
} as const

// 同一搜索服务连续失败达到该次数才在本知识点内停用：网关偶发 5xx 值得再试一次。
export const SEARCH_RETRY_LIMIT = 2

export class ResearchBudgetError extends Error {
  constructor() {
    super('本知识点已达到教研请求预算，尚未完成；已保存的其他知识点不受影响')
    this.name = 'ResearchBudgetError'
  }
}

// 按一个知识点计数。JSON 修复不重置预算，同一步的传输重试使用单独的恢复上限。
// 系统提示词必须逐字节稳定才能复用渠道前缀缓存：预算计数只用于服务端限制与进度展示，
// 不写进 instruction()，否则每次工具调用后都会改变首条 system 消息。
const INSTRUCTION = '本次只教研一个知识点。最多进行 ' + RESEARCH_LIMITS.searches + ' 次搜索（包括失败后换服务）、'
  + RESEARCH_LIMITS.fetches + ' 次正文抓取；前 ' + RESEARCH_LIMITS.toolRounds + ' 轮可用工具，后续只输出或修复最终 JSON。'
  + '资料只保留有限片段，内容不足时标记未验证，不扩大搜索、不使用本地文件工具。'

export class ResearchBudget {
  requests = 0
  searches = 0
  fetches = 0
  characters = 0
  failure?: ResearchBudgetError
  private readonly unavailable = new Set<string>()
  private readonly failures = new Map<string, number>()
  private readonly requestKeys = new Set<string>()
  private readonly progress: (message: string) => void

  constructor(progress: (message: string) => void = () => {}) { this.progress = progress }

  // 工具分类同时兼容下划线与连字符命名（searchix 用 *_search；Tavily Hikari 用 tavily-search；
  // Exa 用 web_search_exa / web_fetch_exa / crawling_exa）。
  // extract 类工具按正文抓取计费（与 web_fetch 共用抓取预算），其余工具不暴露。
  private kind(name: string): 'search' | 'fetch' | undefined {
    const bare = name.startsWith(MCP_SEARCH_PREFIX) ? name.slice(MCP_SEARCH_PREFIX.length) : name
    // 注意 tavily_research 里的 "research" 不算 search：要求 search 前后是分隔符或首尾。
    if (/(^|[_-])search([_-]|$)/.test(bare)) return 'search'
    if (name === 'web_fetch' || /(^|[_-])extract([_-]|$)/.test(bare) || /(^|[_-])fetch([_-]|$)/.test(bare)) return 'fetch'
    // Exa 的整页读取工具名不含 fetch/extract 片段。
    if (bare === 'crawling_exa') return 'fetch'
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

  private refund(kind: 'search' | 'fetch' | undefined): void {
    if (kind === 'search') this.searches = Math.max(0, this.searches - 1)
    else if (kind === 'fetch') this.fetches = Math.max(0, this.fetches - 1)
  }

  result(name: string, content: TextContentBlock[], isError: boolean, failure: 'argument' | 'service' | 'auth' = 'service'): TextContentBlock[] {
    if (isError) {
      const kind = this.kind(name)
      if (failure === 'auth') {
        // 密钥无效/无权重试没有意义：立刻停用并给出可操作的提示。
        this.refund(kind)
        if (kind === 'search') {
          this.unavailable.add(name)
          this.progress('搜索服务鉴权失败（密钥无效或无权限），本知识点内不再尝试；请到“模型设置”检查搜索 Token。')
        }
      } else if (failure === 'argument') {
        // 参数写错是模型可自纠的失败：退还本次预算，也不把工具拉黑，否则一次手滑就废掉整个知识点。
        this.refund(kind)
        this.progress(kind === 'search' ? '搜索参数不合规，已退还本次检索预算。' : '抓取参数不合规，已退还本次抓取预算。')
      } else if (kind === 'search') {
        // 传输/服务失败不占检索次数；连续失败达到上限才停用该服务，避免一次网关抖动废掉知识点。
        this.refund(kind)
        const failures = (this.failures.get(name) ?? 0) + 1
        this.failures.set(name, failures)
        if (failures >= SEARCH_RETRY_LIMIT) {
          this.unavailable.add(name)
          this.progress('该搜索服务连续失败，本知识点内不再尝试；保留失败记录并使用剩余预算。')
        } else {
          this.progress('搜索服务本次失败（未计入检索次数），可调整查询后再试一次。')
        }
      }
    } else {
      this.failures.delete(name)
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
    return INSTRUCTION
  }
}
