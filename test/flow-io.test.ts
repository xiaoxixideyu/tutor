import test from 'node:test'
import assert from 'node:assert/strict'
import { createLineQueue, MAX_QUEUED_LINES } from '../src/flows/io.ts'

test('行输入队列按顺序取出排队行', async () => {
  const queue = createLineQueue()
  queue.push('第一行')
  queue.push('第二行')
  assert.equal(await queue.read(), '第一行')
  assert.equal(await queue.read(), '第二行')
})

test('等待中的读取者先拿到新推入的行', async () => {
  const queue = createLineQueue()
  const pending = queue.read()
  queue.push('即时行')
  assert.equal(await pending, '即时行')
})

test('关闭后读取返回 null（EOF）', async () => {
  const queue = createLineQueue()
  queue.close()
  assert.equal(await queue.read(), null)
  assert.equal(queue.closed, true)
})

test('输入行数超上限时停止接收并标记溢出，不再撑爆内存', async () => {
  const queue = createLineQueue()
  for (let index = 0; index < MAX_QUEUED_LINES + 500; index++) queue.push(`第 ${index} 行`)
  assert.equal(queue.overflowed, true)
  assert.equal(queue.closed, true)
  // 溢出后按 EOF 处理：等待中的读取者不会被无限期挂起
  assert.equal(await queue.read(), '第 0 行')
  let count = 1
  while (await queue.read() !== null) count++
  assert.equal(count, MAX_QUEUED_LINES)
})

test('未超上限时不标记溢出', () => {
  const queue = createLineQueue()
  for (let index = 0; index < 10; index++) queue.push(`第 ${index} 行`)
  assert.equal(queue.overflowed, false)
  assert.equal(queue.closed, false)
})
