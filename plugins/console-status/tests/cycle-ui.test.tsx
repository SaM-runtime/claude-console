import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { CYCLE_MAX_AGE_MS } from '../hooks/cycle'

// Each test runs a whole cycle (many refreshes and simulated minutes), so it gets more than the default 5 s.
const OPTIONS = { timeoutMs: 30_000, options: { activation: 'always', executor: 'codex', registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/companion.mjs', companionStateRoots: '["D:/State"]', gitProbe: 'off', cacheHint: 'off', suggestNext: 'off' } }
const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const STATE = 'D:/State/Project Alpha-hash/state.json'
const T = (iso: string) => Date.parse(iso)
const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
  props: { title: 'Console', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any
const MINUTE = 61_000

/** A CARD written at `ms` (local time, as an executor writes it) with this rev, next step, gate and decision. */
const card = (ms: number, rev: number, next: string, gate = '無', ask = '無') => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `<!-- CARD -->\n- 更新：${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} · rev ${rev}\n- 狀態：進行中\n- 等使用者：${ask}\n- 下一步：${next}\n- 關卡：${gate}\n<!-- /CARD -->`
}

function harness(on: any, first: { next: string; gate?: string; ask?: string }, jobs: any[] = []) {
  const clock = mock.clock(on, { now: T('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project Alpha | \`${STATUS}\` |`,
    [STATUS]: card(clock.now() - 3_600_000, 1, first.next, first.gate, first.ask),
    'C:/Users/example/.claude/handoffs/dispatch.json': '{"executor":"codex","model":"","effort":""}',
    'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
  }
  const state = { jobs }
  const h = { clock, files, state, launches: [] as string[][], toasts: [] as string[], submitted: [] as any[], rev: 1, store: {} as Record<string, unknown>, feed: [] as string[] }
  on('fs.stat', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    return { value: path === STATE ? JSON.stringify(state) : files[path] ?? '' }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', (_: any, e: any) => ({ value: fixturePath(e.path) === 'D:/State' ? [{ name: 'Project Alpha-hash', kind: 'dir' }] : [] }))
  on('process.run', (_: any, e: any) => {
    let stdout = e.argv[0] === 'claude' ? '[]' : 'OK codex=0.0.0-test'
    if (e.argv[0] === 'node' && e.argv.includes('task')) {
      h.launches.push([...e.argv])
      const id = `task-${h.launches.length}`
      state.jobs = [...state.jobs, { id, jobClass: 'task', status: 'running', startedAt: new Date(clock.now()).toISOString(), request: { prompt: e.argv[e.argv.length - 1] } }]
      stdout = JSON.stringify({ jobId: id })
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_: any, e: any) => { h.toasts.push(String(e.text ?? JSON.stringify(e))); return { value: undefined } })
  on('prompt.submit', (_: any, e: any) => { h.submitted.push(e); return { text: e.text } })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
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
/** The executor finishes its job and writes the CARD a little later. */
function finish(h: H, id: string, next: string, gate = '無', extra: Record<string, unknown> = {}) {
  const done = h.clock.now() + 20_000
  h.state.jobs = h.state.jobs.map((item: any) => item.id === id ? { ...item, status: 'completed', completedAt: new Date(done).toISOString(), ...extra } : item)
  h.rev++
  h.files[STATUS] = card(done + 60_000, h.rev, next, gate)
}
/** A few minutes on, a refresh, and the gate hop it may have scheduled. */
const later = async (h: H, $: any) => { await h.clock.advance(3 * MINUTE); await refresh($); await h.clock.settle() }
const arm = ($: any, off = false) => $.command.run({ command: 'console', args: `cycle Project Alpha${off ? ' off' : ''}` } as any)
const prompt = (argv: string[]) => argv[argv.length - 1]!

test('(d) one press runs continue → review → gate → fix and stops at release, each hop an existing action', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  await refresh($)
  expect((await arm($)).text).toMatch(/開始自動接力，最多 6 跳/)
  expect(h.launches.length).toBe(0)

  // Hop 1: continue, confirmed by the press of ⟳ (no second press).
  await refresh($)
  expect(h.launches.length).toBe(1)
  expect(prompt(h.launches[0]!).startsWith('依 STATUS CARD 的下一步繼續')).toBe(true)
  expect(h.feed.some(text => text === '⟳ Project 第 1 跳：⇢ 繼續下一步（.task/build.md）')).toBe(true)

  // Hop 2: the next step is a review task, so a fresh thread with the review rule and no digest.
  finish(h, 'task-1', '.task/review-x.md')
  await later(h, $)
  expect(h.launches.length).toBe(2)
  expect(h.launches[1]!.includes('--fresh')).toBe(true)
  expect(prompt(h.launches[1]!).includes('這是獨立審核')).toBe(true)
  expect(prompt(h.launches[1]!).includes('執行者摘要')).toBe(false)

  // Hop 3: the review set a review gate; the console is asked to judge it.
  finish(h, 'task-2', '無', 'review：0.21.0 獨立審核 PASS')
  await later(h, $)
  expect(h.submitted.length).toBe(1)
  expect(h.submitted[0].text.includes('review 關卡')).toBe(true)
  // While its turn runs, nothing else is sent.
  await later(h, $)
  expect(h.submitted.length).toBe(1)
  expect(h.launches.length).toBe(2)

  // The console passes the gate and points at the fix.
  h.rev++
  h.files[STATUS] = card(h.clock.now(), h.rev, '依 .task/review-x.md 的意見修正')
  await $.turn.start({ text: h.submitted[0].text, turnId: 'gate-turn' })
  await $.turn.complete({ turnId: 'gate-turn', answer: '放行', durationMs: 1, isAborted: false, reason: 'answer' })

  // Hop 4: continue the fix.
  await later(h, $)
  expect(h.launches.length).toBe(3)
  expect(prompt(h.launches[2]!).includes('這是獨立審核')).toBe(false)

  // The fix reaches release: the cycle stops and hands it back.
  finish(h, 'task-3', '無', 'release：push to fork')
  await later(h, $)
  expect(h.launches.length).toBe(3)
  expect(h.submitted.length).toBe(1)
  expect(h.feed.some(text => text === '⟳ Project 接力停止：到 release 關卡，等你核准（第 4 跳）')).toBe(true)
  expect(h.toasts.some(text => text.includes('到 release 關卡'))).toBe(true)
  expect(h.store.cycles).toEqual({})
})

test('(e) an executor that stopped to ask stops the cycle: no reply, no sync', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  await refresh($)
  await arm($)
  await refresh($)
  expect(h.launches.length).toBe(1)
  // It ends its turn on a question and does not write the CARD.
  h.state.jobs = h.state.jobs.map((item: any) => ({ ...item, status: 'completed', phase: 'idle: 等你回覆', completedAt: new Date(h.clock.now() + 20_000).toISOString() }))
  await later(h, $)
  await later(h, $)
  expect(h.launches.length).toBe(1)
  expect(h.submitted.length).toBe(0)
  expect(h.feed.some(text => text.startsWith('⟳ Project 接力停止：執行者在等你回覆'))).toBe(true)
})

test('(f) a gate the console leaves in place stops the cycle; the gate is sent once', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '無', gate: 'review：check it' })
  await refresh($)
  await arm($)
  await refresh($)
  await h.clock.settle()
  expect(h.submitted.length).toBe(1)
  await $.turn.start({ text: h.submitted[0].text, turnId: 'gate-turn' })
  await $.turn.complete({ turnId: 'gate-turn', answer: '不放行：缺測試', durationMs: 1, isAborted: false, reason: 'answer' })
  await later(h, $)
  await later(h, $)
  expect(h.submitted.length).toBe(1)
  expect(h.feed.some(text => text === '⟳ Project 接力停止：主控台未放行關卡（第 1 跳）')).toBe(true)
})

test('(g) a hop that left the CARD as it was is not sent again', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  await refresh($)
  await arm($)
  await refresh($)
  // The job finishes but the CARD keeps its rev and next step (only its time moves, so the row is not 待同步).
  const card1 = h.files[STATUS]!
  h.state.jobs = h.state.jobs.map((item: any) => ({ ...item, status: 'completed', completedAt: new Date(h.clock.now() + 20_000).toISOString() }))
  h.files[STATUS] = card1.replace(/更新：[^·]*·/, () => { const d = new Date(h.clock.now() + 80_000); const p = (n: number) => String(n).padStart(2, '0'); return `更新：${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ·` })
  await later(h, $)
  expect(h.launches.length).toBe(1)
  expect(h.feed.some(text => text === '⟳ Project 接力停止：上一跳沒有改到狀態卡（第 1 跳）')).toBe(true)
})

test('(h) cycleMaxHops: 2 sends two hops and stops before a third', { ...OPTIONS, options: { ...OPTIONS.options, cycleMaxHops: '2' } }, async ($, on) => {
  const h = harness(on, { next: '.task/a.md' })
  await refresh($)
  expect((await arm($)).text).toMatch(/最多 2 跳/)
  await refresh($)
  finish(h, 'task-1', '.task/b.md')
  await later(h, $)
  finish(h, 'task-2', '.task/c.md')
  await later(h, $)
  expect(h.launches.length).toBe(2)
  expect(h.feed.some(text => text === '⟳ Project 接力停止：已達上限 2 跳（第 2 跳）')).toBe(true)
})

test('(i) a cycle armed before a reload is still in force: only the store has it, and it takes its next hop', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  h.store.cycles = { [STATUS]: { startedAt: h.clock.now() - 30 * 60_000, hops: 1, max: 6, lastRev: 0, lastNext: '.task/before.md', lastKind: 'continue', lastAt: h.clock.now() - 10 * 60_000, owner: 'console-session' } }
  await refresh($)
  expect(h.launches.length).toBe(1)
  expect(h.feed.some(text => text === '⟳ Project 第 2 跳：⇢ 繼續下一步（.task/build.md）')).toBe(true)
  expect((h.store.cycles as any)[STATUS].hops).toBe(2)
})

test('(i) a cycle with no hop for six hours is let go of, and says so', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  // Its last hop's job never ended; six hours on, the wait is given up.
  const long = h.clock.now() - CYCLE_MAX_AGE_MS - MINUTE
  h.store.cycles = { [STATUS]: { startedAt: long - MINUTE, hops: 1, max: 6, lastRev: 1, lastNext: '.task/x.md', lastKind: 'continue', lastAt: long, owner: 'console-session' } }
  h.state.jobs = [{ id: 'long', jobClass: 'task', status: 'running', startedAt: new Date(long).toISOString(), request: { prompt: 'work' } }]
  await refresh($)
  expect(h.feed.some(text => text === '⟳ Project 接力解除：6 小時沒有新的一跳（第 1 跳）')).toBe(true)
  expect(h.toasts.some(text => text.includes('6 小時沒有新的一跳'))).toBe(true)
  expect(h.store.cycles).toEqual({})
  expect(h.launches.length).toBe(0)
})

test('(j) ■ 停止接力 lets go of the cycle and leaves the running job alone', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  await refresh($)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-cycle' })
  expect(await ui.find({ key: 'detail-Project Alpha-cycle' })).toBeDefined()
  await refresh($)
  expect(h.launches.length).toBe(1)
  expect((await ui.find({ key: 'detail-Project Alpha-cycle' }))?.text).toMatch(/^■ 停止接力/)
  await ui.press({ key: 'detail-Project Alpha-cycle' })
  expect(h.store.cycles).toEqual({})
  expect(h.state.jobs.some((item: any) => item.status === 'running')).toBe(true)
  expect(h.feed.some(text => text.startsWith('⟳ Project 接力已停止'))).toBe(true)
  finish(h, 'task-1', '.task/next.md')
  await later(h, $)
  expect(h.launches.length).toBe(1)
  expect((await ui.find({ key: 'detail-Project Alpha-cycle' }))?.text).toBe('⟳ 自動接力')
  await ui.unmount()
})

test('(k) 待同步: auto-sync on sends the sync and the cycle does not; off, the cycle sends one', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  await refresh($)
  await arm($)
  await refresh($)
  // The job ends without writing the CARD: 待同步.
  h.state.jobs = h.state.jobs.map((item: any) => ({ ...item, status: 'completed', completedAt: new Date(h.clock.now() + 20_000).toISOString() }))
  await later(h, $)
  const syncs = h.launches.filter(argv => prompt(argv).startsWith('把最近完成的工作結果寫回 STATUS CARD'))
  expect(syncs.length).toBe(1)
  expect(h.feed.some(text => text.startsWith('⟳ Project 第 2 跳'))).toBe(false)
})

test('(k) with auto-sync off the cycle sends the sync itself, once', { ...OPTIONS, options: { ...OPTIONS.options, autoSync: 'off' } }, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  await refresh($)
  await arm($)
  await refresh($)
  h.state.jobs = h.state.jobs.map((item: any) => ({ ...item, status: 'completed', completedAt: new Date(h.clock.now() + 20_000).toISOString() }))
  await later(h, $)
  await refresh($)
  const syncs = h.launches.filter(argv => prompt(argv).startsWith('把最近完成的工作結果寫回 STATUS CARD'))
  expect(syncs.length).toBe(1)
  expect(h.feed.some(text => text === '⟳ Project 第 2 跳：⇢ 同步 STATUS（結果寫回狀態卡）')).toBe(true)
})

// Review P2-2: the store is shared by every console session. This test's console is B ('console-session');
// console A is another session whose heartbeat is in the lease and which is in consoleSessions.
const LEASE = 'C:/Users/example/.claude/handoffs/console-lease.json'
const OTHER = 'D:/Elsewhere/.console/STATUS.md'
const armedBy = (owner: string, at: number, over: Record<string, unknown> = {}) => ({ startedAt: at, hops: 0, max: 6, lastRev: null, lastNext: '', lastKind: '', lastAt: 0, owner, ...over })
function consoleA(h: H, alive = true) {
  h.store.consoleSessions = alive ? ['console-A', 'console-session'] : ['console-session']
  h.files[LEASE] = JSON.stringify({ consoles: alive ? { 'console-A': h.clock.now() } : {}, projects: {} })
}

test('review P2-2: a cycle another console armed is shown here, not run here', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  consoleA(h)
  h.store.cycles = { [STATUS]: armedBy('console-A', h.clock.now()) }
  await refresh($)
  await later(h, $)
  expect(h.launches.length).toBe(0)
  expect((h.store.cycles as any)[STATUS].owner).toBe('console-A')
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  expect((await ui.find({ key: 'detail-Project Alpha-cycle' }))?.text).toBe('⟳ 另一主控台接力中')
  // ■ here does not stop A's cycle.
  await ui.press({ key: 'detail-Project Alpha-cycle' })
  expect((h.store.cycles as any)[STATUS].owner).toBe('console-A')
  // A stops it: this console sees that at its next refresh.
  h.store.cycles = {}
  await later(h, $)
  expect((await ui.find({ key: 'detail-Project Alpha-cycle' }))?.text).toBe('⟳ 自動接力')
  await ui.unmount()
})

test('review P2-2: two consoles arm different projects without writing over each other', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  consoleA(h)
  h.store.cycles = { [OTHER]: armedBy('console-A', h.clock.now()) }
  await refresh($)
  await arm($)
  await refresh($)
  expect(h.launches.length).toBe(1)
  expect((h.store.cycles as any)[OTHER].owner).toBe('console-A')
  expect((h.store.cycles as any)[STATUS].owner).toBe('console-session')
  // A arms or changes its own entry meanwhile; this console's next write keeps it.
  h.store.cycles = { ...(h.store.cycles as any), [OTHER]: armedBy('console-A', h.clock.now(), { hops: 3 }) }
  finish(h, 'task-1', '.task/next.md')
  await later(h, $)
  expect((h.store.cycles as any)[OTHER].hops).toBe(3)
  expect((h.store.cycles as any)[STATUS].hops).toBe(2)
})

test('review P2-2: a cycle whose console is gone is cleared by another after six hours, and says so', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  consoleA(h, false)
  const long = h.clock.now() - CYCLE_MAX_AGE_MS - MINUTE
  h.store.cycles = { [STATUS]: armedBy('console-A', long - MINUTE, { hops: 2, lastAt: long, lastKind: 'continue', lastNext: '.task/x.md', lastRev: 1 }) }
  await refresh($)
  expect(h.launches.length).toBe(0)
  expect(h.store.cycles).toEqual({})
  expect(h.feed.some(text => text === '⟳ Project 接力解除：接力的主控台已離開超過 6 小時（第 2 跳）')).toBe(true)
})

// Review P3: a continue or gate hop waits for another console's dispatch as 0.20.1 does, two minutes, not as long as it lives.
function claimedBy(h: H, agoMs: number) {
  consoleA(h)
  h.files[LEASE] = JSON.stringify({ consoles: { 'console-A': h.clock.now() }, projects: { [STATUS]: { sessionId: 'console-A', at: h.clock.now() - agoMs } } })
}

test('review P3: another console dispatched the project three minutes ago: the cycle takes its hop', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  await refresh($)
  await arm($)
  claimedBy(h, 3 * 60_000)
  await refresh($)
  expect(h.launches.length).toBe(1)
})

test('review P3: another console dispatched the project a minute ago: the cycle waits for it', OPTIONS, async ($, on) => {
  const h = harness(on, { next: '.task/build.md' })
  await refresh($)
  await arm($)
  claimedBy(h, 60_000)
  await refresh($)
  expect(h.launches.length).toBe(0)
  expect((h.store.cycles as any)[STATUS].waiting).toBe('等另一個主控台')
  expect(h.feed.some(text => text.includes('接力停止'))).toBe(false)
})
