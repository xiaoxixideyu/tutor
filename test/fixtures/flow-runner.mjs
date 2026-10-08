import readline from 'node:readline'
import { spawn } from 'node:child_process'

const [kind, course, node = ''] = process.argv.slice(2)
process.stdout.write(`启动 ${kind} ${course}${node ? ' ' + node : ''}\n`)
if (kind === 'practice-gen') {
  process.stdout.write('实践任务生成完成\n')
  process.exit(0)
}
process.stdout.write(kind === 'practice' ? '回车运行测试（r 重跑，q 中止保存进度）> ' : '> ')
if (kind === 'plan') {
  // 模拟被 agent.mjs 包裹的子进程：只杀外层进程时，孙进程仍持有 stdout，close 不会发生。
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
  setInterval(() => {}, 1000)
} else {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    if (line === '/exit' || line === 'q' || line === 'finish' || line === '') {
      process.stdout.write('最终结果：进度已保存\n')
      process.exit(0)
    }
    process.stdout.write(`收到：${line}\n> `)
  })
  rl.on('close', () => process.exit(0))
}
