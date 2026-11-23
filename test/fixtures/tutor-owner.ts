import path from 'node:path'
import { TutorSystem } from '../../src/application/tutor-system.ts'
import { ROOT, runtimeFactory } from './tutor.ts'

const directory = process.argv[2]
const system = new TutorSystem({
  root: ROOT,
  coursesRoot: path.join(directory, 'courses'),
  dataRoot: path.join(directory, 'data'),
  modelConfigFile: path.join(directory, 'model-config.json'),
  env: {
    TUTOR_LLM_BASE_URL: 'https://fixture.invalid/v1',
    TUTOR_LLM_API_KEY: 'fixture-key',
    TUTOR_LLM_MODEL: 'fixture',
    TUTOR_LLM_REQUESTS_PER_MINUTE: '600',
    TUTOR_MCP_SEARCH_URL: '',
    TUTOR_MCP_SEARCH_TOKEN: '',
  },
  runtimeFactory: runtimeFactory(directory, async () => new Promise(() => {})),
})
const view = system.service.view('alpha')
system.answer('alpha', {
  requestId: 'crashing-answer',
  activityId: view.active!.id,
  questionId: 'q1',
  contentHash: view.active!.contentHash,
  answer: '合并两个和三个，得到五个',
  expectedRevision: view.revision,
})
process.send?.({ type: 'ready', requestId: 'crashing-answer' })
