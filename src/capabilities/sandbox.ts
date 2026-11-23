import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { CodeLanguage, Grade } from '../domain/model.ts'
import { DomainError, domainAssert } from '../domain/model.ts'

const OUTPUT_LIMIT = 32768

export interface SandboxResult {
  passed: number
  total: number
  results: NonNullable<Grade['execution']>['results']
}

function executable(command: string): string | undefined {
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : undefined
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      // Apple 的入口是 xcrun 包装器。隔离执行直接使用解释器，避免启动安装器或开发工具探测。
      if (command === 'python3' && candidate === '/usr/bin/python3') {
        for (const native of [
          '/Library/Developer/CommandLineTools/usr/bin/python3',
          '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
        ]) {
          if (fs.existsSync(native)) {
            const resolved = fs.realpathSync(native)
            const framework = path.join(
              path.dirname(path.dirname(resolved)),
              'Resources/Python.app/Contents/MacOS/Python',
            )
            return fs.existsSync(framework) ? fs.realpathSync(framework) : resolved
          }
        }
        continue
      }
      return fs.realpathSync(candidate)
    } catch {
      /* 检查下一个 */
    }
  }
  return undefined
}

function quoteProfile(value: string): string {
  return JSON.stringify(value)
}

function profile(directory: string, binary: string, extraRead: string[] = [], allowFork = false): string {
  const reads = [
    '/System',
    '/usr/lib',
    '/usr/share',
    '/Library/Apple',
    '/private/var/db/dyld',
    '/opt/homebrew/Cellar',
    '/opt/homebrew/opt',
    '/usr/local/lib',
    '/dev/null',
    '/dev/urandom',
    '/dev/random',
    '/private/etc',
    path.dirname(binary),
    ...extraRead,
  ]
  return (
    '(version 1)\n(deny default)\n' +
    '(allow process-exec (literal ' +
    quoteProfile(binary) +
    '))\n' +
    (allowFork ? '(allow process-fork)\n' : '') +
    '(allow sysctl-read)\n(allow mach-lookup)\n' +
    '(allow process-info* (target self))\n(allow dynamic-code-generation)\n' +
    '(allow file-read* (require-not (vnode-type REGULAR-FILE)))\n' +
    '(allow file-map-executable ' +
    [...reads, directory].map((item) => '(subpath ' + quoteProfile(item) + ')').join(' ') +
    ')\n' +
    '(allow file-read* ' +
    reads.map((item) => '(subpath ' + quoteProfile(item) + ')').join(' ') +
    ')\n' +
    '(allow file-read* file-write* (subpath ' +
    quoteProfile(directory) +
    '))\n' +
    '(allow file-read* file-write* (literal "/dev/null"))\n'
  )
}

function run(
  command: string,
  args: string[],
  input: string,
  directory: string,
  signal: AbortSignal,
  timeout = 10000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ output: string; error: string; code: number }> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      detached: process.platform !== 'win32',
      env: {
        PATH: process.env.PATH,
        LANG: 'en_US.UTF-8',
        HOME: directory,
        TMPDIR: directory,
        TMP: directory,
        GOCACHE: path.join(directory, 'go-cache'),
        GOPATH: path.join(directory, 'go-path'),
        GOPROXY: 'off',
        GOTOOLCHAIN: 'local',
        CGO_ENABLED: '0',
        OPENSSL_CONF: '/dev/null',
        GOMEMLIMIT: '64MiB',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = '',
      error = '',
      overflow = false,
      timedOut = false,
      resourceLimit = false
    const kill = () => {
      try {
        if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
    const abort = () => kill()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeout)
    const memory = setInterval(() => {
      if (!child.pid) return
      const measured = spawnSync('/bin/ps', ['-o', 'rss=', '-g', String(child.pid)], {
        encoding: 'utf8',
        timeout: 1000,
      })
      const processes = (measured.stdout ?? '').trim().split(/\s+/).filter(Boolean).map(Number)
      const limit = extraEnv.GOOS ? 512 * 1024 : 256 * 1024
      if (processes.length > 12 || processes.reduce((sum, value) => sum + value, 0) > limit) {
        resourceLimit = true
        kill()
      }
    }, 250)
    const collect = (value: Buffer, stderr: boolean) => {
      if (stderr) error += value.toString('utf8')
      else output += value.toString('utf8')
      if (output.length + error.length > OUTPUT_LIMIT) {
        overflow = true
        kill()
      }
    }
    child.stdout.on('data', (value) => collect(value, false))
    child.stderr.on('data', (value) => collect(value, true))
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      clearTimeout(timer)
      clearInterval(memory)
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer)
      clearInterval(memory)
      signal.removeEventListener('abort', abort)
      if (signal.aborted) {
        reject(signal.reason ?? new Error('已中止'))
        return
      }
      resolve({
        output: output.slice(0, OUTPUT_LIMIT),
        error: timedOut
          ? '执行超时'
          : overflow
            ? '输出超过限制'
            : resourceLimit
              ? '内存或进程数量达到限制'
              : error.slice(0, OUTPUT_LIMIT) || (exitSignal ? '程序被系统终止：' + exitSignal : ''),
        code: timedOut || overflow || resourceLimit ? -1 : (code ?? -1),
      })
    })
    child.stdin.end(input)
  })
}

export class CodeSandbox {
  available(language: CodeLanguage): boolean {
    const binary = language === 'javascript' ? process.execPath : executable(language === 'python' ? 'python3' : 'go')
    if (!binary) return false
    return process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')
  }

  async evaluate(
    language: CodeLanguage,
    code: string,
    tests: { input: string; output: string }[],
    signal: AbortSignal,
  ): Promise<SandboxResult> {
    domainAssert(
      this.available(language),
      'SANDBOX_UNAVAILABLE',
      '当前系统没有可用的隔离执行器，请采用开放作答任务或配置隔离执行环境',
      503,
    )
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-code-')))
    try {
      const binary = fs.realpathSync(
        language === 'javascript' ? process.execPath : executable(language === 'python' ? 'python3' : 'go')!,
      )
      const file = path.join(
        directory,
        language === 'javascript' ? 'solution.cjs' : language === 'python' ? 'solution.py' : 'main.go',
      )
      fs.writeFileSync(file, code, { mode: 0o600 })
      let args: string[], policy: string
      if (language === 'go') {
        const root = spawnSync(binary, ['env', 'GOROOT'], { encoding: 'utf8' }).stdout.trim()
        domainAssert(root.length > 0, 'SANDBOX_UNAVAILABLE', '无法定位 Go 运行环境', 503)
        const compilePolicy = profile(directory, binary, [root], true).replace(
          '(allow process-exec',
          '(allow process-exec (subpath ' + quoteProfile(root) + ')',
        )
        const compiled = await run(
          '/usr/bin/sandbox-exec',
          ['-p', compilePolicy, binary, 'build', '-p', '2', '-o', path.join(directory, 'solution.wasm'), file],
          '',
          directory,
          signal,
          60000,
          { GOOS: 'wasip1', GOARCH: 'wasm' },
        )
        if (compiled.code !== 0)
          return {
            passed: 0,
            total: tests.length,
            results: tests.map((test) => ({
              passed: false,
              actual: '',
              expected: test.output,
              error: '编译失败：' + compiled.error,
            })),
          }
        const node = fs.realpathSync(process.execPath)
        const loader = path.join(directory, 'runner.cjs')
        fs.writeFileSync(
          loader,
          'const fs=require("node:fs");const {WASI}=require("node:wasi");const wasi=new WASI({version:"preview1",args:[],env:{GOMEMLIMIT:"64MiB"},preopens:{"/work":process.cwd()}});const mod=new WebAssembly.Module(fs.readFileSync("solution.wasm"));const instance=new WebAssembly.Instance(mod,{wasi_snapshot_preview1:wasi.wasiImport});wasi.start(instance);',
        )
        policy = profile(directory, node)
        args = ['-p', policy, node, '--max-old-space-size=64', loader]
      } else {
        const pythonRoot =
          language === 'python'
            ? spawnSync(binary, ['-I', '-c', 'import sys;print(sys.base_prefix)'], { encoding: 'utf8' }).stdout.trim()
            : ''
        policy = profile(directory, binary, pythonRoot ? [pythonRoot] : [])
        args = ['-p', policy, binary, ...(language === 'javascript' ? ['--max-old-space-size=64', file] : ['-I', file])]
      }
      const results: SandboxResult['results'] = []
      for (const test of tests) {
        const outcome = await run('/usr/bin/sandbox-exec', args, test.input, directory, signal)
        const passed = outcome.code === 0 && outcome.output.trim() === test.output.trim()
        results.push({
          passed,
          actual: outcome.output.trim(),
          expected: test.output,
          ...(outcome.code !== 0 ? { error: outcome.error || '程序退出码：' + outcome.code } : {}),
        })
      }
      return { passed: results.filter((item) => item.passed).length, total: tests.length, results }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}
