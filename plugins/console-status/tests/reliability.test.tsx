import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import type { Project } from '../types'
import { buildProject, cardRunningJob } from '../hooks/logic'
import { actionKinds, newJobTag, withJobTag } from '../hooks/actions'
import { autoSyncJobs, autoSyncPlan, AUTO_SYNC_GRACE_MS } from '../hooks/sync'
import { endsAsking } from '../hooks/executors'
import { claim, claimBlocker, heartbeat, leave, parseLease, syncsHere, ALIVE_MS, CLAIM_MS } from '../hooks/lease'

const T = (iso: string) => Date.parse(iso)
const NOW = T('2030-01-05T12:00:00Z')
const local = (iso: string) => {
  const d = new Date(Date.parse(iso))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const cardText = (updated: string, extra = '') => `<!-- CARD -->\n- 更新：${updated}\n- 等使用者：無\n${extra}<!-- /CARD -->`
const project = (text: string, jobs: any[], mtime?: number): Project => buildProject({ name: 'Project Alpha', statusPath: 'D:/a/STATUS.md' }, text, jobs, NOW, mtime)

// --- B1: auto-sync never runs under a reply, and waits a moment after a job ends ---

test('a finished job that asks the user is not auto-synced', () => {
  const before = local('2030-01-05T10:00:00Z')
  const asking = { id: 'w', jobClass: 'task', executor: 'codex', status: 'completed', phase: 'idle: 等你回覆', startedAt: '2030-01-05T11:00:00Z', completedAt: '2030-01-05T11:30:00Z' }
  expect(project(cardText(before), [asking]).jobs[0]!.asks).toBe(true)
  expect(autoSyncJobs(project(cardText(before), [asking]))).toEqual([])
  expect(autoSyncPlan(project(cardText(before), [asking]), NOW)).toEqual({ ready: [], waiting: false, dropped: [] })
})

test('auto-sync waits out the grace after a job ends, then takes it', () => {
  const before = local('2030-01-05T10:00:00Z')
  const ended = new Date(NOW - 20_000).toISOString()
  const done = { id: 'w', jobClass: 'task', executor: 'codex', status: 'completed', startedAt: '2030-01-05T11:00:00Z', completedAt: ended }
  expect(autoSyncPlan(project(cardText(before), [done]), NOW)).toEqual({ ready: [], waiting: true, dropped: [] })
  expect(autoSyncPlan(project(cardText(before), [done]), NOW - 20_000 + AUTO_SYNC_GRACE_MS)).toEqual({ ready: ['D:/a/STATUS.md\u0000codex:w'], waiting: false, dropped: [] })
})

test('new work started inside the grace drops the auto-sync for good', () => {
  const before = local('2030-01-05T10:00:00Z')
  const done = { id: 'w', jobClass: 'task', executor: 'codex', status: 'completed', startedAt: '2030-01-05T11:00:00Z', completedAt: new Date(NOW - 10_000).toISOString() }
  const resumed = { id: 'r', jobClass: 'task', executor: 'codex', status: 'running', startedAt: new Date(NOW - 5_000).toISOString() }
  expect(autoSyncPlan(project(cardText(before), [done, resumed]), NOW)).toEqual({ ready: [], waiting: false, dropped: ['D:/a/STATUS.md\u0000codex:w'] })
  expect(autoSyncPlan({ ...project(cardText(before), [done, resumed]), executor: 'manual' }, NOW)).toEqual({ ready: [], waiting: false, dropped: [] })
})

test('a Codex turn that ends on a question or a request for permission asks the user', () => {
  expect(endsAsking('要我直接改 package.json 嗎？')).toBe(true)
  expect(endsAsking('Should I push the branch now?')).toBe(true)
  expect(endsAsking('請授權我執行 npm install，才能繼續。')).toBe(true)
  expect(endsAsking('I need your approval to delete the old fixtures.')).toBe(true)
  expect(endsAsking('已完成，測試全過。')).toBe(false)
  expect(endsAsking('No permission changes were needed.')).toBe(false)
  expect(endsAsking('不需要你處理，已寫回 CARD。')).toBe(false)
  expect(endsAsking('')).toBe(false)
})

// --- A1: the CARD names the job that wrote it ---

test('each dispatch gets its own short code, written last in its prompt', () => {
  const tag = newJobTag(NOW, () => 0.5)
  expect(tag).toMatch(/^c-[0-9a-z]{6}$/)
  expect(newJobTag(NOW, () => 0.1)).not.toBe(tag)
  const prompt = withJobTag('依 STATUS CARD 的下一步繼續', tag)
  expect(prompt.startsWith('依 STATUS CARD 的下一步繼續')).toBe(true)
  expect(prompt.endsWith(`這次工作的代號是 ${tag}：更新欄的 job 寫 ${tag}；執行中 欄若要填，填 ${tag}，寫回結果時改成 無。`)).toBe(true)
})

test('a CARD still saying a finished job is running was written at its start, not with its result', () => {
  const job = { id: 'task-abc123', tag: 'c-k3f9a2', jobClass: 'task', executor: 'codex', status: 'completed', startedAt: '2030-01-05T11:00:00Z', completedAt: '2030-01-05T11:30:00Z' }
  const atStart = local('2030-01-05T11:01:00Z')
  expect(cardRunningJob('c-k3f9a2')).toBe('c-k3f9a2')
  expect(cardRunningJob('無')).toBe('')
  // Written once, a minute after the start, with 執行中 naming the job: still 待同步.
  expect(project(cardText(atStart, '- 執行中：c-k3f9a2\n'), [job]).jobs[0]!.kind).toBe('newer')
  // The same write with 執行中 cleared is the result.
  expect(project(cardText(atStart, '- 執行中：無\n'), [job]).jobs).toEqual([])
  // 更新 naming the code is the result, whatever its time says.
  expect(project(cardText(`${local('2030-01-05T10:00:00Z')} · rev 4 · job c-k3f9a2`), [job]).jobs).toEqual([])
  // Another job's code in 執行中 says nothing about this one.
  expect(project(cardText(atStart, '- 執行中：c-other1\n'), [job]).jobs).toEqual([])
})

// --- A2: no decision while an executor may be writing the CARD ---

test('做決定 is locked while the project has a job running', () => {
  const asks = (jobs: any[]) => buildProject({ name: 'A', statusPath: 'D:/a/STATUS.md' }, `<!-- CARD -->\n- 更新：${local('2030-01-05T11:00:00Z')}\n- 等使用者：1) A 或 B\n<!-- /CARD -->`, jobs, NOW)
  expect(actionKinds(asks([]), 'ACTION')).toContain('decide')
  const running = { id: 'r', jobClass: 'task', executor: 'codex', status: 'running', startedAt: '2030-01-05T11:50:00Z' }
  expect(actionKinds(asks([running]), 'ACTION')).not.toContain('decide')
})

// --- Consoles side by side: per project, not one console for all ---

test('the lease keeps live consoles and their claims, and holds a project only while its dispatch is fresh', () => {
  expect(parseLease('{"sessionId":"old","at":5}')).toEqual({ consoles: {}, projects: {} })
  expect(parseLease(null)).toEqual({ consoles: {}, projects: {} })
  let lease = heartbeat({ consoles: { gone: NOW - ALIVE_MS - 1, b: NOW - 1000 }, projects: { 'P/x': { sessionId: 'gone', at: NOW - 1000 } } }, 'a', NOW)
  expect(lease).toEqual({ consoles: { b: NOW - 1000, a: NOW }, projects: {} })
  lease = claim(lease, 'b', 'P/y', NOW - 1000)
  expect(claimBlocker(lease, 'a', 'P/y', NOW)).toBe('b')
  expect(claimBlocker(lease, 'b', 'P/y', NOW)).toBe(null)
  expect(claimBlocker(lease, 'a', 'P/z', NOW)).toBe(null)
  expect(claimBlocker(lease, 'a', 'P/y', NOW - 1000 + CLAIM_MS)).toBe(null)
  // Auto-sync belongs to the dispatcher while it lives.
  expect(syncsHere(lease, 'a', 'P/y', NOW)).toBe(false)
  expect(syncsHere(lease, 'b', 'P/y', NOW)).toBe(true)
  expect(syncsHere(lease, 'a', 'P/z', NOW)).toBe(true)
  expect(syncsHere(lease, 'a', 'P/y', NOW + ALIVE_MS)).toBe(true)
  expect(leave(lease, 'b')).toEqual({ consoles: { a: NOW }, projects: {} })
})

// --- UI: activation always, the dispatch lease, and the job code on a real dispatch ---

const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const STATE = 'D:/State/Project Alpha-hash/state.json'
const SESSIONS = 'C:/Users/example/.claude/handoffs/claude-sessions.json'
const WORKER = '11111111-2222-4333-8444-555555555555'
const LEASE = 'C:/Users/example/.claude/handoffs/console-lease.json'
const BASE = { activation: 'always', autoSync: 'off', gitProbe: 'off', executor: 'codex', registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/companion.mjs', companionStateRoots: '["D:/State"]' }
const IDLE_CARD = `<!-- CARD -->\n- 更新：2030-01-05 11:40\n- 狀態：進行中\n- 等使用者：無\n- 下一步：實作登入頁\n- 關卡：無\n<!-- /CARD -->`

function harness(on: any, sessionId = 'console-session') {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/.console/STATUS.md` |',
    [STATUS]: IDLE_CARD,
    'C:/Users/example/.claude/handoffs/dispatch.json': JSON.stringify({ executor: 'codex', model: '', effort: '' }),
    [SESSIONS]: JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: WORKER, jobs: [{ id: 'console-old:abcd1234', launchName: 'console-old', sessionId: WORKER, root: 'D:/Project Alpha', prompt: 'work', kind: 'continue', startedAt: '2030-01-01T08:00:00Z', completedAt: '2030-01-01T09:00:00Z', status: 'completed', phase: 'idle' }] } } }),
  }
  const state = { jobs: [] as any[] }
  const launches: string[][] = []
  const toasts: string[] = []
  const data = { session: sessionId, claudeAgents: 0 }
  on('fs.stat', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in files)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
    return { value: { size: files[path]!.length, mtimeMs: T('2030-01-05T03:40:00Z') } }
  })
  on('fs.exists', (_: any, e: any) => ({ value: fixturePath(e.path) in files }))
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (path === STATE) return { value: JSON.stringify(state) }
    if (!(path in files) && path === LEASE) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
    return { value: files[path] ?? '' }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', (_: any, e: any) => ({ value: fixturePath(e.path) === 'D:/State' ? [{ name: 'Project Alpha-hash', kind: 'dir' }] : [] }))
  on('process.run', (_: any, e: any) => {
    let stdout = e.argv[0] === 'claude' ? '[]' : 'OK codex=0.0.0-test'
    if (e.argv[0] === 'claude' && e.argv[1] === 'agents') data.claudeAgents += 1
    if (e.argv[0] === 'node' && e.argv.includes('task')) {
      launches.push([...e.argv])
      const id = `task-${launches.length}`
      state.jobs = [...state.jobs, { id, jobClass: 'task', status: 'running', startedAt: '2030-01-05T11:59:00Z', request: { prompt: e.argv.at(-1) } }]
      stdout = JSON.stringify({ jobId: id })
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: data.session }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  return { files, state, launches, toasts, data, clock }
}

const START = { cwd: 'D:/Elsewhere', surface: 'terminal', isInteractive: true } as any

test('activation always leaves out non-interactive sessions and the executors the console dispatched', { options: BASE }, async ($, on) => {
  const h = harness(on, WORKER)
  await $.session.start(START)
  await h.clock.settle()
  const lease = () => h.files[LEASE]
  // The executor session the console dispatched: guard only, no console (no lease, no polling).
  expect(lease()).toBeUndefined()
  h.data.session = 'some-pipe'
  await $.session.start({ ...START, surface: null, isInteractive: false })
  await h.clock.settle()
  expect(lease()).toBeUndefined()
  // The person's own session runs the console.
  h.data.session = 'console-session'
  await $.session.start(START)
  await h.clock.settle()
  expect(Object.keys(JSON.parse(lease()!).consoles)).toEqual(['console-session'])
})

test('any console dispatches; a project another live console dispatched moments ago waits for that job', { options: BASE }, async ($, on) => {
  const h = harness(on)
  const STATUS_KEY = 'D:/Project Alpha/.console/STATUS.md'
  // Another console is alive and dispatched a different project: nothing here is held.
  h.files[LEASE] = JSON.stringify({ consoles: { 'other-console-1234': NOW - 30_000 }, projects: { 'D:/Beta/STATUS.md': { sessionId: 'other-console-1234', at: NOW - 10_000 } } })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const after = JSON.parse(h.files[LEASE]!)
  expect(Object.keys(after.consoles).sort()).toEqual(['console-session', 'other-console-1234'])
  // It dispatched this project 10 s ago: its job may not show yet, so this console waits.
  h.files[LEASE] = JSON.stringify({ ...after, projects: { [STATUS_KEY]: { sessionId: 'other-console-1234', at: NOW - 10_000 } } })
  await $.command.run({ command: 'console', args: 'continue Project Alpha' } as any)
  expect(h.launches).toEqual([])
  expect(h.toasts.some(text => text.includes('另一個主控台（session other-co）剛對這個專案派工'))).toBe(true)
  // Older than the claim window: the same project is free again, and this console records the dispatch.
  h.files[LEASE] = JSON.stringify({ ...after, projects: { [STATUS_KEY]: { sessionId: 'other-console-1234', at: NOW - 5 * 60_000 } } })
  await $.command.run({ command: 'console', args: 'continue Project Alpha' } as any)
  expect(h.launches.length).toBe(1)
  expect(JSON.parse(h.files[LEASE]!).projects[STATUS_KEY].sessionId).toBe('console-session')
  // The prompt carries this dispatch's code.
  expect(h.launches[0]!.at(-1)!.match(/這次工作的代號是 (c-[0-9a-z]{6})/)?.[1]).toBeDefined()
  // /console off takes this console and its claims out at once.
  await $.command.run({ command: 'console', args: 'off' } as any)
  await h.clock.settle()
  const left = JSON.parse(h.files[LEASE]!)
  expect(left.consoles['console-session']).toBeUndefined()
  expect(left.projects[STATUS_KEY]).toBeUndefined()
})
