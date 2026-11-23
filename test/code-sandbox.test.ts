import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { CodeSandbox } from '../src/capabilities/sandbox.ts'

it('JavaScript、Python、Go 程序按真实输入输出进行隔离检验', { skip: process.platform !== 'darwin' }, async () => {
  const sandbox = new CodeSandbox(),
    signal = new AbortController().signal
  const programs = [
    ['javascript', 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(Number(s)*2));'],
    ['python', 'import sys\nprint(int(sys.stdin.read())*2)'],
    ['go', 'package main\nimport "fmt"\nfunc main(){var n int;fmt.Scan(&n);fmt.Println(n*2)}'],
  ] as const
  for (const [language, code] of programs) {
    const result = await sandbox.evaluate(
      language,
      code,
      [
        { input: '2', output: '4' },
        { input: '5', output: '10' },
      ],
      signal,
    )
    assert.equal(result.passed, 2, language + ': ' + JSON.stringify(result))
  }
})

it('隔离程序不能读取工作目录外文件，即使创建符号链接', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-private-proof-')),
    file = path.join(directory, 'secret')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(file, 'secret-test-value')
  const code =
    'const fs=require("fs");try{fs.symlinkSync(' +
    JSON.stringify(file) +
    ',"link");console.log(fs.readFileSync("link","utf8"))}catch{console.log("DENIED")}'
  const result = await new CodeSandbox().evaluate(
    'javascript',
    code,
    [
      { input: '', output: 'DENIED' },
      { input: '', output: 'DENIED' },
    ],
    new AbortController().signal,
  )
  assert.equal(result.passed, 2)
})

it('隔离程序不能连接本机服务或继承模型密钥', { skip: process.platform !== 'darwin' }, async (t) => {
  const server = http.createServer((_req, res) => res.end('should-not-be-reached'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  const code =
    'require("http").get("http://127.0.0.1:' +
    port +
    '",()=>console.log("ALLOWED")).on("error",()=>console.log(process.env.TUTOR_LLM_API_KEY?"KEY_LEAK":"DENIED"));'
  const result = await new CodeSandbox().evaluate(
    'javascript',
    code,
    [
      { input: '', output: 'DENIED' },
      { input: '', output: 'DENIED' },
    ],
    new AbortController().signal,
  )
  assert.equal(result.passed, 2)
})
