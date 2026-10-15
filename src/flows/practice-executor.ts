import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { PracticeTask } from '../core/schema.ts'
import { practiceTaskKey, safeStarterPath } from '../core/practice.ts'

// 实践任务执行器（插件层）：学员代码跑规则化测试。
// 接口与 Harness 的 ctx.shell 对齐（{command, workdir, timeoutMs} → {exitCode, timedOut, output}），
// 本期用子进程直跑（practice 壳零模型、不经 dsh 启动）；并入 dsh runner 时可原样切换。
// 命令来自已审查的 practice.yaml；独立工作目录、硬超时、输出限制与精简环境。
// 这不是操作系统沙箱：程序仍有当前用户的文件和网络权限；Go 仅禁依赖下载。

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
    // 学员程序不需要模型、搜索或其他服务凭据。
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|TMP|TEMP|SystemRoot|LANG|LC_.*|GOROOT)$/.test(key))),
    GOCACHE: path.join(workdir, '.gocache'),
    GOPROXY: 'off',
    GOFLAGS: '-mod=mod',
  }
}

function runOne(command: string, workdir: string, timeoutMs: number): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: workdir, env: environmentFor(workdir), detached: true })
    let output = ''
    let truncated = false
    const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch {} }
    const collect = (chunk: Buffer | string) => {
      if (output.length >= OUTPUT_LIMIT) {
        truncated = true
        stop()
        return
      }
      output += chunk.toString('utf8')
      if (output.length > OUTPUT_LIMIT) {
        output = output.slice(0, OUTPUT_LIMIT)
        truncated = true
        stop()
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stop()
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

function safeTarget(workdir: string, relative: string): string {
  const root = path.resolve(workdir)
  const target = path.resolve(root, relative)
  if (!target.startsWith(root + path.sep) || (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink())) throw new Error('初始文件必须位于任务工作目录内')
  let current = root
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part)
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('初始文件路径不能经过符号链接') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return target
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

// 只自动更新仍等于上次模板的文件；学员改动保留，新模板另存供查看。
export function ensureStarterFiles(task: PracticeTask, workdir: string): { preserved: { path: string; currentMaterial: string }[] } {
  fs.mkdirSync(workdir, { recursive: true })
  const manifestFile = safeTarget(workdir, '.tutor-starters.json')
  let previous: Record<string, string> = {}
  try { previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).hashes ?? {} } catch {}
  const hashes: Record<string, string> = {}
  const preserved: { path: string; currentMaterial: string }[] = []
  for (const file of task.starter_files ?? []) {
    if (!safeStarterPath(file.path)) throw new Error('初始文件路径非法')
    const target = safeTarget(workdir, file.path)
    hashes[file.path] = hash(file.content)
    const exists = fs.existsSync(target)
    const currentHash = exists ? hash(fs.readFileSync(target, 'utf8')) : undefined
    if (!exists || currentHash === previous[file.path]) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content)
    } else if (currentHash !== hashes[file.path]) {
      const currentMaterial = safeTarget(workdir, `.tutor-materials/${practiceTaskKey(task).slice(0, 12)}/${file.path}`)
      fs.mkdirSync(path.dirname(currentMaterial), { recursive: true })
      fs.writeFileSync(currentMaterial, file.content)
      preserved.push({ path: file.path, currentMaterial })
    }
  }
  fs.writeFileSync(manifestFile, JSON.stringify({ hashes }, null, 2) + '\n')
  return { preserved }
}
