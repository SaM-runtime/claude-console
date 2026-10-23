import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'

// 5-A and 5-B: how many steps one relay takes, and how many projects run at once while relays are armed.
const OPTIONS = (extra: Record<string, string> = {}) => ({ timeoutMs: 30_000, options: { activation: 'always', executor: 'codex', registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/companion.mjs', companionStateRoots: '["D:/State"]', gitProbe: 'off', cacheHint: 'off', suggestNext: 'off', ...extra } })
const T = (iso: string) => Date.parse(iso)
const PANE = (surface = 'terminal') => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface,
  props: { title: 'Console', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
const MINUTE = 61_000
const status = (name: string) => `D:/${name}/.console/STATUS.md`
const stateFile = (name: string) => `D:/State/${name}-hash/state.json`

/** A CARD written at `ms` (local time, as an executor writes it) with this rev and next step. */
const card = (ms: number, rev: number, next: string) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `<!-- CARD -->\n- 更新：${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} · rev ${rev}\n- 狀態：進行中\n- 等使用者：無\n- 下一步：${next}\n- 關卡：無\n<!-- /CARD -->`
}

/** Projects (name → next step) on Codex, each with its own companion workspace; `running` names start with a job running. */
function harness(on: any, projects: Record<string, string>, running: string[] = []) {
  const clock = mock.clock(on, { now: T('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const names = Object.keys(projects)
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': `## STATUS 卡位置\n${names.map(name => `| ${name} | \`${status(name)}\` |`).join('\n')}`,
    'C:/Users/example/.claude/handoffs/dispatch.json': '{"executor":"codex","model":"","effort":""}',
    'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
  }
  const states: Record<string, { jobs: any[] }> = {}
  const revs: Record<string, number> = {}
  for (const name of names) {
    revs[name] = 1
    files[status(name)] = card(clock.now() - 3_600_000, 1, projects[name]!)
    states[name] = { jobs: running.includes(name) ? [{ id: `${name}-0`, jobClass: 'task', status: 'running', startedAt: new Date(clock.now() - 60_000).toISOString(), request: { prompt: 'earlier' } }] : [] }
  }
  const h = { clock, files, states, revs, launches: [] as string[], toasts: [] as string[], store: {} as Record<string, unknown>, feed: [] as string[] }
  on('fs.stat', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    const owner = names.find(name => stateFile(name) === path)
    return { value: owner ? JSON.stringify(states[owner]) : files[path] ?? '' }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', (_: any, e: any) => ({ value: fixturePath(e.path) === 'D:/State' ? names.map(name => ({ name: `${name}-hash`, kind: 'dir' })) : [] }))
  on('process.run', (_: any, e: any) => {
    let stdout = e.argv[0] === 'claude' ? '[]' : 'OK codex=0.0.0-test'
    if (e.argv[0] === 'node' && e.argv.includes('task')) {
      const root = String(e.argv[e.argv.indexOf('--cwd') + 1])
      const name = names.find(item => root === `D:/${item}`)!
      h.launches.push(name)
      const id = `${name}-${h.launches.length}`
      states[name]!.jobs = [...states[name]!.jobs, { id, jobClass: 'task', status: 'running', startedAt: new Date(clock.now()).toISOString(), request: { prompt: e.argv[e.argv.length - 1] } }]
      stdout = JSON.stringify({ jobId: id })
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_: any, e: any) => { h.toasts.push(String(e.text ?? JSON.stringify(e))); return { value: undefined } })
  on('store.get', (_: any, e: any) => ({ value: h.store[e.key] ?? null }))
  on('store.set', (_: any, e: any) => { h.store[e.key] = e.value; return { value: undefined } })
  on('state.set', async (_: any, e: any, next: any) => {
    const answer = await next(e)
    if (e.key === 'feed') h.feed = (e.value as any[]).map(item => item.text)
    return answer
  })
  return h
}
type H = ReturnType<typeof harness>

const refresh = ($: any) => $.command.run({ command: 'console', args: 'refresh' } as any)
const run = async ($: any, args: string) => ((await $.command.run({ command: 'console', args } as any)) as any).text as string
/** A project's running jobs end and its CARD is written a little later, with this next step. */
function finish(h: H, name: string, next: string) {
  const done = h.clock.now() + 20_000
  h.states[name]!.jobs = h.states[name]!.jobs.map(job => job.status === 'running' ? { ...job, status: 'completed', completedAt: new Date(done).toISOString() } : job)
  h.revs[name]!++
  h.files[status(name)] = card(done + 60_000, h.revs[name]!, next)
}
const later = async (h: H, $: any) => { await h.clock.advance(3 * MINUTE); await refresh($); await h.clock.settle() }
const cycles = (h: H) => (h.store.cycles ?? {}) as Record<string, any>

test('/console cycle <專案> <步數> caps this relay; on a relay already going it sets how many more', OPTIONS(), async ($, on) => {
  const h = harness(on, { Alpha: '.task/a.md' })
  await refresh($)
  expect(await run($, 'cycle Alpha 2')).toBe('Alpha：開始自動接力，最多 2 跳')
  expect(cycles(h)[status('Alpha')].max).toBe(2)
  await refresh($)
  expect(h.launches).toEqual(['Alpha'])
  expect(await run($, 'cycle Alpha 3')).toBe('Alpha：接力改成再 3 跳就停（⟳ 1/4）')
  expect(cycles(h)[status('Alpha')].max).toBe(4)
  expect(h.feed).toContain('⟳ Alpha 接力改成再 3 跳就停（已送 1 跳）')
  // A word that is not a number, or a number with off, is not guessed at.
  expect(await run($, 'cycle Alpha soon')).toMatch(/^用法：\/console cycle <專案名稱> \[步數\]/)
  expect(await run($, 'cycle Alpha 2 off')).toMatch(/^用法：/)
  expect(cycles(h)[status('Alpha')].max).toBe(4)
  expect(await run($, 'cycle Alpha off')).toBe('Alpha：接力已停止')
  // Past 20 the step count is the most a relay takes.
  expect(await run($, 'cycle Alpha 50')).toBe('Alpha：開始自動接力，最多 20 跳')
})

test('a relay of one step: the next step goes out once and the relay stops at its limit', OPTIONS(), async ($, on) => {
  const h = harness(on, { Alpha: '.task/a.md' })
  await refresh($)
  await run($, 'cycle Alpha 1')
  await refresh($)
  expect(h.launches).toEqual(['Alpha'])
  finish(h, 'Alpha', '.task/b.md')
  await later(h, $)
  expect(h.launches).toEqual(['Alpha'])
  expect(cycles(h)[status('Alpha')]).toBeUndefined()
  expect(h.feed.some(text => text === '⟳ Alpha 接力停止：已達上限 1 跳（第 1 跳）')).toBe(true)
})

test('⟳ 做完再接一步 shows while work runs: one step after it, then the relay stops', OPTIONS(), async ($, on) => {
  const h = harness(on, { Alpha: '.task/a.md' }, ['Alpha'])
  await refresh($)
  const ui = await $.ui.mount(PANE())
  await ui.post({ key: 'm' }, { in: 'rows' } as any)
  expect(await ui.find({ key: 'm-once' })).toBeDefined()
  await ui.press({ key: 'm-once' })
  await h.clock.settle()
  expect(cycles(h)[status('Alpha')].max).toBe(1)
  expect(h.feed.some(text => text.startsWith('⟳ Alpha 做完再接一步：工作做完並同步後，再接一步就停（最多 1 跳'))).toBe(true)
  // Armed, the button gives way to ■ 停止接力.
  expect(await ui.find({ key: 'm-once' })).toBeUndefined()
  await ui.unmount()
  // Nothing goes out while the work runs; once it ends, the next step does, and that is all.
  await later(h, $)
  expect(h.launches).toEqual([])
  finish(h, 'Alpha', '.task/b.md')
  await later(h, $)
  expect(h.launches).toEqual(['Alpha'])
  finish(h, 'Alpha', '.task/c.md')
  await later(h, $)
  expect(h.launches).toEqual(['Alpha'])
  expect(cycles(h)[status('Alpha')]).toBeUndefined()
})

test('⟳ 做完再接一步 with auto-sync off counts the sync as a step', OPTIONS({ autoSync: 'off' }), async ($, on) => {
  const h = harness(on, { Alpha: '.task/a.md' }, ['Alpha'])
  await refresh($)
  expect(await run($, 'cycle Alpha')).toMatch(/最多 6 跳/)
  await run($, 'cycle Alpha off')
  const ui = await $.ui.mount(PANE())
  await ui.post({ key: 'm' }, { in: 'rows' } as any)
  await ui.press({ key: 'm-once' })
  await h.clock.settle()
  expect(cycles(h)[status('Alpha')].max).toBe(2)
  expect(h.feed.some(text => text.startsWith('⟳ Alpha 做完再接一步：工作做完先同步，再接一步就停（同步也算一步，最多 2 跳'))).toBe(true)
  await ui.unmount()
})

test('⟳ 做完再接一步 is not offered while nothing runs', OPTIONS(), async ($, on) => {
  harness(on, { Alpha: '.task/a.md' })
  await refresh($)
  const ui = await $.ui.mount(PANE())
  await ui.post({ key: 'm' }, { in: 'rows' } as any)
  expect(await ui.find({ key: 'm-cycle' })).toBeDefined()
  expect(await ui.find({ key: 'm-once' })).toBeUndefined()
  await ui.unmount()
})

test('cycleMaxRunning 1: the relay armed second waits in line until the first relay ends', OPTIONS({ cycleMaxRunning: '1' }), async ($, on) => {
  const h = harness(on, { Alpha: '.task/a.md', Beta: '.task/b.md' })
  await refresh($)
  expect(await run($, 'cycle Alpha 2')).toBe('Alpha：開始自動接力，最多 2 跳')
  expect(await run($, 'cycle Beta')).toBe('Beta：開始自動接力，最多 6 跳（排隊中，第 1 個：Alpha 在接力）')
  expect(h.feed.some(text => text.includes('；同時最多 1 個，先排隊（第 1 個：Alpha 在接力）'))).toBe(true)
  await refresh($)
  expect(h.launches).toEqual(['Alpha'])
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Text', text: /⟳ 排隊中・第 1 個/ })).toBeDefined()
  await ui.unmount()
  // Between Alpha's hops nothing runs, and Beta still waits: Alpha keeps its place until its relay ends.
  finish(h, 'Alpha', '.task/a2.md')
  await later(h, $)
  expect(h.launches).toEqual(['Alpha', 'Alpha'])
  finish(h, 'Alpha', '.task/a3.md')
  await later(h, $)
  expect(cycles(h)[status('Alpha')]).toBeUndefined()
  await later(h, $)
  expect(h.launches).toEqual(['Alpha', 'Alpha', 'Beta'])
  expect(cycles(h)[status('Beta')].queued).toBeUndefined()
  expect(h.feed).toContain('⟳ Beta 排到了，接著接力')
})

test('running work counts toward cycleMaxRunning, your own presses too, and a person\'s continue never waits', OPTIONS({ cycleMaxRunning: '1' }), async ($, on) => {
  const h = harness(on, { Alpha: '.task/a.md', Gamma: '.task/g.md' }, ['Gamma'])
  await refresh($)
  expect(await run($, 'cycle Alpha')).toBe('Alpha：開始自動接力，最多 6 跳（排隊中，第 1 個：已有 1 個工作在跑）')
  await later(h, $)
  expect(h.launches).toEqual([])
  const ui = await $.ui.mount(PANE())
  // Gamma, running, is the first row: the first ↓ puts the cursor there, the second on Alpha.
  await ui.post({ key: 'down' }, { in: 'rows' } as any)
  await ui.post({ key: 'down' }, { in: 'rows' } as any)
  await ui.post({ key: 'm' }, { in: 'rows' } as any)
  expect(await ui.find({ type: 'Text', text: '⟳ 排隊中・第 1 個：已有 1 個工作在跑（同時最多 1 個，cycleMaxRunning）' })).toBeDefined()
  await ui.unmount()
  // The person's own continue goes out though the relay waits.
  expect(await run($, 'continue Alpha')).toMatch(/Alpha/)
  await h.clock.settle()
  expect(h.launches).toEqual(['Alpha'])
  // Gamma's work ends: Alpha's relay takes its place (its own job is running) and continues from there.
  finish(h, 'Gamma', '無')
  await later(h, $)
  expect(cycles(h)[status('Alpha')].queued).toBeUndefined()
})
