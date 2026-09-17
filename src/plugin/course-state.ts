import path from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CourseStore } from '../core/store.ts'

export default class CourseStateService extends Service {
  static inject = []
  static Config = z.object({ root: z.string().default('courses') })

  readonly store: CourseStore

  constructor(ctx: Context, config: { root?: string }) {
    super(ctx, 'courseState')
    this.store = new CourseStore(path.resolve(config.root ?? 'courses'))
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    courseState: CourseStateService
  }
}
