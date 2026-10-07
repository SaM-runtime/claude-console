import { expect, test } from 'claude-code/testing'

import type { Project, SyncProgress } from '../types'
import { buildProject, cardWrittenSince, jobFlags } from '../hooks/logic'
import { dispatchKind, dispatchPrompt } from '../hooks/actions'
import { advanceSync, autoSyncJobs, autoSyncMode, bandSync, syncChip, syncStatus, syncStepsText, SYNC_KEEP_MS } from '../hooks/sync'

const NOW = Date.parse('2030-01-05T12:00:00Z')
const local = (iso: string) => {
  const d = new Date(Date.parse(iso))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const cardText = (updated: string) => `<!-- CARD -->\n- 更新：${updated}\n- 等使用者：無\n<!-- /CARD -->`
const project = (updated: string, jobs: any[]): Project => buildProject({ name: 'Project Alpha', statusPath: 'D:/a/STATUS.md' }, cardText(updated), jobs, NOW)

test('a finished job counts as synced once the CARD was written in or after the minute it started', () => {
  const card = Date.parse('2030-01-05T11:20:00Z')
  expect(cardWrittenSince(card, '2030-01-05T11:20:59Z')).toBe(true)
  expect(cardWrittenSince(card, '2030-01-05T11:00:00Z')).toBe(true)
  expect(cardWrittenSince(card, '2030-01-05T11:21:00Z')).toBe(false)
  expect(cardWrittenSince(null, '2030-01-05T11:00:00Z')).toBe(false)
  expect(cardWrittenSince(card, undefined)).toBe(false)
  // Finished 40 s after its own CARD write: not 待同步 any more.
  const job = { id: 'w', jobClass: 'task', executor: 'codex' as const, status: 'completed', startedAt: '2030-01-05T11:00:00Z', completedAt: '2030-01-05T11:20:40Z' }
  expect(jobFlags([job], card)).toEqual([])
  // Never wrote the CARD: still 待同步. A failure still waits for a person whatever the CARD says.
  expect(jobFlags([job], Date.parse('2030-01-05T10:00:00Z'))[0]!.kind).toBe('newer')
  expect(jobFlags([{ ...job, status: 'failed' }], card)[0]!.kind).toBe('newer')
})

test('a Codex sync is known by its prompt and never asks to be synced itself', () => {
  const p = project(local('2030-01-05T10:00:00Z'), [])
  expect(dispatchKind(dispatchPrompt(p, 'sync'))).toBe('sync')
  expect(dispatchKind(dispatchPrompt(p, 'continue'))).toBe('continue')
  expect(dispatchKind('something else')).toBe(undefined)
  const sync = { id: 's', jobClass: 'task', kind: 'sync' as const, executor: 'codex' as const, status: 'completed', startedAt: '2030-01-05T11:00:00Z', completedAt: '2030-01-05T11:30:00Z' }
  expect(jobFlags([sync], Date.parse('2030-01-05T10:00:00Z'))).toEqual([])
})

test('a sync moves from dispatch to running to done, or stops where it failed', () => {
  const cardAt = local('2030-01-05T10:00:00Z')
  const start: SyncProgress = { stage: 'running', at: NOW - 60_000, cardAt, executor: 'codex', jobId: 's', phase: 'queued' }
  const running = project(cardAt, [{ id: 's', jobClass: 'task', executor: 'codex', status: 'running', phase: 'editing', startedAt: '2030-01-05T11:59:00Z' }])
  expect(advanceSync(start, running, NOW)).toEqual({ ...start, phase: 'editing' })
  expect(syncStepsText(start)).toBe('● 派工 ─ ◉ 執行 ─ ○ 寫回 STATUS')
  expect(syncStatus(start, NOW)).toBe('codex 寫回中（queued）・1 分 0 秒')

  const written = project(local('2030-01-05T12:00:00Z'), [{ id: 's', jobClass: 'task', executor: 'codex', status: 'completed', startedAt: '2030-01-05T11:59:00Z', completedAt: '2030-01-05T12:00:30Z' }])
  const done = advanceSync(start, written, NOW)!
  expect(done.stage).toBe('done')
  expect(syncStepsText(done)).toBe('● 派工 ─ ● 執行 ─ ● 寫回 STATUS')
  expect(syncChip(done, NOW, false)).toEqual({ text: '↻ 同步完成', tone: 'green' })
  // Shown for a while after it ends, then dropped.
  expect(advanceSync(done, written, NOW + SYNC_KEEP_MS)).toEqual(done)
  expect(advanceSync(done, written, NOW + SYNC_KEEP_MS + 1)).toBe(null)

  const untouched = project(cardAt, [{ id: 's', jobClass: 'task', executor: 'codex', status: 'completed', startedAt: '2030-01-05T11:59:00Z', completedAt: '2030-01-05T12:00:30Z' }])
  const unchanged = advanceSync(start, untouched, NOW)!
  expect(unchanged.stage).toBe('unchanged')
  expect(syncStepsText(unchanged)).toBe('● 派工 ─ ● 執行 ─ ✕ 寫回 STATUS')

  const failed = advanceSync(start, project(cardAt, [{ id: 's', jobClass: 'task', executor: 'codex', status: 'failed', startedAt: '2030-01-05T11:59:00Z', completedAt: '2030-01-05T12:00:30Z' }]), NOW)!
  expect(failed.stage).toBe('run-failed')
  expect(syncStepsText(failed)).toBe('● 派工 ─ ✕ 執行 ─ ○ 寫回 STATUS')

  // Codex lists the job a little after accepting it: keep waiting.
  expect(advanceSync(start, project(cardAt, []), NOW)).toEqual(start)
  const dispatching: SyncProgress = { stage: 'dispatch', at: NOW, cardAt }
  expect(syncStepsText(dispatching)).toBe('◉ 派工 ─ ○ 執行 ─ ○ 寫回 STATUS')
  expect(advanceSync({ ...dispatching, stage: 'dispatch-failed', endedAt: NOW, detail: 'x' }, untouched, NOW)!.stage).toBe('dispatch-failed')
  expect(advanceSync(start, undefined, NOW)).toBe(null)
})

test('the band shows the sync under way before one that ended', () => {
  const ended: SyncProgress = { stage: 'done', at: NOW - 5000, endedAt: NOW, cardAt: '' }
  const live: SyncProgress = { stage: 'running', at: NOW - 3000, cardAt: '' }
  expect(bandSync({ a: ended, b: live })).toBe(live)
  expect(bandSync({ a: ended })).toBe(ended)
  expect(bandSync({})).toBe(null)
})

test('auto-sync takes completed work only, and nothing from a manual or busy project', () => {
  const before = local('2030-01-05T10:00:00Z')
  const done = { id: 'w', jobClass: 'task', executor: 'codex', status: 'completed', startedAt: '2030-01-05T11:00:00Z', completedAt: '2030-01-05T11:30:00Z' }
  expect(autoSyncJobs(project(before, [done]))).toEqual(['D:/a/STATUS.md\u0000codex:w'])
  expect(autoSyncJobs(project(before, [{ ...done, status: 'failed' }]))).toEqual([])
  expect(autoSyncJobs({ ...project(before, [done]), executor: 'manual' })).toEqual([])
  expect(autoSyncJobs(project(before, [done, { id: 'r', jobClass: 'task', executor: 'codex', status: 'running', startedAt: '2030-01-05T11:50:00Z' }]))).toEqual([])
  expect(autoSyncMode(undefined)).toBe('on')
  expect(autoSyncMode(' OFF ')).toBe('off')
})
