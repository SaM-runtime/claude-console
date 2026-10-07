import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'

const OPTIONS = { options: { registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/companion.mjs', companionStateRoots: '["D:/State"]' } }
const SETTINGS = 'C:/Users/example/.claude/handoffs/dispatch.json'
const PANE = (surface: string) => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface,
  props: { title: 'Console', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)

test('Claude reconciliation shows an unmanaged resume copy warning in the feed', OPTIONS, async ($, on) => {
  mock.env(on, { USERPROFILE: 'C:/Users/example' })
  mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  const original = '11111111-2222-4333-8444-555555555555'
  const copy = '66666666-7777-4888-8999-000000000000'
  const statePath = 'C:/Users/example/.claude/handoffs/claude-sessions.json'
  const files: Record<string, string> = {
    [SETTINGS]: '{"executor":"claude","model":"","effort":""}',
    'D:/Fixtures/registry.md': '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/.console/STATUS.md` |',
    'D:/Project Alpha/.console/STATUS.md': '<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：無\n<!-- /CARD -->',
    [statePath]: JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: original, jobs: [
      { id: 'pending', launchName: 'resume-launch', sessionId: original, root: 'D:/Project Alpha', prompt: 'resume work', startedAt: '2030-01-05T11:00:00Z', status: 'running', phase: 'unknown' },
    ] } } }),
  }
  on('fs.read', (_, e) => ({ value: files[fixturePath(e.path)] ?? '' }))
  on('fs.write', (_, e) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify([{ id: 'abc12345', name: 'resume-launch', sessionId: copy, cwd: 'D:/Project Alpha', kind: 'background', state: 'working' }]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', () => ({ value: undefined }))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE('mobile'))
  expect(await ui.find({ type: 'Text', text: /unmanaged/ })).toBeDefined()
  expect(JSON.parse(files[statePath]).roots['d:/project alpha'].sessionId).toBe(original)
  await ui.unmount()
})

test('executor control defaults to Claude, persists switches, resets settings and gates Codex quota/probes', OPTIONS, async ($, on) => {
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  const files: Record<string, string> = {
    'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
    'D:/Fixtures/registry.md': '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/.console/STATUS.md` |',
    'D:/Project Alpha/.console/STATUS.md': '<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：無\n- 下一步：Run tests\n<!-- /CARD -->',
    'C:/Users/example/.codex/models_cache.json': '{"models":[{"slug":"fiction-alpha","supported_reasoning_levels":[{"effort":"high"}]}]}',
  }
  const calls: any[] = []
  const reads: string[] = []
  let quota = ''
  on('fs.read', (_, e) => { const path = fixturePath(e.path); reads.push(path); return { value: files[path] ?? '' } })
  on('fs.write', (_, e) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    calls.push(e)
    return { value: { exitCode: 0, stdout: e.argv[0] === 'claude' ? '[]' : e.argv.some((arg: string) => /codex-quota\.(ps1|sh)$/.test(arg)) ? quota : 'OK codex=0.0.0-test', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', () => ({ value: undefined }))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE('mobile'))
  expect((await ui.find({ key: 'dispatch-executor' }))?.text).toBe('claude')
  expect(await ui.find({ key: 'q-claude' })).toBeDefined()
  expect(await ui.find({ key: 'q-codex' })).toBeUndefined()
  expect(calls.every(call => call.argv[0] === 'claude' || call.argv[0] === 'git')).toBe(true)
  expect(reads.some(path => path.includes('/.codex/'))).toBe(false)
  await $.command.run({ command: 'console', args: 'model custom-claude-model' } as any)
  await $.command.run({ command: 'console', args: 'effort max' } as any)
  await ui.press({ key: 'dispatch-executor' })
  expect(JSON.parse(files[SETTINGS])).toEqual({ executor: 'codex', model: '', effort: '' })
  expect((await ui.find({ key: 'dispatch-executor' }))?.text).toBe('codex')
  expect(await ui.find({ key: 'q-codex' })).toBeUndefined()
  quota = '{"rate_limits":{"primary":{"used_percent":20,"window_minutes":300}}}'
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(await ui.find({ key: 'q-codex' })).toBeDefined()
  expect(calls.some(call => call.argv.some((arg: string) => /codex-preflight\.(ps1|sh)$/.test(arg)))).toBe(true)
  await ui.press({ key: 'dispatch-model' })
  expect(JSON.parse(files[SETTINGS]).model).toBe('fiction-alpha')
  await $.command.run({ command: 'console', args: 'executor claude' } as any)
  expect(JSON.parse(files[SETTINGS])).toEqual({ executor: 'claude', model: '', effort: '' })
  expect(await ui.find({ key: 'q-codex' })).toBeUndefined()
  await ui.unmount()
  const desktop = await $.ui.mount(PANE('terminal'))
  expect((await desktop.find({ key: 'dispatch-executor' }))?.text).toBe('claude')
  expect(await desktop.find({ key: 'q-codex' })).toBeUndefined()
  await desktop.unmount()
})

test('Claude UI dispatch tracks a background session, shows results and resumes the same project for sync', OPTIONS, async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/.console/STATUS.md` |',
    'D:/Project Alpha/.console/STATUS.md': '<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：無\n- 下一步：Run tests\n<!-- /CARD -->',
    [SETTINGS]: '{"executor":"claude","model":"sonnet","effort":"high"}',
  }
  const sessions: any[] = []
  files['C:/Users/example/.claude/handoffs/claude-sessions.json'] = '{"version":1,"roots":{}}'
  const launches: any[] = []
  const toasts: string[] = []
  const sessionId = '12345678-1234-4234-8234-123456789abc'
  on('fs.read', (_, e) => ({ value: files[fixturePath(e.path)] ?? '' }))
  on('fs.write', (_, e) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    let stdout = ''
    if (e.argv[1] === 'agents') stdout = JSON.stringify(sessions)
    else if (e.argv[1] === 'logs') stdout = 'Working on local tests\n'
    else if (e.argv.includes('--bg')) {
      launches.push(e)
      sessions.splice(0, sessions.length, { id: '12345678', sessionId, kind: 'background', cwd: 'D:/Project Alpha', state: 'working', status: 'busy', startedAt: clock.now(), name: e.argv[e.argv.indexOf('--name') + 1] })
      stdout = '12345678'
    } else throw new Error('Unexpected process in Claude-only mode')
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', (_, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE('mobile'))
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(launches.length).toBe(1)
  expect(launches[0].init).toEqual({ cwd: 'D:/Project Alpha', timeoutMs: 60000 })
  expect(launches[0].argv.includes('--continue')).toBe(false)
  expect(launches[0].argv.includes('sonnet')).toBe(true)
  expect(toasts.filter(text => text.includes('✕'))).toEqual([])
  expect({ stage: 'first dispatch', running: !!await ui.find({ type: 'Text', text: /^ ▶ 執行中 $/ }) }).toEqual({ stage: 'first dispatch', running: true })
  await clock.advance(1000)
  sessions[0].state = 'done'
  sessions[0].status = 'idle'
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect({ stage: 'finished', sync: !!await ui.find({ type: 'Text', text: /^ ↻ 待同步 $/ }) }).toEqual({ stage: 'finished', sync: true })
  expect(await ui.find({ key: 'q-codex' })).toBeUndefined()
  expect(toasts.some(text => text.includes('完成'))).toBe(true)
  await ui.press({ key: 'detail-Project Alpha-sync' })
  expect(launches.length).toBe(2)
  expect(launches[1].argv[launches[1].argv.indexOf('--resume') + 1]).toBe(sessionId)
  expect({ stage: 'sync resumed', running: !!await ui.find({ type: 'Text', text: /^ ▶ 執行中 $/ }) }).toEqual({ stage: 'sync resumed', running: true })
  const persisted = JSON.parse(files['C:/Users/example/.claude/handoffs/claude-sessions.json'])
  const history = persisted.roots['d:/project alpha'].jobs
  expect(history.length).toBe(2)
  expect(history[0].status).toBe('completed')
  expect(history[0].id === history[1].id).toBe(false)
  // The sync writes CARD before refresh observes its completion.
  const cardAt = new Date(clock.now() + 60_000)
  const stamp = `${cardAt.getFullYear()}-${String(cardAt.getMonth() + 1).padStart(2, '0')}-${String(cardAt.getDate()).padStart(2, '0')} ${String(cardAt.getHours()).padStart(2, '0')}:${String(cardAt.getMinutes()).padStart(2, '0')}`
  files['D:/Project Alpha/.console/STATUS.md'] = `<!-- CARD -->\n- 更新：${stamp}\n- 等使用者：無\n- 下一步：Run tests\n<!-- /CARD -->`
  sessions[0].state = 'done'
  sessions[0].status = 'idle'
  await clock.advance(120_000)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect({ stage: 'sync completed after CARD write', sync: !!await ui.find({ type: 'Text', text: /^ ↻ 待同步 $/ }) }).toEqual({ stage: 'sync completed after CARD write', sync: false })
  await ui.unmount()
})
