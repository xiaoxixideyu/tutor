import fs from 'node:fs'
import path from 'node:path'
import { isMap, parseDocument, stringify, type Document as YamlDocument } from 'yaml'
import { DocumentSchemas, type DocKind } from './schema.ts'

const COURSE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

const FILES: Record<DocKind, string> = {
  profile: 'profile.yaml',
  'knowledge-map': 'knowledge-map.yaml',
  'learner-profile': 'learner-profile.yaml',
  plan: 'plan.yaml',
  mastery: 'mastery.yaml',
  'question-bank': 'question-bank.yaml',
  assessment: 'assessment.yaml',
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
    this.writeFile(id, kind, this.validate(kind, data))
  }

  remove(id: string, kind: DocKind): void {
    const file = this.courseFile(id, kind)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }

  private writeFile(id: string, kind: DocKind, validated: unknown): void {
    const file = this.courseFile(id, kind)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const doc = mergeIntoDocument(file, validated)
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, doc.toString())
    fs.renameSync(tmp, file)
  }

  private validate(kind: DocKind, data: unknown): unknown {
    if (typeof data !== 'object' || data === null) {
      throw new Error(`${FILES[kind]} 内容必须是映射`)
    }
    try {
      return DocumentSchemas[kind](data)
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/\n+/g, ' ') : String(error)
      throw new Error(`${FILES[kind]} 校验失败：${message}`)
    }
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
  } else if (!deepEqual(existing, next)) {
    doc.setIn(trail, next as never)
  }
}
