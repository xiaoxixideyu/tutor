// 教研来源的准入判断：只接受正文可核对的原始/权威页面。
// 这里挡的是"看起来像资料、实际无法核对"的页面，不判断内容对错（那由内容审查负责）。
// 用主机名后缀而不是注册域名匹配，是为了让 baike.baidu.com 报"百科"、www.baidu.com 报"搜索结果页"。
const LOW_HOSTS = [
  // 百科、问答、文库
  'baike.baidu.com', 'zhidao.baidu.com', 'wenku.baidu.com', 'jingyan.baidu.com', 'baijiahao.baidu.com',
  'docin.com', 'doc88.com', '360doc.com', 'book118.com',
  // 问答与博客平台：二手转述，不能作为交叉验证依据
  'zhihu.com', 'csdn.net', 'jianshu.com', 'cnblogs.com',
  // 内容农场、门户与视频站
  'sohu.com', 'toutiao.com', '163.com', 'sina.com.cn', 'ifeng.com',
  'qq.com', 'weibo.com', 'xiaohongshu.com', 'douban.com', 'bilibili.com',
]

// 搜索引擎的任何页面都不是资料；教研里出现过拿 DuckDuckGo 结果页当来源的情况。
const SEARCH_HOSTS = /(^|\.)(duckduckgo\.com|google\.[a-z]{2,}(\.[a-z]{2})?|bing\.com|baidu\.com|yahoo\.com|sogou\.com|so\.com|yandex\.[a-z.]+)$/i

function matchesHost(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

export function rejectSourceReason(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return '地址非法' }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '地址非法'
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (LOW_HOSTS.some(suffix => matchesHost(host, suffix))) return '百科、问答、文库、博客平台或内容农场不能作为教研依据'
  if (SEARCH_HOSTS.test(host)) return '搜索结果页不能作为来源'
  return null
}
