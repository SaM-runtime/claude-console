import { expect, test } from 'claude-code/testing'

import { claudeArgs, codexArgs, createExecutor } from '../hooks/executors'
import { buildProject, isActiveJob, jobFlags, rows } from '../hooks/logic'

type RunResult = { exitCode: number; stdout: string; stderr: string }
const NOW = Date.parse('2030-01-05T12:00:00Z')
const NAME0 = `console-${NOW.toString(36)}-0`
const NAME1 = `console-${NOW.toString(36)}-1`

function harness(initial: Record<string, string> = {}) {
  const files = { ...initial }
  const calls: { argv: readonly string[]; init?: { cwd?: string; timeoutMs?: number } }[] = []
  const writes: { path: string; text: string }[] = []
  const replies: RunResult[] = []
  return {
    files, calls, writes, replies,
    deps: {
      run: async (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => {
        calls.push({ argv, init })
        return replies.shift() ?? { exitCode: 0, stdout: '', stderr: '' }
      },
      files: {
        list: async () => [],
        read: async (path: string) => {
          if (!(path in files)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
          return files[path]
        },
        write: async (path: string, text: string) => {
          writes.push({ path, text })
          files[path] = text
        },
      },
      now: () => NOW,
    },
  }
}

async function errorOf(work: () => Promise<unknown>): Promise<string> {
  try { await work(); return '' } catch (error) { return String(error) }
}

function rowState(jobs: any[]): string {
  const project = buildProject({ name: 'Project Alpha', statusPath: 'D:/Project Alpha/.console/STATUS.md' }, '<!-- CARD -->\n- 更新：2030-01-05 10:00\n- 狀態：進行中\n- 等使用者：無\n<!-- /CARD -->', jobs, NOW)
  return rows({ at: NOW, projects: [project], blocked: [], codex: '', contextPercent: null, error: null })[0].state
}

test('executor argv builders keep the two command contracts separate', () => {
  expect(codexArgs('D:/Work/Project Alpha', 'do work', { companionScript: 'D:/Tools/companion.mjs' }, { model: 'gpt-example', effort: 'high' })).toEqual([
    'node', 'D:/Tools/companion.mjs', 'task', '--background', '--write', '--resume-last', '--cwd', 'D:/Work/Project Alpha', '--json',
    '--model', 'gpt-example', '--effort', 'high', 'do work',
  ])
  expect(claudeArgs('D:/Work/Project Alpha', 'do work', { model: 'sonnet', effort: '' })).toEqual([
    'claude', '--bg', '--model', 'sonnet', 'do work',
  ])
  expect(claudeArgs('D:/Work/Project Alpha', 'next', { model: '', effort: 'max' }, '12345678-1234-1234-1234-123456789abc')).toEqual([
    'claude', '--bg', '--resume', '12345678-1234-1234-1234-123456789abc', '--effort', 'max', 'next',
  ])
})

test('codex executor reuses companion jobs, dispatch and log files', async () => {
  const h = harness({
    'D:/State/project alpha-a/state.json': JSON.stringify({ jobs: [{ id: 'old', jobClass: 'task', status: 'running', logFile: 'jobs/old.log' }] }),
    'D:/State/project alpha-a/jobs/old.log': '[12:00] first\nfinal result\n',
  })
  h.deps.files.list = async path => path === 'D:/State' ? [{ name: 'project alpha-a', kind: 'dir' }] : []
  h.replies.push({ exitCode: 0, stdout: '{"jobId":"new-job"}', stderr: '' })
  const executor = createExecutor('codex', h.deps, { companionScript: 'D:/companion.mjs', companionStateRoots: ['D:/State'], claudeSessionsPath: 'D:/claude.json' })
  const [old] = await executor.listJobs('D:/Project Alpha')
  expect(old.executor).toBe('codex')
  expect(await executor.lastLine(old)).toBe('final result')
  expect(rowState([old])).toBe('RUNNING')
  const launched = await executor.dispatch('D:/Project Alpha', 'ship it', { model: '', effort: 'low' })
  expect(launched.id).toBe('new-job')
  expect(launched.executor).toBe('codex')
  expect(h.calls[0]).toEqual({
    argv: ['node', 'D:/companion.mjs', 'task', '--background', '--write', '--resume-last', '--cwd', 'D:/Project Alpha', '--json', '--effort', 'low', 'ship it'],
    init: { cwd: 'D:/Project Alpha', timeoutMs: 60_000 },
  })
  h.files['D:/State/project alpha-a/state.json'] = JSON.stringify({ jobs: [{ id: 'old', executor: 'codex', jobClass: 'task', status: 'completed', completedAt: '2030-01-05T11:00:00.000Z' }] })
  expect(rowState(await executor.listJobs('D:/Project Alpha'))).toBe('SYNC')
})

test('claude dispatch persists starting first, confirms a full session id, then resumes it', async () => {
  const h = harness()
  h.replies.push(
    { exitCode: 0, stdout: '[]', stderr: '' },
    { exitCode: 0, stdout: 'Background session started: abc12345', stderr: '' },
    { exitCode: 0, stdout: JSON.stringify([{ id: 'abc12345', name: NAME0, sessionId: '11111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', kind: 'background', startedAt: NOW, status: 'idle', state: 'done' }]), stderr: '' },
  )
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  const job = await executor.dispatch('D:\\Project Alpha', 'first task', { model: 'sonnet', effort: 'high' })
  expect(job.id).toBe(`${NAME0}:abc12345`)
  expect(job.executor).toBe('claude')
  expect(job.status).toBe('completed')
  expect(h.calls.map(call => call.argv)).toEqual([
    ['claude', 'agents', '--json', '--all', '--cwd', 'D:/Project Alpha'],
    ['claude', '--bg', '--name', NAME0, '--model', 'sonnet', '--effort', 'high', 'first task'],
    ['claude', 'agents', '--json', '--all', '--cwd', 'D:/Project Alpha'],
  ])
  expect(JSON.parse(h.writes[0].text).roots['d:/project alpha'].jobs[0].phase).toBe('starting')
  expect(JSON.parse(h.files['D:/claude.json']).roots['d:/project alpha'].sessionId).toBe('11111111-2222-4333-8444-555555555555')

  h.replies.push(
    { exitCode: 0, stdout: '[]', stderr: '' },
    { exitCode: 0, stdout: 'def67890', stderr: '' },
    { exitCode: 0, stdout: JSON.stringify([{ id: 'def67890', name: NAME1, sessionId: '11111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', kind: 'background', status: 'busy', state: 'working' }]), stderr: '' },
  )
  await executor.dispatch('D:/Project Alpha', 'second task', { model: '', effort: '' })
  expect(h.calls[4].argv).toEqual(['claude', '--bg', '--name', NAME1, '--resume', '11111111-2222-4333-8444-555555555555', 'second task'])
})

test('claude blocks a duplicate when the owned session is active or a launch is unresolved', async () => {
  const state = JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: '11111111-2222-4333-8444-555555555555', jobs: [{ id: 'abc12345', sessionId: '11111111-2222-4333-8444-555555555555', root: 'D:/Project Alpha', prompt: 'work', startedAt: '2030-01-05T11:00:00.000Z', status: 'running', phase: 'working' }] } } })
  const h = harness({ 'D:/claude.json': state })
  h.replies.push({ exitCode: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: '11111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', status: 'waiting', state: 'blocked', waitingFor: 'approval' }]), stderr: '' })
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  expect(await errorOf(() => executor.dispatch('D:/Project Alpha', 'duplicate', {}))).toMatch(/already active/i)
  expect(h.calls.length).toBe(1)

  h.files['D:/claude.json'] = JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', jobs: [{ id: 'starting:1', root: 'D:/Project Alpha', prompt: 'unknown', startedAt: '2030-01-05T11:00:00.000Z', status: 'running', phase: 'starting' }] } } })
  h.replies.push({ exitCode: 0, stdout: '[]', stderr: '' })
  expect(await errorOf(() => executor.dispatch('D:/Project Alpha', 'duplicate', {}))).toMatch(/unresolved/i)
  expect(h.calls.length).toBe(2)
})

test('claude jobs map blocked to running and stamp completion only when done is observed', async () => {
  const state = JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', jobs: [
    { id: 'blocked-launch', nativeId: 'blocked01', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', root: 'D:/Project Alpha', prompt: 'needs input', model: 'opus', effort: 'max', startedAt: '2030-01-05T10:00:00.000Z', status: 'running', phase: 'working' },
    { id: 'done-launch', nativeId: 'done0001', sessionId: 'ffffffff-1111-4222-8333-444444444444', root: 'D:/Project Alpha', prompt: 'finished', startedAt: '2030-01-05T09:00:00.000Z', status: 'running', phase: 'working' },
    { id: 'failed-launch', nativeId: 'fail0001', sessionId: '99999999-1111-4222-8333-444444444444', root: 'D:/Project Alpha', prompt: 'failed', startedAt: '2030-01-05T09:30:00.000Z', status: 'running', phase: 'working' },
  ] } } })
  const h = harness({ 'D:/claude.json': state, 'log:blocked01': 'line one\nwaiting for review\n' })
  h.replies.push({ exitCode: 0, stdout: JSON.stringify([
    { id: 'blocked01', sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd: 'D:/Project Alpha', kind: 'background', status: 'waiting', state: 'blocked', waitingFor: 'review' },
    { id: 'done0001', sessionId: 'ffffffff-1111-4222-8333-444444444444', cwd: 'D:/Project Alpha', kind: 'background', status: 'idle', state: 'done' },
    { id: 'fail0001', sessionId: '99999999-1111-4222-8333-444444444444', cwd: 'D:/Project Alpha', kind: 'background', status: 'exited', state: 'failed' },
  ]), stderr: '' })
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  const jobs = await executor.listJobs('D:/Project Alpha')
  expect(jobs.map(job => [job.id, job.status, job.phase])).toEqual([
    ['blocked-launch', 'running', 'blocked: review'],
    ['done-launch', 'completed', 'done'],
    ['failed-launch', 'failed', 'failed'],
  ])
  expect(jobs[0].completedAt).toBe(undefined)
  expect(jobs[1].completedAt).toBe('2030-01-05T12:00:00.000Z')
  expect(jobs[2].completedAt).toBe('2030-01-05T12:00:00.000Z')
  expect(rowState([jobs[0]])).toBe('RUNNING')
  expect(rowState([jobs[1]])).toBe('SYNC')
  expect(rowState([jobs[2]])).toBe('SYNC')
  h.replies.push({ exitCode: 0, stdout: 'waiting\nlatest output\n', stderr: '' })
  expect(await executor.lastLine(jobs[0])).toBe('latest output')
  expect(h.calls[1].argv).toEqual(['claude', 'logs', 'blocked01'])
})

test('ambiguous claude launch is not guessed or silently retried', async () => {
  const h = harness()
  h.replies.push(
    { exitCode: 0, stdout: '[]', stderr: '' },
    { exitCode: 0, stdout: 'Background session started: abc12345', stderr: '' },
    { exitCode: 0, stdout: JSON.stringify([
      { name: NAME0, id: 'abc12345', sessionId: '11111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', kind: 'background', status: 'busy', state: 'working' },
      { name: NAME0, id: 'abc12345', sessionId: '66666666-7777-4888-8999-000000000000', cwd: 'D:/Project Alpha', kind: 'background', status: 'busy', state: 'working' },
    ]), stderr: '' },
  )
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  expect(await errorOf(() => executor.dispatch('D:/Project Alpha', 'work', {}))).toMatch(/could not uniquely confirm/i)
  expect(h.calls.length).toBe(3)
  const saved = JSON.parse(h.files['D:/claude.json'])
  expect(saved.roots['d:/project alpha'].sessionId).toBe(undefined)
  expect(saved.roots['d:/project alpha'].jobs[0].phase).toBe('unknown')
  // Once the native CLI can uniquely identify the named launch, refresh recovers it.
  h.replies.push({ exitCode: 0, stdout: JSON.stringify([{ name: NAME0, id: 'abc12345', sessionId: '11111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', kind: 'background', state: 'done', status: 'idle' }]), stderr: '' })
  const recovered = await executor.listJobs('D:/Project Alpha')
  expect(recovered[0].status).toBe('completed')
  expect(recovered[0].nativeId).toBe('abc12345')
  expect(JSON.parse(h.files['D:/claude.json']).roots['d:/project alpha'].sessionId).toBe('11111111-2222-4333-8444-555555555555')
})

test('a resumed session updates only its latest launch and preserves completed history', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555'
  const state = JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId, jobs: [
    { id: 'launch-old', nativeId: 'new00001', sessionId, root: 'D:/Project Alpha', prompt: 'old', startedAt: '2030-01-05T09:00:00.000Z', completedAt: '2030-01-05T10:00:00.000Z', status: 'completed', phase: 'done' },
    { id: 'launch-new', nativeId: 'new00001', sessionId, root: 'D:/Project Alpha', prompt: 'new', startedAt: '2030-01-05T11:00:00.000Z', status: 'running', phase: 'working' },
  ] } } })
  const h = harness({ 'D:/claude.json': state })
  h.replies.push({ exitCode: 0, stdout: JSON.stringify([{ id: 'new00001', sessionId, cwd: 'D:/Project Alpha', kind: 'background', status: 'busy', state: 'working' }]), stderr: '' })
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  const jobs = await executor.listJobs('D:/Project Alpha')
  expect(jobs.map(job => [job.id, job.status, job.completedAt])).toEqual([
    ['launch-old', 'completed', '2030-01-05T10:00:00.000Z'],
    ['launch-new', 'running', undefined],
  ])
})

test('completed Claude sync does not become newer when refresh follows the CARD write', async () => {
  const h = harness()
  const agent = { id: 'abc12345', name: NAME0, sessionId: '11111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', kind: 'background', state: 'working' }
  const reply = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' })
  h.replies.push(reply([]), { exitCode: 0, stdout: 'abc12345', stderr: '' }, reply([agent]))
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  await executor.dispatch('D:/Project Alpha', 'update the card', { kind: 'sync' })
  h.deps.now = () => NOW + 120_000
  h.replies.push(reply([{ ...agent, state: 'done' }]))
  const [job] = await executor.listJobs('D:/Project Alpha')
  expect(jobFlags([job], NOW + 60_000)).toEqual([])
  expect(jobFlags([{ ...job, status: 'running' }], NOW + 60_000)[0].kind).toBe('running')
  expect(jobFlags([{ ...job, status: 'failed' }], NOW + 60_000)[0].kind).toBe('newer')
  expect(jobFlags([{ ...job, kind: 'continue' }], NOW + 60_000)[0].kind).toBe('newer')
})

test('copy keeps original session and blocks dispatch until it finishes', async () => {
  const original = '11111111-2222-4333-8444-555555555555'
  const copy = '66666666-7777-4888-8999-000000000000'
  for (const delayed of [false, true]) {
    const h = harness({ 'D:/claude.json': JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: original, jobs: [] } } }) })
    const copiedAgent = { id: 'abc12345', name: NAME0, sessionId: copy, cwd: 'D:/Project Alpha', kind: 'background', state: 'working' }
    const reply = (agents: unknown[]) => ({ exitCode: 0, stdout: JSON.stringify(agents), stderr: '' })
    h.replies.push(reply([]), { exitCode: 0, stdout: 'abc12345', stderr: '' }, reply(delayed ? [] : [copiedAgent]))
    const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
    const error = await errorOf(() => executor.dispatch('D:/Project Alpha', 'resume work', {}))
    expect(error).toMatch(delayed ? /could not uniquely confirm/ : /unmanaged/i)
    expect(JSON.parse(h.files['D:/claude.json']).roots['d:/project alpha'].sessionId).toBe(original)
    h.replies.push(reply([copiedAgent]))
    const [job] = await executor.listJobs('D:/Project Alpha')
    expect(job.sessionId).toBe(original)
    expect(job.phase).toBe('working')
    expect(job.unmanagedSessionId).toBe(copy)
    expect(job.warning).toMatch(/unmanaged/i)
    expect(isActiveJob(job)).toBe(true)
    expect(jobFlags([job], NOW - 60_000)[0].kind).toBe('running')
    h.replies.push(reply([copiedAgent]))
    expect(await errorOf(() => executor.dispatch('D:/Project Alpha', 'duplicate', {}))).toMatch(/active/i)
    expect(h.calls.filter(call => call.argv.includes('--bg')).length).toBe(1)
    h.replies.push(reply([{ ...copiedAgent, state: 'done' }]))
    const [finished] = await executor.listJobs('D:/Project Alpha')
    expect(finished.status).toBe('completed')
    expect(finished.sessionId).toBe(original)
    expect(finished.unmanagedSessionId).toBe(copy)
    expect(isActiveJob(finished)).toBe(false)
    expect(finished.completedAt).toBe(new Date(NOW).toISOString())
    expect(JSON.parse(h.files['D:/claude.json']).roots['d:/project alpha'].sessionId).toBe(original)
    h.replies.push(reply([{ ...copiedAgent, state: 'done' }]), { exitCode: 0, stdout: 'def67890', stderr: '' },
      reply([{ ...copiedAgent, id: 'def67890', name: NAME1, sessionId: original }]))
    await executor.dispatch('D:/Project Alpha', 'next work', {})
    const resumed = h.calls.filter(call => call.argv.includes('--bg'))[1].argv
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe(original)
  }
})

test('a missing copy cannot be completed by the original session previous turn', async () => {
  const original = '11111111-2222-4333-8444-555555555555'
  const copy = '66666666-7777-4888-8999-000000000000'
  const h = harness({ 'D:/claude.json': JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: original, jobs: [
    { id: 'copy-launch', nativeId: 'abc12345', launchName: 'copy-launch', sessionId: original, unmanagedSessionId: copy, root: 'D:/Project Alpha', prompt: 'work', startedAt: new Date(NOW).toISOString(), status: 'running', phase: 'working' },
  ] } } }) })
  const old = { id: 'def67890', name: 'old-launch', sessionId: original, cwd: 'D:/Project Alpha', kind: 'background', state: 'done', startedAt: NOW - 60_000 }
  h.replies.push({ exitCode: 0, stdout: JSON.stringify([old]), stderr: '' })
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  const [job] = await executor.listJobs('D:/Project Alpha')
  expect(isActiveJob(job)).toBe(true)
  expect(job.completedAt).toBe(undefined)
  expect(job.nativeId).toBe('abc12345')
  expect(job.sessionId).toBe(original)
  // The copy identity is already persisted; a named terminal row can omit its UUID.
  h.replies.push({ exitCode: 0, stdout: JSON.stringify([{ id: 'abc12345', name: 'copy-launch', cwd: 'D:/Project Alpha', kind: 'background', state: 'done' }]), stderr: '' })
  const [finished] = await executor.listJobs('D:/Project Alpha')
  expect(finished.status).toBe('completed')
  expect(isActiveJob(finished)).toBe(false)
  expect(finished.sessionId).toBe(original)
  expect(finished.unmanagedSessionId).toBe(copy)
  expect(JSON.parse(h.files['D:/claude.json']).roots['d:/project alpha'].sessionId).toBe(original)
})

test('a copy already done at confirmation retains its completion timestamp and original session', async () => {
  const original = '11111111-2222-4333-8444-555555555555'
  const h = harness({ 'D:/claude.json': JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: original, jobs: [] } } }) })
  h.replies.push({ exitCode: 0, stdout: '[]', stderr: '' }, { exitCode: 0, stdout: 'abc12345', stderr: '' },
    { exitCode: 0, stdout: JSON.stringify([{ id: 'abc12345', name: NAME0, sessionId: '66666666-7777-4888-8999-000000000000', cwd: 'D:/Project Alpha', kind: 'background', state: 'done' }]), stderr: '' })
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  expect(await errorOf(() => executor.dispatch('D:/Project Alpha', 'work', {}))).toMatch(/unmanaged/)
  h.replies.push({ exitCode: 0, stdout: '[]', stderr: '' })
  const [job] = await executor.listJobs('D:/Project Alpha')
  expect(job.status).toBe('completed')
  expect(job.completedAt).toBe(new Date(NOW).toISOString())
  expect(job.updatedAt).toBe(new Date(NOW).toISOString())
  expect(job.sessionId).toBe(original)
})

test('unresolved Claude resume ignores an older turn and keeps duplicate dispatch blocked', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555'
  for (const phase of ['starting', 'unknown']) {
    const h = harness({ 'D:/claude.json': JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId, jobs: [
      { id: 'pending', launchName: 'new-launch', sessionId, root: 'D:/Project Alpha', prompt: 'resume', startedAt: new Date(NOW).toISOString(), status: 'running', phase },
    ] } } }) })
    const old = { id: 'abc12345', name: 'previous-launch', sessionId, cwd: 'D:/Project Alpha', kind: 'background', state: 'done', startedAt: NOW - 60_000 }
    const reply = { exitCode: 0, stdout: JSON.stringify([old]), stderr: '' }
    h.replies.push(reply, reply)
    const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
    const [job] = await executor.listJobs('D:/Project Alpha')
    expect({ status: job.status, phase: job.phase, completedAt: job.completedAt }).toEqual({ status: 'running', phase, completedAt: undefined })
    expect(jobFlags([job], NOW)[0].kind).toBe('running')
    expect(await errorOf(() => executor.dispatch('D:/Project Alpha', 'duplicate', {}))).toMatch(/unresolved/i)
    expect(h.calls.some(call => call.argv.includes('--bg'))).toBe(false)
  }
})

test('nonempty malformed session state fails closed before launching', async () => {
  const h = harness({ 'D:/claude.json': '{broken' })
  h.replies.push({ exitCode: 0, stdout: '[]', stderr: '' })
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  expect(await errorOf(() => executor.dispatch('D:/Project Alpha', 'work', {}))).toMatch(/malformed/i)
  expect(h.calls.length).toBe(1)
  expect(h.writes.length).toBe(0)
})

test('an agent idle after its turn is done, but not inside the launch grace or at a permission prompt', async () => {
  const jobs = (ids: string[]) => ids.map((id, i) => ({ id: `launch-${id}`, nativeId: id, sessionId: `${i}1111111-2222-4333-8444-555555555555`, root: 'D:/Project Alpha', prompt: id, startedAt: '2030-01-05T11:00:00.000Z', status: 'running', phase: 'working' }))
  const h = harness({ 'D:/claude.json': JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', jobs: jobs(['idle0001', 'fresh001', 'block001', 'perm0001']) } } }) })
  h.replies.push({ exitCode: 0, stdout: JSON.stringify([
    { id: 'idle0001', sessionId: '01111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', kind: 'background', status: 'idle', state: 'working', startedAt: NOW - 10 * 60_000 },
    { id: 'fresh001', sessionId: '11111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', kind: 'background', status: 'idle', state: 'working', startedAt: NOW - 5_000 },
    { id: 'block001', sessionId: '21111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', kind: 'background', status: 'idle', state: 'blocked', startedAt: NOW - 10 * 60_000 },
    { id: 'perm0001', sessionId: '31111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha', kind: 'background', status: 'waiting', state: 'blocked', waitingFor: 'Bash', startedAt: NOW - 10 * 60_000 },
  ]), stderr: '' })
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  expect((await executor.listJobs('D:/Project Alpha')).map(job => [job.nativeId, job.status, job.phase])).toEqual([
    ['idle0001', 'completed', 'idle'],
    ['fresh001', 'running', 'working'],
    ['block001', 'completed', 'idle: 等你回覆'],
    ['perm0001', 'running', 'blocked: Bash'],
  ])
})

test('an agent working in a Claude worktree of the project reconciles its job', async () => {
  const h = harness({ 'D:/claude.json': JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', jobs: [
    { id: 'wt-launch', launchName: 'console-wt-0', nativeId: 'wt000001', sessionId: '11111111-2222-4333-8444-555555555555', root: 'D:/Project Alpha', prompt: 'fix', startedAt: '2030-01-05T11:00:00.000Z', status: 'running', phase: 'working' },
  ] } } }) })
  h.replies.push({ exitCode: 0, stdout: JSON.stringify([
    { id: 'wt000001', name: 'console-wt-0', sessionId: '11111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha/.claude/worktrees/fix-actions', kind: 'background', status: 'idle', state: 'done' },
    { id: 'other001', name: 'console-other', sessionId: '21111111-2222-4333-8444-555555555555', cwd: 'D:/Project Alpha-other', kind: 'background', status: 'busy', state: 'working' },
  ]), stderr: '' })
  const executor = createExecutor('claude', h.deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: 'D:/claude.json' })
  expect((await executor.listJobs('D:/Project Alpha')).map(job => [job.id, job.status])).toEqual([['wt-launch', 'completed']])
})
