#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { TutorSystem, INTENTS } from '../src/application/tutor-system.ts'
import { readModelEnvironment } from '../src/core/model-config.ts'
import { createCliIO } from '../src/runtime/io.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2),
  mode = args[0]
const env = readModelEnvironment(root, process.env)
if (mode === 'serve') {
  await import('./serve.mjs')
} else {
  const system = new TutorSystem({ root, coursesRoot: env.TUTOR_COURSES_ROOT, dataRoot: env.TUTOR_DATA_ROOT, env })
  const out = (value) => process.stdout.write(String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') + '\n')
  async function interact(courseId, intent) {
    const io = createCliIO(),
      initial = system.service.view(courseId)
    out(initial.title + '\n目标：' + initial.goal.text)
    let cursor = system.repository.read(courseId).nextEventSeq - 1
    const printed = new Set()
    const unsubscribe = system.subscribe((id) => {
      if (id !== courseId) return
      for (const event of system.events(id, cursor)) {
        cursor = Math.max(cursor, event.seq)
        if (printed.has(event.seq)) continue
        printed.add(event.seq)
        if (event.type === 'tutor_message') out('\n导师：' + event.data.text)
        if (event.type === 'activity_presented')
          out(
            '\n' +
              event.data.title +
              '\n' +
              (event.data.body ?? '') +
              '\n为什么这样安排：' +
              (event.data.rationale ?? ''),
          )
        if (event.type === 'answer_graded')
          out('\n' + Math.round(event.data.grade.score * 100) + '% · ' + event.data.grade.feedback)
      }
    })
    try {
      if (initial.pendingAnswer || initial.tutorStatus === 'paused') system.resume(courseId, randomUUID())
      else system.start(courseId, { requestId: randomUUID(), intent, message: '' })
      while (!io.signal.aborted) {
        await system.wait(courseId)
        const state = system.service.view(courseId)
        if (state.tutorStatus === 'failed') {
          out('本轮未完成，原始作答和完成步骤已保存：' + state.tutorError)
          out('输入 /continue 恢复，或 /pause 暂停。')
        }
        if (state.tutorStatus === 'paused') out('本次已暂停。输入 /continue 继续。')
        const question = state.active?.question
        if (question) {
          out('\n第 ' + (state.active.index + 1) + '/' + state.active.total + ' 题：\n' + question.prompt)
          for (const [index, choice] of (question.choices ?? []).entries())
            out(String.fromCharCode(65 + index) + '. ' + choice)
          if (state.active.draft?.text) out('已恢复未提交草稿：\n' + state.active.draft.text)
          if (question.type === 'code' || question.type === 'open')
            out('多行作答输入单独一行 . 提交；/pause 保存草稿退出。')
        }
        process.stdout.write('\n> ')
        let line = await io.readLine()
        if (line === null || line.trim() === '/pause' || line.trim() === '/exit') {
          system.pause(courseId, randomUUID())
          break
        }
        if (line.trim() === '/continue') {
          system.resume(courseId, randomUUID())
          continue
        }
        if (line.trim() === '/hint') {
          system.start(courseId, { requestId: randomUUID(), message: '请对当前题给一个提示。', intent: 'learn' })
          continue
        }
        if (line.startsWith('/say ')) {
          system.start(courseId, { requestId: randomUUID(), message: line.slice(5), intent: 'learn' })
          continue
        }
        if (!question) {
          system.start(courseId, { requestId: randomUUID(), message: line, intent })
          continue
        }
        if (question.type === 'open' || question.type === 'code') {
          const lines = state.active.draft?.text ? [state.active.draft.text] : []
          let paused = false
          while (line !== null && line.trim() !== '.') {
            if (line.trim() === '/pause' || line.trim() === '/exit') {
              paused = true
              break
            }
            lines.push(line)
            system.service.saveDraft(courseId, {
              activityId: state.active.id,
              questionId: question.id,
              answer: lines.join('\n'),
            })
            line = await io.readLine()
          }
          if (line === null || paused) {
            system.pause(courseId, randomUUID())
            break
          }
          line = lines.join('\n')
        }
        if (!line.trim()) continue
        system.answer(courseId, {
          requestId: randomUUID(),
          activityId: state.active.id,
          questionId: question.id,
          contentHash: state.active.contentHash,
          answer: line,
          expectedRevision: system.repository.read(courseId).revision,
        })
      }
    } finally {
      unsubscribe()
      io.closeInput()
      await system.close()
    }
  }
  try {
    if (mode === 'new') {
      const goal = args.slice(1).join(' ').trim()
      if (!goal) throw new Error('请提供学习目标：npm run agent -- new "你的学习目标"')
      const created = system.service.create({ goal })
      out('目标已创建：' + created.id + '\n开始学习：npm run agent -- learn ' + created.id)
    } else if (mode === 'list') {
      for (const course of system.service.list())
        out(
          course.id +
            ' · ' +
            course.title +
            ('error' in course
              ? ' · ' + course.error
              : ' · ' + course.supported + '/' + course.total + ' 项当前目标已验证'),
        )
    } else if (mode === 'status') {
      const state = system.service.view(args[1])
      out(state.title + '\n' + state.goal.text + '\n已验证：' + state.supported + '/' + state.total)
      for (const skill of state.skills)
        out(skill.title + ' · ' + skill.status + ' · ' + skill.evidenceCount + ' 条作答证据')
      if (state.active)
        out('当前活动：' + state.active.title + '，已答 ' + state.active.index + '/' + state.active.total)
    } else if (mode === 'today') {
      const state = system.readToday()
      if (args.includes('--plan')) {
        const result = await system.recommendToday(20)
        out(result.recommendation?.label ?? '先创建一个学习目标')
      } else out(state.recommendation?.label ?? '使用 npm run agent -- today --plan 让导师安排今天')
    } else if (INTENTS.includes(mode)) {
      await interact(args[1], mode)
    } else
      out(
        '用法：npm run agent -- serve | new "目标" | list | status <课程> | today [--plan] | learn|review|practice|assess|exam|research|repair <课程>',
      )
  } catch (error) {
    process.stderr.write((error.message ?? String(error)) + '\n')
    process.exitCode = 1
  } finally {
    await system.close()
  }
}
