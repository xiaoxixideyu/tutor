import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireCourseLock } from '../core/course-lock.ts'
import { COURSE_ID_PATTERN, digest, validateState } from '../domain/validation.ts'
import { domainAssert, DomainError, STATE_VERSION, type CourseState, type LearningGoal } from '../domain/model.ts'

export interface CourseRepositoryOptions {
  beforeSwitch?: (state: CourseState) => void
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  let fd: number | undefined
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(value) + '\n')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try {
      fs.unlinkSync(temporary)
    } catch {
      /* 已切换或未创建 */
    }
  }
}

export class CourseRepository {
  readonly root: string
  private readonly cache = new Map<string, { stamp: string; state: CourseState }>()
  private readonly options: CourseRepositoryOptions

  constructor(root: string, options: CourseRepositoryOptions = {}) {
    this.root = path.resolve(root)
    this.options = options
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    domainAssert(!fs.lstatSync(this.root).isSymbolicLink(), 'INVALID_ROOT', '学习数据目录不能是符号链接', 500)
  }

  private directory(courseId: string): string {
    domainAssert(COURSE_ID_PATTERN.test(courseId), 'INVALID_ID', '课程标识不合法')
    const directory = path.join(this.root, courseId)
    if (fs.existsSync(directory))
      domainAssert(!fs.lstatSync(directory).isSymbolicLink(), 'INVALID_ROOT', '课程目录不能是符号链接', 500)
    return directory
  }

  private stateFile(courseId: string): string {
    return path.join(this.directory(courseId), 'state.json')
  }

  list(): string[] {
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter(
        (item) => item.isDirectory() && COURSE_ID_PATTERN.test(item.name) && fs.existsSync(this.stateFile(item.name)),
      )
      .map((item) => item.name)
      .sort()
  }

  exists(courseId: string): boolean {
    return COURSE_ID_PATTERN.test(courseId) && fs.existsSync(this.stateFile(courseId))
  }

  read(courseId: string): CourseState {
    const file = this.stateFile(courseId)
    let stat: fs.BigIntStats
    try {
      stat = fs.statSync(file, { bigint: true })
    } catch {
      throw new DomainError('COURSE_NOT_FOUND', '课程不存在', 404)
    }
    domainAssert(stat.size < 16n * 1024n * 1024n, 'INVALID_STATE', '课程状态异常过大', 500)
    const stamp = [stat.mtimeNs, stat.ino, stat.size].join(':')
    const cached = this.cache.get(courseId)
    if (cached?.stamp === stamp) return structuredClone(cached.state)
    let state: unknown
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      throw new DomainError('INVALID_STATE', '课程状态无法读取，请检查数据文件', 500)
    }
    validateState(state)
    this.cache.set(courseId, { stamp, state })
    return structuredClone(state)
  }

  create(courseId: string, title: string, goal: LearningGoal, background = ''): CourseState {
    const lock = acquireCourseLock(this.root, courseId)
    try {
      domainAssert(!this.exists(courseId), 'COURSE_EXISTS', '课程已经存在', 409)
      const now = new Date().toISOString()
      const state: CourseState = {
        version: STATE_VERSION,
        id: courseId,
        title,
        revision: 0,
        creationHash: digest({ title, goal, background }),
        createdAt: now,
        updatedAt: now,
        goal,
        learner: { background, preferences: [] },
        skills: [],
        activities: [],
        evidence: [],
        hypotheses: [],
        judgments: {},
        memory: {},
        sources: [],
        decisions: [],
        proposals: [],
        receipts: {},
        turns: {},
        tutorStatus: 'idle',
        usage: [],
        activeMs: 0,
        dailyActiveMs: {},
        events: [{ seq: 0, type: 'course_created', at: now, data: { title } }],
        nextEventSeq: 1,
      }
      const origin = { text: goal.text + (background ? '\n自述背景：' + background : ''), goal, background }
      const originAsset = digest(origin)
      atomicJson(path.join(this.directory(courseId), 'assets', originAsset + '.json'), origin)
      state.evidence.push({
        id: 'profile-' + randomUUID(),
        kind: 'feedback',
        at: now,
        asset: originAsset,
        summary: origin.text,
      })
      validateState(state)
      atomicJson(this.stateFile(courseId), state)
      return state
    } finally {
      lock.release()
    }
  }

  putAsset(courseId: string, value: unknown): string {
    domainAssert(this.exists(courseId), 'COURSE_NOT_FOUND', '课程不存在', 404)
    const hash = digest(value)
    const file = path.join(this.directory(courseId), 'assets', hash + '.json')
    if (!fs.existsSync(file)) atomicJson(file, value)
    return hash
  }

  asset<T>(courseId: string, hash: string): T {
    domainAssert(/^[a-f0-9]{64}$/.test(hash), 'INVALID_ASSET', '内容引用不合法', 500)
    const file = path.join(this.directory(courseId), 'assets', hash + '.json')
    let value: unknown
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      throw new DomainError('INVALID_ASSET', '学习内容或原始证据无法读取', 500)
    }
    domainAssert(digest(value) === hash, 'INVALID_ASSET', '内容或证据发生了未登记的变化', 500)
    return value as T
  }

  transact<T>(
    courseId: string,
    command: { expectedRevision?: number; requestId: string; input: unknown },
    work: (state: CourseState) => T,
  ): { state: CourseState; result: T; duplicate: boolean } {
    domainAssert(
      typeof command.requestId === 'string' && command.requestId.length > 0 && command.requestId.length <= 220,
      'INVALID_REQUEST_ID',
      '操作必须有独立的请求标识',
    )
    const lock = acquireCourseLock(this.root, courseId)
    try {
      const before = this.read(courseId)
      const inputHash = digest(command.input)
      const previous = before.receipts[command.requestId]
      if (previous) {
        domainAssert(previous.inputHash === inputHash, 'ALREADY_SUBMITTED', '该次请求已经提交，不能更改内容', 409)
        return { state: before, result: structuredClone(previous.result) as T, duplicate: true }
      }
      if (command.expectedRevision !== undefined)
        domainAssert(
          before.revision === command.expectedRevision,
          'STALE_REVISION',
          '学习状态已变化，请使用当前版本重试',
          409,
        )
      const state = structuredClone(before)
      const result = work(state)
      domainAssert(!(result instanceof Promise), 'ASYNC_TRANSACTION', '模型和长任务不能占用状态事务', 500)
      state.revision = before.revision + 1
      state.updatedAt = new Date().toISOString()
      state.receipts[command.requestId] = { inputHash, result: structuredClone(result) }
      validateState(state)
      this.options.beforeSwitch?.(state)
      atomicJson(this.stateFile(courseId), state)
      this.cache.delete(courseId)
      return { state, result, duplicate: false }
    } finally {
      lock.release()
    }
  }

  remove(courseId: string): void {
    const lock = acquireCourseLock(this.root, courseId)
    try {
      domainAssert(this.exists(courseId), 'COURSE_NOT_FOUND', '课程不存在', 404)
      fs.rmSync(this.directory(courseId), { recursive: true, force: true })
      this.cache.delete(courseId)
    } finally {
      lock.release()
    }
  }

  taskFile(courseId: string, taskId: string): string {
    domainAssert(/^[a-f0-9]{64}$/.test(taskId), 'INVALID_TASK', '任务标识不合法')
    return path.join(this.directory(courseId), 'tasks', taskId + '.json')
  }

  saveTask(courseId: string, taskId: string, value: unknown): void {
    atomicJson(this.taskFile(courseId, taskId), value)
  }
  readTask<T>(courseId: string, taskId: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.taskFile(courseId, taskId), 'utf8')) as T
    } catch {
      return undefined
    }
  }

  readDraft(courseId: string, activityId: string, questionId: string): { text: string; version: number } {
    const file = path.join(this.directory(courseId), 'drafts', digest([activityId, questionId]) + '.json')
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { text: '', version: 0 }
    }
  }

  saveDraft(courseId: string, activityId: string, questionId: string, text: string, version?: number) {
    const lock = acquireCourseLock(this.root, courseId)
    try {
      const state = this.read(courseId)
      domainAssert(!state.pendingAnswer, 'PENDING_ANSWER', '作答已经提交评分，不能覆盖', 409)
      domainAssert(state.currentActivityId === activityId, 'STALE_ACTIVITY', '活动已变化，草稿不能覆盖其他活动', 409)
      const previous = this.readDraft(courseId, activityId, questionId)
      if (version !== undefined)
        domainAssert(previous.version === version, 'STALE_DRAFT', '草稿已在另一个页面修改，请重新读取', 409)
      const draft = { text, version: previous.version + 1 }
      atomicJson(path.join(this.directory(courseId), 'drafts', digest([activityId, questionId]) + '.json'), draft)
      return draft
    } finally {
      lock.release()
    }
  }

  clearDraft(courseId: string, activityId: string, questionId: string): void {
    fs.rmSync(path.join(this.directory(courseId), 'drafts', digest([activityId, questionId]) + '.json'), {
      force: true,
    })
  }
}
