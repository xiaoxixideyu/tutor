import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { existsSync } from 'node:fs'
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

const activeChildren = new Set<ReturnType<typeof spawn>>()
// 进程异常退出时尽量带走仍在运行的测试进程组；正常路径由 runOne 自己清理。
process.once('exit', () => {
  for (const child of activeChildren) {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
})

export interface RunTestsOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

function timeoutFor(command: string, opts?: RunTestsOptions): number {
  if (opts?.timeoutMs !== undefined) return opts.timeoutMs
  return /\bgo (build|test|run|vet)\b/.test(command) ? GO_TIMEOUT_MS : BASE_TIMEOUT_MS
}

function environmentFor(workdir: string): NodeJS.ProcessEnv {
  // 测试进程使用任务目录内的临时 HOME/TMP/缓存：学员程序/命令里的 ~、$HOME、临时文件
  // 不再落到真实用户目录（这不是操作系统沙箱，绝对路径与网络仍受当前用户权限约束）。
  const home = path.join(workdir, '.tutor-home')
  const tmp = path.join(workdir, '.tutor-tmp')
  const xdg = path.join(home, '.local')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(tmp, { recursive: true })
  return {
    // 学员程序不需要模型、搜索或其他服务凭据。
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|GOROOT|SystemRoot|LANG|LC_.*)$/.test(key))),
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: xdg,
    GOCACHE: path.join(workdir, '.tutor-gocache'),
    GOPATH: path.join(workdir, '.tutor-gopath'),
    GOPROXY: 'off',
    GOFLAGS: '-mod=mod',
  }
}

// 测试命令用 bash 执行（有 bash 时）而不是 /bin/sh：macOS 的 /bin/sh 是 bash 的 POSIX 模式，
// 不支持进程替换 <(...) 等写法，模型写出的命令会直接语法错误、学员永远看不到通过的测试。
// 没有 bash 的环境退回 /bin/sh（此时靠"POSIX 兼容写法"的要求兜底）。
let shell: string | undefined
function testShell(): string {
  if (shell) return shell
  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
    try {
      if (existsSync(candidate)) { shell = candidate; return shell }
    } catch { /* 继续找下一个 */ }
  }
  shell = '/bin/sh'
  return shell
}

function runOne(command: string, workdir: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  if (signal?.aborted) return Promise.resolve({ exitCode: -1, output: '（已中止）', timedOut: false })
  return new Promise((resolve) => {
    const child = spawn(testShell(), ['-c', command], { cwd: workdir, env: environmentFor(workdir), detached: true })
    activeChildren.add(child)
    let output = ''
    let truncated = false
    let timedOut = false
    let aborted = false
    const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch {} }
    const onAbort = () => { aborted = true; stop() }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const finish = (result: { exitCode: number; output: string; timedOut: boolean }) => {
      signal?.removeEventListener('abort', onAbort)
      activeChildren.delete(child)
      resolve(result)
    }
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
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      finish({ exitCode: 127, output: output + (truncated ? '\n…（输出过长已截断）' : '') + '\n（命令启动失败）', timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const suffix = truncated ? '\n…（输出过长已截断）' : ''
      finish({ exitCode: aborted || timedOut ? -1 : (code ?? -1),
        output: output + suffix + (aborted ? '\n（已中止）' : ''), timedOut })
    })
  })
}

export async function runTests(task: PracticeTask, workdir: string, opts?: RunTestsOptions): Promise<TestResultLike[]> {
  const results: TestResultLike[] = []
  for (const test of task.tests) {
    if (opts?.signal?.aborted) {
      results.push({ exitCode: -1, output: '（已中止）', timedOut: false })
      continue
    }
    const outcome = await runOne(test.command, workdir, timeoutFor(test.command, opts), opts?.signal)
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
