import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isMap, parseDocument, stringify, type Document as YamlDocument } from 'yaml'
import { DocumentSchemas, type DocKind } from './schema.ts'
import type { KnowledgeMap } from './schema.ts'
import { assertKnowledgeMap, enforceSourceVerification } from './knowledge.ts'

export const COURSE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const FILES: Record<DocKind, string> = {
  profile: 'profile.yaml',
  'knowledge-map': 'knowledge-map.yaml',
  'learner-profile': 'learner-profile.yaml',
  plan: 'plan.yaml',
  mastery: 'mastery.yaml',
  'question-bank': 'question-bank.yaml',
  assessment: 'assessment.yaml',
  lesson: 'lesson.yaml',
  practice: 'practice.yaml',
  'practice-state': 'practice-state.yaml',
}

export class CourseStore {
  readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  list(): string[] {
    if (!fs.existsSync(this.root)) return []
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && COURSE_ID_PATTERN.test(e.name))
      .filter((e) => fs.existsSync(this.courseFile(e.name, 'profile')))
      .map((e) => e.name)
      .sort()
  }

  exists(id: string): boolean {
    return COURSE_ID_PATTERN.test(id) && fs.existsSync(this.courseFile(id, 'profile'))
  }

  create(id: string, profile: unknown): void {
    if (!COURSE_ID_PATTERN.test(id)) {
      throw new Error(`课程 id "${id}" 非法：仅允许小写字母/数字/连字符（1-64 位）`)
    }
    if (this.exists(id)) throw new Error(`课程 "${id}" 已存在`)
    const validated = this.validate('profile', profile)
    const dir = this.courseDir(id)
    fs.mkdirSync(path.join(dir, 'materials'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    this.writeFile(id, 'profile', validated)
  }

  read(id: string, kind: DocKind): unknown {
    if (!this.exists(id)) throw new Error(`课程 "${id}" 不存在`)
    const file = this.courseFile(id, kind)
    if (!fs.existsSync(file)) throw new Error(`课程 "${id}" 缺少 ${FILES[kind]}`)
    const data = parseDocument(fs.readFileSync(file, 'utf8')).toJS()
    return this.validate(kind, data)
  }

  has(id: string, kind: DocKind): boolean {
    return this.exists(id) && fs.existsSync(this.courseFile(id, kind))
  }

  write(id: string, kind: DocKind, data: unknown): void {
    if (kind !== 'profile' && !this.exists(id)) throw new Error(`课程 "${id}" 不存在`)
    this.writeFile(id, kind, this.validate(kind, data, { strict: true }))
  }

  remove(id: string, kind: DocKind): void {
    const file = this.courseFile(id, kind)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }

  // 破坏性重跑前把旧状态复制到 courses/<id>/archive/<label>-<timestamp>/。
  // 只复制/删除显式列出的文件；失败时抛错，让调用方在覆盖前停下。
  archive(id: string, kinds: DocKind[], options: {
    label?: string
    files?: string[]
    removeKinds?: DocKind[]
    removeFiles?: string[]
  } = {}): string {
    if (!this.exists(id)) throw new Error(`课程 "${id}" 不存在`)
    const label = (options.label ?? 'snapshot').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40) || 'snapshot'
    const directory = path.join(this.courseDir(id), 'archive', `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(directory, 0o700) } catch { /* 文件系统不支持时保持默认 */ }
    for (const kind of kinds) {
      const file = this.courseFile(id, kind)
      if (fs.existsSync(file) && fs.statSync(file).isFile()) this.copyPrivate(file, path.join(directory, FILES[kind]))
    }
    for (const name of options.files ?? []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`归档文件名 "${name}" 非法`)
      const file = path.join(this.courseDir(id), name)
      if (fs.existsSync(file) && fs.statSync(file).isFile()) this.copyPrivate(file, path.join(directory, name))
    }
    for (const kind of options.removeKinds ?? []) this.remove(id, kind)
    for (const name of options.removeFiles ?? []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`归档文件名 "${name}" 非法`)
      const file = path.join(this.courseDir(id), name)
      if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file)
    }
    return directory
  }

  private writeFile(id: string, kind: DocKind, validated: unknown): void {
    const file = this.courseFile(id, kind)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const doc = mergeIntoDocument(file, validated)
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, doc.toString(), { mode: 0o600 })
    try { fs.chmodSync(tmp, 0o600) } catch { /* 文件系统不支持时保持默认 */ }
    fs.renameSync(tmp, file)
  }

  private validate(kind: DocKind, data: unknown, options: { strict?: boolean } = {}): unknown {
    if (typeof data !== 'object' || data === null) {
      throw new Error(`${FILES[kind]} 内容必须是映射`)
    }
    try {
      const validated = DocumentSchemas[kind](data)
      if (kind !== 'knowledge-map') return validated
      // 写入时做语义校验（新数据必须自洽）；读取时容忍历史遗留的宽松数据，避免旧课程直接打不开。
      if (options.strict) assertKnowledgeMap(validated as KnowledgeMap)
      return enforceSourceVerification(validated as KnowledgeMap)
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/\n+/g, ' ') : String(error)
      throw new Error(`${FILES[kind]} 校验失败：${message}`)
    }
  }

  // 归档里的课程状态同样只对当前用户可读。
  private copyPrivate(source: string, target: string): void {
    fs.copyFileSync(source, target)
    try { fs.chmodSync(target, 0o600) } catch { /* 文件系统不支持时保持默认 */ }
  }

  private courseDir(id: string): string {
    return path.join(this.root, id)
  }

  private courseFile(id: string, kind: DocKind): string {
    return path.join(this.courseDir(id), FILES[kind])
  }
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainMap(a) && isPlainMap(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]))
  }
  return false
}

function mergeIntoDocument(file: string, next: unknown): YamlDocument {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const doc = text.trim() ? parseDocument(text) : parseDocument('')
  if (!isPlainMap(next) || !isMap(doc.contents)) {
    return parseDocument(stringify(next))
  }
  mergeValue(doc, [], doc.toJS(), next)
  return doc
}

function mergeValue(doc: YamlDocument, trail: (string | number)[], existing: unknown, next: unknown): void {
  if (isPlainMap(existing) && isPlainMap(next)) {
    for (const key of Object.keys(existing)) {
      if (!(key in next)) doc.deleteIn([...trail, key])
    }
    for (const [key, value] of Object.entries(next)) {
      mergeValue(doc, [...trail, key], existing[key], value)
    }
  } else if (next === undefined) {
    // 显式 undefined 表示“移除该字段”。YAML 的 setIn(undefined) 会写成 null，
    // 而 null 与“字段不存在”在 Plan.current 等可选字段上有不同语义。
    deletePath(doc, trail)
  } else if (!deepEqual(existing, next)) {
    doc.setIn(trail, next as never)
  }
}

// yaml 的 deleteIn 在路径不存在时会抛错；删除是幂等操作，路径不存在时直接跳过。
function deletePath(doc: YamlDocument, trail: (string | number)[]): void {
  if (trail.length === 0) return
  try {
    doc.deleteIn(trail)
  } catch {
    // 路径不存在：本来就等于已删除
  }
}
