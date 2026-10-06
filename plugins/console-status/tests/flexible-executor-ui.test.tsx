import { expect, test, mock } from 'claude-code/testing'

const SETTINGS = 'C:/Users/example/.claude/handoffs/dispatch.json'
const LEGACY = 'C:/Users/example/.claude/handoffs/codex-dispatch.json'
const SESSIONS = 'C:/Users/example/.claude/handoffs/claude-sessions.json'
const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const NOW = Date.parse('2030-01-05T12:00:00Z')
const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
  props: { title: 'Console', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any

type Fixture = { settings?: string | null; legacy?: string; registry?: string; preflight?: string | ((argv: string[]) => string); quota?: string; lists?: Record<string, { name: string; kind: string }[]> }

function fixture(on: any, opts: Fixture = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    [SESSIONS]: '{"version":1,"roots":{}}',
    'D:/State/Project Alpha-hash/state.json': '{"jobs":[]}',
    'D:/Fixtures/registry.md': opts.registry ?? `## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n| Project Alpha | \`${STATUS}\` |`,
    [STATUS]: '<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：無\n- 下一步：Run tests\n<!-- /CARD -->',
  }
  if (opts.settings !== null) files[SETTINGS] = opts.settings ?? '{"executor":"claude","model":"","effort":""}'
  if (opts.legacy) files[LEGACY] = opts.legacy
  const launches: string[][] = []
  const probes: string[][] = []
  const toasts: string[] = []
  const sessions: any[] = []
  on('fs.read', (_: any, e: any) => {
    const path = e.path.replace(/\\/g, '/')
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' })
    return { value: files[path] }
  })
  on('fs.write', (_: any, e: any) => { files[e.path.replace(/\\/g, '/')] = e.text; return { value: undefined } })
  const lists: Record<string, { name: string; kind: string }[]> = { 'D:/State': [{ name: 'Project Alpha-hash', kind: 'dir' }], ...opts.lists }
  on('fs.list', (_: any, e: any) => ({ value: lists[e.path.replace(/\\/g, '/')] ?? [] }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = [...e.argv]
    let stdout = ''
    if (argv.some(arg => arg.endsWith('codex-preflight.ps1'))) { probes.push(argv); stdout = typeof opts.preflight === 'function' ? opts.preflight(argv) : opts.preflight ?? 'OK codex=0.0.0-test companion=OK' }
    else if (argv.some(arg => arg.endsWith('codex-quota.ps1'))) stdout = opts.quota ?? ''
    else if (argv[0] === 'node') { launches.push(argv); stdout = '{"jobId":"codex-new"}' }
    else if (argv[1] === 'agents') stdout = JSON.stringify(sessions)
    else if (argv[1] === 'logs') stdout = 'working\n'
    else if (argv.includes('--bg')) {
      launches.push(argv)
      sessions.splice(0, sessions.length, { id: '12345678', sessionId: '12345678-1234-4234-8234-123456789abc', kind: 'background', cwd: 'D:/Project Alpha', state: 'working', status: 'busy', name: argv[argv.indexOf('--name') + 1] })
      stdout = '12345678'
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  return { clock, files, launches, probes, toasts }
}

const BASE = { registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/companion.mjs', companionStateRoots: '["D:/State"]' }

test('registry Executor column selects codex per project and the pane cycles a persisted override', { options: BASE }, async ($, on) => {
  const h = fixture(on, { registry: `## STATUS 卡位置\n| Project | STATUS path | Executor |\n| --- | --- | --- |\n| Project Alpha | \`${STATUS}\` | codex |` })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  // Global is claude, but this project uses codex, so the Codex probes run.
  expect(h.probes.length).toBe(1)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  expect((await ui.find({ key: 'detail-Project Alpha-executor' }))?.text).toBe('codex・登錄表')
  await ui.press({ key: 'detail-Project Alpha-executor' })
  expect(JSON.parse(h.files[SETTINGS]!)).toEqual({ executor: 'claude', model: '', effort: '', projects: { 'D:/Project Alpha': { executor: 'claude' } } })
  expect((await ui.find({ key: 'detail-Project Alpha-executor' }))?.text).toBe('claude・面板')
  await ui.press({ key: 'detail-Project Alpha-executor' })
  await ui.press({ key: 'detail-Project Alpha-executor' })
  expect(JSON.parse(h.files[SETTINGS]!).projects).toEqual({ 'D:/Project Alpha': { executor: 'manual' } })
  // Manual: no dispatch action, an explicit handoff note, verify/open remain.
  expect(await ui.find({ key: 'detail-Project Alpha-continue' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /手動交接/ })).toBeDefined()
  expect(await ui.find({ key: 'detail-Project Alpha-open' })).toBeDefined()
  expect(h.launches).toEqual([])
  // Back to inherit: the override disappears and the file returns to the flat shape.
  await ui.press({ key: 'detail-Project Alpha-executor' })
  expect(JSON.parse(h.files[SETTINGS]!)).toEqual({ executor: 'claude', model: '', effort: '' })
  expect((await ui.find({ key: 'detail-Project Alpha-executor' }))?.text).toBe('codex・登錄表')
  // The global controls still write without dropping overrides.
  await $.command.run({ command: 'console', args: 'project executor manual Project' } as any)
  await $.command.run({ command: 'console', args: 'model opus' } as any)
  expect(JSON.parse(h.files[SETTINGS]!)).toEqual({ executor: 'claude', model: 'opus', effort: '', projects: { 'D:/Project Alpha': { executor: 'manual' } } })
  const listing = JSON.stringify(await $.command.run({ command: 'console', args: 'project' } as any))
  expect(listing.includes('Project Alpha：manual（面板覆寫）')).toBe(true)
  await ui.unmount()
})

test('per-project codex override dispatches through Codex with its own model while global stays claude', { options: BASE }, async ($, on) => {
  const h = fixture(on, { settings: JSON.stringify({ executor: 'claude', model: 'opus', effort: 'high', projects: { 'd:/project alpha': { executor: 'codex', model: 'fiction-codex' } } }) })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches.length).toBe(1)
  expect(h.launches[0]!.slice(0, 2)).toEqual(['node', 'D:/Tools/companion.mjs'])
  expect(h.launches[0]!.includes('fiction-codex')).toBe(true)
  expect(h.launches[0]!.includes('opus')).toBe(false)
  await ui.unmount()
})

test('legacy codex-dispatch.json is honored read-only when dispatch.json is missing', { options: BASE }, async ($, on) => {
  const h = fixture(on, { settings: null, legacy: '{"model":"fiction-legacy","effort":"low"}' })
  const shown = JSON.stringify(await $.command.run({ command: 'console', args: 'model' } as any))
  expect(shown.includes('codex · fiction-legacy · low')).toBe(true)
  expect(SETTINGS in h.files).toBe(false)
  await $.command.run({ command: 'console', args: 'effort high' } as any)
  expect(JSON.parse(h.files[SETTINGS]!)).toEqual({ executor: 'codex', model: 'fiction-legacy', effort: 'high' })
  expect(JSON.parse(h.files[LEGACY]!)).toEqual({ model: 'fiction-legacy', effort: 'low' })
})

const STALE_BROKER = 'STALE codex=9.9.9 companion=OK brokers=4242(Project Alpha)'

test('codexFallback=claude sends a blocked Codex dispatch to Claude and records fallbackFrom', { options: { ...BASE, codexFallback: 'claude' } }, async ($, on) => {
  const h = fixture(on, { settings: '{"executor":"codex","model":"fiction-codex","effort":"high"}', preflight: STALE_BROKER })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches.length).toBe(1)
  expect(h.launches[0]![0]).toBe('claude')
  // Codex model names are not passed to Claude.
  expect(h.launches[0]!.includes('fiction-codex')).toBe(false)
  const job = JSON.parse(h.files[SESSIONS]!).roots['d:/project alpha'].jobs[0]
  expect(job.fallbackFrom).toBe('codex')
  expect(job.fallbackReason.includes('broker')).toBe(true)
  expect(h.toasts.some(text => text.includes('Codex 改由 Claude'))).toBe(true)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(await ui.find({ type: 'Text', text: /codex→claude/ })).toBeDefined()
  await ui.unmount()
})

test('codexFallback=ask (default) holds a low-quota Codex dispatch and offers Claude instead', { options: BASE }, async ($, on) => {
  const quota = JSON.stringify({ at: new Date(NOW - 10 * 60_000).toISOString(), rate_limits: { primary: { used_percent: 97, window_minutes: 300, resets_at: NOW / 1000 + 3600 } } })
  const h = fixture(on, { settings: '{"executor":"codex","model":"","effort":""}', quota })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches).toEqual([])
  expect(h.toasts.some(text => text.includes('Codex 未派工') && text.includes('3%'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Codex 未派工：Codex 額度剩 3%/ })).toBeDefined()
  const offer = await ui.find({ key: 'detail-Project Alpha-fallback' })
  expect(offer?.text.includes('改用 Claude 派工')).toBe(true)
  await ui.press({ key: 'detail-Project Alpha-fallback' })
  expect(h.launches.length).toBe(1)
  expect(h.launches[0]![0]).toBe('claude')
  expect(JSON.parse(h.files[SESSIONS]!).roots['d:/project alpha'].jobs[0].fallbackFrom).toBe('codex')
  expect(await ui.find({ key: 'detail-Project Alpha-fallback' })).toBeUndefined()
  await ui.unmount()
})

test('stale quota data alone does not trigger the fallback, and codexFallback=off keeps Codex', { options: { ...BASE, codexFallback: 'claude' } }, async ($, on) => {
  const quota = JSON.stringify({ at: new Date(NOW - 7 * 3_600_000).toISOString(), rate_limits: { primary: { used_percent: 99, window_minutes: 300, resets_at: NOW / 1000 + 3600 } } })
  const h = fixture(on, { settings: '{"executor":"codex","model":"","effort":""}', quota })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches.length).toBe(1)
  expect(h.launches[0]![0]).toBe('node')
  await ui.unmount()
})

test('codexFallback=off dispatches Codex even with a stale broker', { options: { ...BASE, codexFallback: 'off' } }, async ($, on) => {
  const h = fixture(on, { settings: '{"executor":"codex","model":"","effort":""}', preflight: STALE_BROKER })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches.length).toBe(1)
  expect(h.launches[0]![0]).toBe('node')
  await ui.unmount()
})

test('an empty companionScript resolves the newest installed Codex plugin and the pane shows it', { options: { ...BASE, companionScript: '' } }, async ($, on) => {
  const cache = 'C:/Users/example/.claude/plugins/cache/openai-codex/codex'
  const script = [{ name: 'codex-companion.mjs', kind: 'file' }]
  const h = fixture(on, { settings: '{"executor":"codex","model":"","effort":""}', lists: {
    [cache]: [{ name: '1.0.9', kind: 'dir' }, { name: '1.0.10', kind: 'dir' }], [`${cache}/1.0.9/scripts`]: script, [`${cache}/1.0.10/scripts`]: script,
  } })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const resolved = `${cache}/1.0.10/scripts/codex-companion.mjs`
  expect(h.probes[0]!.join('|').includes(`-CompanionScript|${resolved}`)).toBe(true)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /companion：.*1\.0\.10.*自動選用/ })).toBeDefined()
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches[0]!.slice(0, 2)).toEqual(['node', resolved])
  await ui.unmount()
})

test('a configured companion reported MISSING is replaced by the installed one with a warning', { options: BASE }, async ($, on) => {
  const cache = 'C:/Users/example/.claude/plugins/cache/openai-codex/codex'
  const h = fixture(on, {
    settings: '{"executor":"codex","model":"","effort":""}',
    lists: { [cache]: [{ name: '2.0.0', kind: 'dir' }], [`${cache}/2.0.0/scripts`]: [{ name: 'codex-companion.mjs', kind: 'file' }] },
    preflight: argv => `OK codex=0.0.0-test companion=${argv.includes('D:/Tools/companion.mjs') ? 'MISSING' : 'OK'}`,
  })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.probes.length).toBe(2)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /companion：.*2\.0\.0.*⚠ configured companionScript not found/ })).toBeDefined()
  // The healthy re-probe means no fallback: Codex is dispatched with the resolved script.
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches[0]!.slice(0, 2)).toEqual(['node', `${cache}/2.0.0/scripts/codex-companion.mjs`])
  await ui.unmount()
})
