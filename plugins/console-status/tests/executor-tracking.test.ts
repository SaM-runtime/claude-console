import { expect, test } from 'claude-code/testing'

import { createExecutor } from '../hooks/executors'
import { actionKinds, askingSession, dispatchPrompt, freshSession } from '../hooks/actions'
import { buildProject, isActiveJob, parseCard, parseRegistry, rows } from '../hooks/logic'

type RunResult = { exitCode: number; stdout: string; stderr: string }
const NOW = Date.parse('2030-01-05T12:00:00Z')
const NAME0 = `console-${NOW.toString(36)}-0`
const OLD = '11111111-2222-4333-8444-555555555555'
const NEW = '66666666-7777-4888-8999-000000000000'
const ROOT = 'd:/project alpha'
const CONFIG = { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' }
const reply = (agents: unknown[]): RunResult => ({ exitCode: 0, stdout: JSON.stringify(agents), stderr: '' })
const launched = (id: string): RunResult => ({ exitCode: 0, stdout: id, stderr: '' })

/** An agent the daemon retired: still listed, but with neither a process id nor a live status (seen 2026-10-07). */
const retired = (sessionId: string, state = 'blocked') => ({ id: sessionId.slice(0, 8), name: 'console-old-0', sessionId, cwd: 'D:/Project Alpha', kind: 'background', state, startedAt: NOW - 3 * 3_600_000 })
/** A live agent: it has a process and reports a status. */
const live = (sessionId: string, status: string, state: string) => ({ ...retired(sessionId, state), pid: 4321, status })
/** The new session a `--resume` launch came back as. */
const resumed = (sessionId: string) => ({ id: sessionId.slice(0, 8), name: NAME0, sessionId, cwd: 'D:/Project Alpha', kind: 'background', state: 'working', status: 'busy', pid: 999, startedAt: NOW })

function harness(state: unknown) {
  const files: Record<string, string> = { 'D:/claude.json': JSON.stringify(state) }
  const calls: (readonly string[])[] = []
  const replies: RunResult[] = []
  return {
    files, calls, replies,
    saved: () => JSON.parse(files['D:/claude.json']).roots[ROOT],
    deps: {
      run: async (argv: readonly string[]) => { calls.push(argv); return replies.shift() ?? { exitCode: 0, stdout: '', stderr: '' } },
      files: {
        list: async () => [],
        read: async (path: string) => { if (!(path in files)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' }); return files[path] },
        write: async (path: string, text: string) => { files[path] = text },
      },
      now: () => NOW,
    },
  }
}
const owned = (jobs: unknown[] = []) => ({ version: 1, roots: { [ROOT]: { root: 'D:/Project Alpha', sessionId: OLD, jobs } } })
async function errorOf(work: () => Promise<unknown>): Promise<string> {
  try { await work(); return '' } catch (error) { return String(error) }
}
const launches = (calls: (readonly string[])[]) => calls.filter(argv => argv.includes('--bg'))

// A: a retired agent does not block dispatch; a live one at work does.
test('A: the project session the daemon retired (blocked, no pid, no status) does not block dispatch', async () => {
  const h = harness(owned())
  h.replies.push(reply([retired(OLD)]), launched('66666666'), reply([retired(OLD), resumed(NEW)]))
  const executor = createExecutor('claude', h.deps, CONFIG)
  expect(await errorOf(() => executor.dispatch('D:/Project Alpha', 'next', {}))).toBe('')
  expect(launches(h.calls).length).toBe(1)
})

test('A: the project session still working (pid, busy) blocks dispatch as before', async () => {
  const h = harness(owned())
  h.replies.push(reply([live(OLD, 'busy', 'working')]))
  const executor = createExecutor('claude', h.deps, CONFIG)
  expect(await errorOf(() => executor.dispatch('D:/Project Alpha', 'next', {}))).toMatch(/already active/i)
  expect(launches(h.calls).length).toBe(0)
})

test('A: a running job whose agent the daemon retired is finished at the next look, and no longer active', async () => {
  const h = harness(owned([{ id: 'old-launch', nativeId: OLD.slice(0, 8), launchName: 'console-old-0', sessionId: OLD, root: 'D:/Project Alpha', prompt: 'work', startedAt: new Date(NOW - 3 * 3_600_000).toISOString(), status: 'running', phase: 'blocked' }]))
  h.replies.push(reply([retired(OLD)]))
  const [job] = await createExecutor('claude', h.deps, CONFIG).listJobs('D:/Project Alpha')
  expect(job.status).toBe('completed')
  expect(job.completedAt).toBe(new Date(NOW).toISOString())
  expect(isActiveJob(job)).toBe(false)
})

// B: a resume that comes back as a new session moves the project to it unless the original still lives.
test('B: resuming a retired session that comes back as a new one moves the project to the new session, without a warning', async () => {
  const h = harness(owned())
  h.replies.push(reply([retired(OLD)]), launched('66666666'), reply([retired(OLD), resumed(NEW)]))
  const executor = createExecutor('claude', h.deps, CONFIG)
  const job = await executor.dispatch('D:/Project Alpha', 'next', {})
  expect(launches(h.calls)[0]).toContain('--resume')
  expect(job.sessionId).toBe(NEW)
  expect(job.unmanagedSessionId).toBeUndefined()
  expect(job.warning).toBeUndefined()
  expect(h.saved().sessionId).toBe(NEW)
  expect(h.saved().jobs[0].sessionId).toBe(NEW)
})

test('B: a session no longer listed at all is replaced the same way', async () => {
  const h = harness(owned())
  h.replies.push(reply([]), launched('66666666'), reply([resumed(NEW)]))
  const job = await createExecutor('claude', h.deps, CONFIG).dispatch('D:/Project Alpha', 'next', {})
  expect(job.sessionId).toBe(NEW)
  expect(h.saved().sessionId).toBe(NEW)
})

test('B: while the original session is at work, the new one is a copy and the project keeps its session', async () => {
  const h = harness(owned())
  const original = { ...live(OLD, 'idle', 'blocked'), startedAt: NOW - 10 * 60_000 }
  // Idle when the dispatch looked (or it would refuse), at work again by the time the launch is confirmed.
  h.replies.push(reply([original]), launched('66666666'), reply([{ ...original, status: 'busy', state: 'working' }, resumed(NEW)]))
  expect(await errorOf(() => createExecutor('claude', h.deps, CONFIG).dispatch('D:/Project Alpha', 'next', {}))).toMatch(/unmanaged/i)
  expect(h.saved().sessionId).toBe(OLD)
  expect(h.saved().jobs[0].unmanagedSessionId).toBe(NEW)
})

test('B: a launch confirmed late moves the project to its new session once the original is gone', async () => {
  const h = harness(owned([{ id: 'pending', launchName: NAME0, sessionId: OLD, root: 'D:/Project Alpha', prompt: 'next', startedAt: new Date(NOW).toISOString(), status: 'running', phase: 'unknown' }]))
  h.replies.push(reply([retired(OLD), resumed(NEW)]))
  const [job] = await createExecutor('claude', h.deps, CONFIG).listJobs('D:/Project Alpha')
  expect(job.sessionId).toBe(NEW)
  expect(job.unmanagedSessionId).toBeUndefined()
  expect(job.warning).toBeUndefined()
  expect(h.saved().sessionId).toBe(NEW)
})

// E: an independent review starts without the project's memory and never becomes its session.
test('E: a fresh launch does not resume, and leaves the project session where it was', async () => {
  const h = harness(owned())
  h.replies.push(reply([retired(OLD)]), launched('66666666'), reply([retired(OLD), resumed(NEW)]))
  const executor = createExecutor('claude', h.deps, CONFIG)
  const job = await executor.dispatch('D:/Project Alpha', 'review', { fresh: true })
  expect(launches(h.calls)[0]).not.toContain('--resume')
  expect(job.sessionId).toBe(NEW)
  expect(h.saved().sessionId).toBe(OLD)
  h.replies.push(reply([retired(OLD), resumed(NEW)]))
  await executor.listJobs('D:/Project Alpha')
  expect(h.saved().sessionId).toBe(OLD)
})

test('E: a next step that names a review task gets a fresh session; other work resumes', () => {
  const p = (next: string) => buildProject({ name: 'Project Alpha', statusPath: 'D:/Project Alpha/.console/STATUS.md' }, `<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 下一步：${next}\n<!-- /CARD -->`, [], NOW)
  expect(freshSession(p('.task/review-per-model-limits.md（只審新 hunk）'))).toBe(true)
  expect(freshSession(p('.task\\review-gate.md'))).toBe(true)
  expect(freshSession(p('照 .task/fable-usage.md 做'))).toBe(false)
  expect(freshSession(p('無'))).toBe(false)
})

// C, D, E: the continue prompt says how to end a turn, when to set a gate, and which rev counts.
test('C/D/E: the continue prompt ends the turn at a gate, holds the review gate until a review ran, and reads the rev afresh', () => {
  const p = buildProject({ name: 'Project Alpha', statusPath: 'D:/Project Alpha/.console/STATUS.md' }, '<!-- CARD -->\n- 下一步：x\n<!-- /CARD -->', [], NOW)
  const text = dispatchPrompt(p, 'continue')
  expect(text.startsWith('依 STATUS CARD 的下一步繼續；遵守任務骨架；結束時更新 CARD（含關卡欄）\n')).toBe(true)
  expect(text).toContain('先重讀 CARD，以這次讀到的 rev 為準')
  expect(text).toContain('獨立審核還沒跑完：關卡留 無')
  expect(text).toContain('結束這一輪，不要提問等待')
  expect(dispatchPrompt(p, 'sync')).not.toContain('獨立審核')
})

// C: a finished job that stopped to ask is something to act on, not a quiet sync.
test('C: a finished Claude job that ended asking the user shows as ACTION and still offers sync', () => {
  const asking = buildProject({ name: 'Project Alpha', statusPath: 'D:/Project Alpha/.console/STATUS.md' }, '<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：無\n- 下一步：無\n<!-- /CARD -->',
    [{ id: 'j1', executor: 'claude', jobClass: 'task', status: 'completed', phase: 'idle: 等你回覆', startedAt: '2030-01-05T09:00:00Z', completedAt: '2030-01-05T10:00:00Z', summary: 'work' }], NOW)
  const row = rows({ at: NOW, projects: [asking], blocked: [], codex: '', contextPercent: null, error: null })[0]
  expect(row.state).toBe('ACTION')
  expect(row.item).toContain('執行者在等你回覆')
  expect(actionKinds(asking, 'ACTION')).toContain('sync')
  expect(actionKinds(asking, 'ACTION')).not.toContain('decide')
  const quiet = { ...asking, jobs: asking.jobs.map(j => ({ ...j, asks: false })) }
  expect(rows({ at: NOW, projects: [quiet], blocked: [], codex: '', contextPercent: null, error: null })[0].state).toBe('SYNC')
})

// F: CRLF STATUS and registry files read the same as LF ones.
test('F: a CARD and a registry written with CRLF line ends parse like LF ones', () => {
  const lf = '<!-- CARD -->\n- 更新：2026-10-07 20:10 · rev 13\n- 狀態：ok\n- 下一步：做事\n- 關卡：無\n<!-- /CARD -->\n'
  const crlf = lf.replace(/\n/g, '\r\n')
  expect(parseCard(crlf)).toEqual(parseCard(lf))
  expect(parseCard(crlf)?.['更新']).toBe('2026-10-07 20:10 · rev 13')
  expect(buildProject({ name: 'A', statusPath: 'x' }, crlf, [], NOW).updated).toBe('2026-10-07 20:10 · rev 13')
  const registry = '# R\n\n## STATUS 卡位置\n\n| Project | STATUS path | Executor |\n| --- | --- | --- |\n| Alpha | `D:\\a\\STATUS.md` | codex |\n\n## Other\n'
  expect(parseRegistry(registry.replace(/\n/g, '\r\n'), 'C:/home')).toEqual(parseRegistry(registry, 'C:/home'))
  expect(parseRegistry(registry.replace(/\n/g, '\r\n'), 'C:/home')).toEqual([{ name: 'Alpha', statusPath: 'D:/a/STATUS.md', executor: 'codex' }])
})

// Fixes after review (2026-10-07 22:17): which next step is a review, and which session a sync of an asking row resumes.
const card = (next: string) => `<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：無\n- 下一步：${next}\n<!-- /CARD -->`
const ALPHA = { name: 'Project Alpha', statusPath: 'D:/Project Alpha/.console/STATUS.md' }
const REVIEW = '21111111-2222-4333-8444-555555555555'
/** The session a launch came back as, named as the n-th launch of the root (the suffix counts jobs already stored). */
const resumedAs = (sessionId: string, n: number) => ({ ...resumed(sessionId), name: `console-${NOW.toString(36)}-${n.toString(36)}` })
const askingJob = (sessionId: string, over: Record<string, unknown> = {}) => ({ id: `ask-${sessionId.slice(0, 4)}`, launchName: 'console-old-0', nativeId: sessionId.slice(0, 8), sessionId, root: 'D:/Project Alpha', prompt: 'work', kind: 'continue', startedAt: new Date(NOW - 3_600_000).toISOString(), completedAt: new Date(NOW - 60_000).toISOString(), status: 'completed', phase: 'idle: 等你回覆', ...over })

test('fix 2: only a next step that starts with the review task path is a review; fixing after a review resumes the work session', () => {
  const p = (next: string) => buildProject(ALPHA, card(next), [], NOW)
  expect(freshSession(p('.task/review-x.md（只審新 hunk）'))).toBe(true)
  expect(freshSession(p('  `.task/review-x.md`'))).toBe(true)
  expect(freshSession(p('依 .task/review-x.md 的意見修正'))).toBe(false)
  expect(freshSession(p('照審核修正 .task/review-x.md 的問題 1、2'))).toBe(false)
  expect(freshSession(p('審核 .task/review-x.md'))).toBe(false)
  expect(freshSession(p('照 .task/review-per-model-limits.md 獨立審核 0.9.1'))).toBe(false)
  expect(freshSession(p('.task/executor-tracking-fixes.md（同一分支接著 5d9499a）'))).toBe(false)
})

test('fix 1a: syncing an asking row resumes the asking session; a new id back means it took over, with no copy warning', async () => {
  const h = harness(owned([askingJob(OLD)]))
  const asking = { ...live(OLD, 'idle', 'blocked'), name: 'console-old-0' }
  h.replies.push(reply([asking]), launched('66666666'), reply([asking, resumedAs(NEW, 1)]))
  const job = await createExecutor('claude', h.deps, CONFIG).dispatch('D:/Project Alpha', 'sync', { kind: 'sync', resumeSession: OLD } as any)
  expect(launches(h.calls)[0]).toEqual(expect.arrayContaining(['--resume', OLD]))
  expect(job.sessionId).toBe(NEW)
  expect(job.warning).toBeUndefined()
  expect(job.unmanagedSessionId).toBeUndefined()
  expect(h.saved().sessionId).toBe(NEW)
})

test('fix 1a: the same takeover holds when the launch is confirmed late, at the next look', async () => {
  const h = harness(owned([askingJob(OLD), { id: 'pending', launchName: NAME0, sessionId: OLD, root: 'D:/Project Alpha', prompt: 'sync', kind: 'sync', startedAt: new Date(NOW).toISOString(), status: 'running', phase: 'unknown' }]))
  h.replies.push(reply([{ ...live(OLD, 'idle', 'blocked'), name: 'console-old-0' }, resumed(NEW)]))
  const jobs = await createExecutor('claude', h.deps, CONFIG).listJobs('D:/Project Alpha')
  const sync = jobs.find(job => job.id === 'pending')!
  expect(sync.sessionId).toBe(NEW)
  expect(sync.warning).toBeUndefined()
  expect(h.saved().sessionId).toBe(NEW)
})

test('fix 3: an independent review that stopped to ask is the session its sync resumes, and the project keeps its work session', async () => {
  const project = buildProject(ALPHA, card('無'), [
    { id: 'work', executor: 'claude', jobClass: 'task', status: 'completed', phase: 'idle', sessionId: OLD, startedAt: '2030-01-05T09:00:00Z', completedAt: '2030-01-05T09:30:00Z', summary: 'work' },
    { id: 'review', executor: 'claude', jobClass: 'task', status: 'completed', phase: 'idle: 等你回覆', sessionId: REVIEW, startedAt: '2030-01-05T10:00:00Z', completedAt: '2030-01-05T10:30:00Z', summary: 'review' },
  ], NOW)
  expect(askingSession(project)).toBe(REVIEW)
  expect(askingSession(buildProject(ALPHA, card('無'), [], NOW))).toBeUndefined()

  const h = harness(owned([askingJob(OLD, { id: 'work', phase: 'idle' }), askingJob(REVIEW, { id: 'review', fresh: true, launchName: 'console-review-0' })]))
  const reviewAgent = { ...live(REVIEW, 'idle', 'blocked'), name: 'console-review-0' }
  h.replies.push(reply([retired(OLD), reviewAgent]), launched('66666666'), reply([retired(OLD), reviewAgent, resumedAs(NEW, 2)]))
  const executor = createExecutor('claude', h.deps, CONFIG)
  const job = await executor.dispatch('D:/Project Alpha', 'sync', { kind: 'sync', resumeSession: REVIEW } as any)
  expect(launches(h.calls)[0]).toEqual(expect.arrayContaining(['--resume', REVIEW]))
  expect(launches(h.calls)[0]).not.toContain(OLD)
  expect(job.sessionId).toBe(NEW)
  expect(job.warning).toBeUndefined()
  expect(h.saved().sessionId).toBe(OLD)
  h.replies.push(reply([retired(OLD), reviewAgent, resumedAs(NEW, 2)]))
  await executor.listJobs('D:/Project Alpha')
  expect(h.saved().sessionId).toBe(OLD)
})

test('fix 1c: while the original session is at work, a resume that comes back as another session is still a copy', async () => {
  const h = harness(owned([askingJob(OLD)]))
  const asking = { ...live(OLD, 'idle', 'blocked'), name: 'console-old-0' }
  const working = { ...live(OLD, 'busy', 'working'), name: 'console-old-0' }
  h.replies.push(reply([asking]), launched('66666666'), reply([working, resumedAs(NEW, 1)]))
  expect(await errorOf(() => createExecutor('claude', h.deps, CONFIG).dispatch('D:/Project Alpha', 'sync', { kind: 'sync', resumeSession: OLD } as any))).toMatch(/unmanaged/i)
  expect(h.saved().sessionId).toBe(OLD)
  expect(h.saved().jobs[1].unmanagedSessionId).toBe(NEW)
})

test('fix: a manual project asking row names only taking over the session, since it has no sync', () => {
  const jobs = [{ id: 'j1', executor: 'claude' as const, jobClass: 'task', status: 'completed', phase: 'idle: 等你回覆', startedAt: '2030-01-05T09:00:00Z', completedAt: '2030-01-05T10:00:00Z', summary: 'work' }]
  const auto = buildProject(ALPHA, card('無'), jobs, NOW)
  const manual = { ...auto, executor: 'manual' as const }
  const item = (p: typeof auto) => rows({ at: NOW, projects: [p], blocked: [], codex: '', contextPercent: null, error: null })[0].item
  expect(item(auto)).toBe('執行者在等你回覆：接手該 session 或同步')
  expect(item(manual)).toBe('執行者在等你回覆：接手該 session')
  expect(actionKinds(manual, 'ACTION')).not.toContain('sync')
})
