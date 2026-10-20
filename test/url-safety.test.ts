import { it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { assertPublicUrl, isPrivateAddress, readBodyLimited, safeFetch, UnsafeUrlError, ResponseTooLargeError } from '../src/runtime/url-safety.ts'
import { webFetch } from '../src/runtime/tools.ts'

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

it('识别内网、回环、链路本地和保留地址', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address)
  }
})

it('解析后任一地址落在内网都拒绝', async () => {
  await assertPublicUrl(new URL('https://example.com/'), publicLookup as never)
  await assert.rejects(assertPublicUrl(new URL('https://example.com/'), (async () => [{ address: '127.0.0.1', family: 4 }]) as never), UnsafeUrlError)
  await assert.rejects(assertPublicUrl(new URL('https://example.com/'), (async () => [
    { address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 },
  ]) as never), UnsafeUrlError)
  await assert.rejects(assertPublicUrl(new URL('http://localhost/')), UnsafeUrlError)
  await assert.rejects(assertPublicUrl(new URL('http://127.0.0.1/')), UnsafeUrlError)
})

it('重定向到内网会在跟随前被拒绝', async () => {
  let calls = 0
  const fakeFetch = (async () => {
    calls += 1
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
  }) as typeof fetch
  await assert.rejects(safeFetch('https://example.com/', { fetchImpl: fakeFetch, lookup: publicLookup as never }), UnsafeUrlError)
  assert.equal(calls, 1)
})

it('响应体超过上限时中止读取', async () => {
  await assert.rejects(readBodyLimited(new Response('x'.repeat(100), { headers: { 'content-length': '100' } }), 10), ResponseTooLargeError)
  const body = await readBodyLimited(new Response('ok'), 10)
  assert.equal(body.toString('utf8'), 'ok')
})

it('webFetch 在发起连接前拒绝本机地址', async () => {
  let hits = 0
  const server = http.createServer((_req, res) => { hits += 1; res.end('secret') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const result = await webFetch(`http://127.0.0.1:${address.port}/`, new AbortController().signal)
    assert.equal(result.isError, true)
    assert.match(result.text, /内网|回环|本机/)
    assert.equal(hits, 0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
