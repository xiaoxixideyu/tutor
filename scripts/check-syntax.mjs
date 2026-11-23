import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
for (const file of fs.readdirSync('scripts').filter((file) => file.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', path.join('scripts', file)], { encoding: 'utf8' })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.exit(1)
  }
}
for (const file of [
  'static/md.js',
  ...fs
    .readdirSync('static/ui')
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join('static/ui', file)),
]) {
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file })
}
process.stdout.write('CLI 与网页 JavaScript 语法检查通过。\n')
