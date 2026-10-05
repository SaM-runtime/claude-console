import { expect, test } from 'claude-code/testing'

import type { JobFlag, Project, Snapshot } from '../types'
import { diffToasts, events, taskMeta } from '../hooks/logic'

const project = (jobs: JobFlag[]): Project => ({
  name: 'Project Alpha', statusPath: 'D:/Project Alpha/STATUS.md', hasCard: true,
  state: '', ask: '', gate: '', next: '', verify: '', updated: '', isStale: false,
  jobs, tasks: [],
})

const snapshot = (jobs: JobFlag[]): Snapshot => ({
  at: Date.parse('2030-01-05T12:00:00Z'), projects: [project(jobs)], blocked: [],
  codex: 'OK', contextPercent: null, error: null,
})

const newer = (id: string, status: string): JobFlag => ({ kind: 'newer', id, status, summary: '' })

test('completed job uses the successful sync wording', () => {
  const before = snapshot([])
  const after = snapshot([newer('done-1', 'completed')])
  expect(diffToasts(before, after)).toEqual(['Project Alpha：執行者 完成（done-1），CARD 待更新'])
  expect(events(before, after)).toEqual([{
    at: after.at, text: 'Project　執行者 完成，待同步', tone: 'blue',
  }])
})

test('failed and cancelled jobs never appear as completed', () => {
  const before = snapshot([])
  const failed = snapshot([newer('fail-1', 'failed')])
  expect(diffToasts(before, failed)).toEqual(['Project Alpha：執行者 失敗（fail-1），請檢查任務'])
  expect(events(before, failed)).toEqual([{
    at: failed.at, text: 'Project　執行者 失敗，請檢查', tone: 'red',
  }])

  const cancelled = snapshot([newer('cancel-1', 'cancelled')])
  expect(diffToasts(before, cancelled)).toEqual(['Project Alpha：執行者 已取消（cancel-1）'])
  expect(events(before, cancelled)).toEqual([{
    at: cancelled.at, text: 'Project　執行者 已取消', tone: 'red',
  }])
  const unknown = taskMeta({ id: 'unknown', status: '?', title: '', model: '', effort: '' }, before.at)
  expect(unknown.icon).toBe('?')
  expect(unknown.tone).toBe('dim')
})
