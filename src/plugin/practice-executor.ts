import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { PracticeTask } from '../core/schema.ts'
import type { TestResult } from '../core/practice.ts'

// 实践任务执行器（插件层）：学员代码跑规则化测试。
// 接口与 Harness 的 ctx.shell 对齐（{command, workdir, timeoutMs} → {exitCode, timedOut, output}），
// 本期用子进程直跑（practice 壳零模型、不经 dsh 启动）；并入 dsh runner 时可原样切换。
// 安全边界：命令来自我们生成的 practice.yaml；workdir 隔离；硬超时 + 输出上限；Go 任务禁网络依赖。

const OUTPUT_LIMIT = 64 * 1024
const BASE_TIMEOUT_MS = 60_000
const GO_TIMEOUT_MS = 120_000 // go build/test 首次编译（GOCACHE 冷）较慢

export interface RunTestsOptions {
  timeoutMs?: number
}

function timeoutFor(command: string, opts?: RunTestsOptions): number {
  if (opts?.timeoutMs !== undefined) return opts.timeoutMs
  return /\bgo (build|test|run|vet)\b/.test(command) ? GO_TIMEOUT_MS : BASE_TIMEOUT_MS
}

function environmentFor(workdir: string): NodeJS.ProcessEnv {
  // Go 修正：GOCACHE 落任务目录（HOME 只读/缺失也能编译）；离线（不下载依赖）；允许 go.mod 自动补全
  return {
    ...process.env,
    GOCACHE: path.join(workdir, '.gocache'),
    GOPROXY: 'off',
    GOFLAGS: '-mod=mod',
  }
}

function runOne(command: string, workdir: string, timeoutMs: number): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: workdir, env: environmentFor(workdir) })
    let output = ''
    let truncated = false
    const collect = (chunk: Buffer | string) => {
      if (output.length >= OUTPUT_LIMIT) {
        truncated = true
        return
      }
      output += chunk.toString('utf8')
      if (output.length > OUTPUT_LIMIT) {
        output = output.slice(0, OUTPUT_LIMIT)
        truncated = true
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ exitCode: 127, output: output + (truncated ? '\n…（输出过长已截断）' : '') + '\n（命令启动失败）', timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const suffix = truncated ? '\n…（输出过长已截断）' : ''
      resolve({ exitCode: timedOut ? -1 : (code ?? -1), output: output + suffix, timedOut })
    })
  })
}

export async function runTests(task: PracticeTask, workdir: string, opts?: RunTestsOptions): Promise<TestResultLike[]> {
  const results: TestResultLike[] = []
  for (const test of task.tests) {
    const outcome = await runOne(test.command, workdir, timeoutFor(test.command, opts))
    results.push({ ...outcome })
  }
  return results
}

type TestResultLike = { exitCode: number; output: string; timedOut: boolean }

// starter 文件只在不存在时写入（断点续做不覆盖学员改动）
export function ensureStarterFiles(task: PracticeTask, workdir: string): void {
  fs.mkdirSync(workdir, { recursive: true })
  for (const file of task.starter_files ?? []) {
    const target = path.join(workdir, file.path)
    if (fs.existsSync(target)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content)
  }
}
