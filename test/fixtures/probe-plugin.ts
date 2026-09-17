import { Service, type Context } from '@deepseek-ai/cordis'

export default class Probe extends Service {
  static inject = ['courseState']

  constructor(ctx: Context) {
    super(ctx, 'probe')
    const store = ctx.courseState.store
    if (!store.exists('e2e-probe')) store.create('e2e-probe', { goal: '端到端探针课程' })
    store.write('e2e-probe', 'mastery', { demo: { status: 'learning', score: 0.5 } })
    const mastery = store.read('e2e-probe', 'mastery') as { demo?: { status: string } }
    console.error(`[probe] courses=${JSON.stringify(store.list())} mastery=${mastery.demo?.status}`)
  }
}
