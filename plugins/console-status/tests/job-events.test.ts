import { expect, test } from 'claude-code/testing'

import type { JobFlag, Project, Snapshot } from '../types'
import { diffToasts, events, jobFlags, taskMeta } from '../hooks/logic'

const project = (jobs: JobFlag[]): Project => ({
  name: 'Project Alpha', statusPath: 'D:/Project Alpha/STATUS.md', hasCard: true,
  state: '', ask: '', gate: '', next: '', verify: '', updated: '', isStale: false,
  jobs, tasks: [],
})

const snapshot = (jobs: JobFlag[]): Snapshot => ({
  at: Date.parse('2030-01-05T12:00:00Z'), projects: [project(jobs)], blocked: [],
  codex: 'OK', contextPercent: null, error: null,
})

const newer = (id: string, status: string, executor?: 'claude' | 'codex'): JobFlag => ({ kind: 'newer', id, status, summary: '', executor })

const produced = (id: string, status: string, executor?: 'claude' | 'codex') => jobFlags([{
  id,
  jobClass: 'task',
  status,
  executor,
  completedAt: '2030-01-05T11:00:00Z',
}], Date.parse('2030-01-05T10:00:00Z'))

test('completed jobs preserve their producer and name Codex or Claude in the feed', () => {
  const before = snapshot([])
  const codex = produced('done-codex', 'completed', 'codex')
  const claude = produced('done-claude', 'completed', 'claude')
  expect(codex[0].executor).toBe('codex')
  expect(claude[0].executor).toBe('claude')
  expect(events(before, snapshot(codex))[0].text).toBe('Project　Codex 完成，待同步')
  expect(events(before, snapshot(claude))[0].text).toBe('Project　Claude 完成，待同步')
})

test('a completed job without an executor keeps the sensible generic fallback', () => {
  const before = snapshot([])
  const after = snapshot(produced('done-unknown', 'completed'))
  expect(diffToasts(before, after)).toEqual(['Project Alpha：執行者 完成（done-unknown），CARD 待更新'])
  expect(events(before, after)).toEqual([{ at: after.at, text: 'Project　執行者 完成，待同步', tone: 'blue' }])
})

test('failed and cancelled jobs never appear as completed', () => {
  const before = snapshot([])
  const failed = snapshot([newer('fail-1', 'failed', 'codex')])
  expect(diffToasts(before, failed)).toEqual(['Project Alpha：執行者 失敗（fail-1），請檢查任務'])
  expect(events(before, failed)).toEqual([{
    at: failed.at, text: 'Project　Codex 失敗，請檢查', tone: 'red',
  }])

  const cancelled = snapshot([newer('cancel-1', 'cancelled', 'claude')])
  expect(diffToasts(before, cancelled)).toEqual(['Project Alpha：執行者 已取消（cancel-1）'])
  expect(events(before, cancelled)).toEqual([{
    at: cancelled.at, text: 'Project　Claude 已取消', tone: 'red',
  }])
  const unknown = taskMeta({ id: 'unknown', status: '?', title: '', model: '', effort: '' }, before.at)
  expect(unknown.icon).toBe('?')
  expect(unknown.tone).toBe('dim')
})
