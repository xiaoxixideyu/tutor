import { it } from 'node:test'
import assert from 'node:assert/strict'
import { rejectSourceReason } from '../src/core/source-quality.ts'

it('搜索结果页不能作为来源', () => {
  for (const url of [
    'https://lite.duckduckgo.com/lite/?q=go+channel',
    'https://duckduckgo.com/?q=go+channel',
    'https://www.google.com/search?q=go+channel',
    'https://www.bing.com/search?q=go',
    'https://www.baidu.com/s?wd=go',
  ]) assert.match(rejectSourceReason(url) ?? '', /搜索结果页/, `${url} 应判为搜索结果页`)
})

it('百科、问答、文库、博客平台与内容农场被剔除', () => {
  for (const url of [
    'https://baike.baidu.com/item/xxx',
    'https://zhidao.baidu.com/question/1',
    'https://wenku.baidu.com/view/1.html',
    'https://zhuanlan.zhihu.com/p/123',
    'https://www.zhihu.com/question/1',
    'https://blog.csdn.net/a/article/details/1',
    'https://www.jianshu.com/p/abc',
    'https://www.cnblogs.com/x/p/1.html',
    'https://www.sohu.com/a/1',
    'https://mp.weixin.qq.com/s/abc',
    'https://www.bilibili.com/video/BV1',
  ]) assert.ok(rejectSourceReason(url), `${url} 应被剔除`)
})

it('官方文档、政府站点、项目仓库与百科全书的可核对页面仍然放行', () => {
  for (const url of [
    'https://go.dev/doc/effective_go',
    'https://pkg.go.dev/net/http',
    'https://developer.mozilla.org/en-US/docs/Web/HTTP',
    'https://www.gdzz.gov.cn/',
    'https://github.com/golang/go/wiki',
    'https://en.wikipedia.org/wiki/Go_(programming_language)',
    'https://www.learningscientists.org/retrieval-practice',
  ]) assert.equal(rejectSourceReason(url), null, `${url} 应保留`)
})

it('非法地址给出原因而不是抛错', () => {
  assert.equal(rejectSourceReason('not a url'), '地址非法')
  assert.equal(rejectSourceReason('ftp://example.com/a'), '地址非法')
})
