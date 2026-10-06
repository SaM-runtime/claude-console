import { expect, test, mock } from 'claude-code/testing'

const OPTIONS = { options: { executor: 'claude', registryPath: '/volD/Fixtures/registry.md', companionStateRoots: '["/volD/State"]' } }
const STATUS = '/volD/Private Fixture/.console/STATUS.md'
const NOW = Date.parse('2030-01-05T12:00:00Z')
const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
  props: { title: 'Console', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any
const BAND = { plugin: 'console-status', component: 'AbovePrompt', surface: 'mobile',
  props: { hasSurvey: false, bodyColumns: 70, maxRows: 3, bodyRows: 3, scroll: { offset: 0, total: 0, visible: 0 } } } as any
const result = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function fixture(on: any) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: '/Users/example', LOCALAPPDATA: '/volD/Local', OS: 'Windows_NT' })
  const data = {
    state: {} as Record<string, any>, toasts: [] as string[], fsReads: 0, fsLists: 0, privateReads: 0, processCalls: 0, usageCalls: 0, promptFills: 0,
    ask: 'Choose a synthetic value',
    listDelay: 0, listStarted: 0, listSettled: 0,
    sessionDelay: 0, sessionReadStarted: 0, sessionReadSettled: 0, failSession: false,
  }
  on('fs.read', async (_: any, e: any) => {
    const path = e.path.replace(/\\/g, '/')
    data.fsReads += 1
    const files: Record<string, string> = {
      '/volD/Fixtures/registry.md': [
        '# Synthetic registry',
        '## STATUS 卡位置',
        '| 專案 | STATUS 路徑 |',
        '|---|---|',
        `| Private Fixture | \`${STATUS}\` |`,
      ].join('\n'),
      '/Users/example/.claude/handoffs/dispatch.json': '{"executor":"claude"}',
      '/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
      '/Users/example/.codex/models_cache.json': '{}',
    }
    if (path === '/volD/Fixtures/registry.md' || path === STATUS || path.startsWith('/volD/State/')) data.privateReads += 1
    if (path === STATUS) return { value: [
      '<!-- CARD：開始 -->',
      '- 更新：2030-01-05 11:55',
      '- 狀態：PRIVATE SENTINEL',
      `- 等使用者：${data.ask}`,
      '- 下一步：Keep fixture private',
      '<!-- /CARD -->',
    ].join('\n') }
    if (path === '/Users/example/.claude/handoffs/claude-sessions.json' && data.sessionDelay) {
      data.sessionReadStarted += 1
      await clock.sleep(data.sessionDelay)
      data.sessionReadSettled += 1
      if (data.failSession) throw new Error('PRIVATE SENTINEL session failure')
    }
    return { value: files[path] ?? '' }
  })
  on('fs.list', async () => {
    data.fsLists += 1
    data.listStarted += 1
    if (data.listDelay) await clock.sleep(data.listDelay)
    data.listSettled += 1
    return { value: [] }
  })
  on('process.run', (_: any, e: any) => {
    data.processCalls += 1
    return { value: result(e.argv[0] === 'claude' ? '[]' : 'OK codex=0.0.0-test') }
  })
  on('session.usage', () => { data.usageCalls += 1; return { value: null } })
  on('session.id', () => ({ value: 'fixture-session' }))
  on('ui.toast', (_: any, e: any) => { data.toasts.push(e.text); return { value: undefined } })
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('command.register', (_: any, e: any) => ({ command: e.command }))
  on('prompt.fill', () => { data.promptFills += 1; return { isFilled: true } })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('state.set', async (_: any, e: any, next: any) => {
    const answer = await next(e)
    data.state[e.key] = e.value
    return answer
  })
  return { clock, data }
}

function expectDemoIsPrivate(data: ReturnType<typeof fixture>['data']) {
  expect(data.state.isDemo).toBe(true)
  expect(data.state.snapshot?.demo).toBe(true)
  expect(JSON.stringify(data.state.snapshot)).not.toMatch(/Private|PRIVATE SENTINEL/)
  expect(JSON.stringify(data.state.feed)).not.toMatch(/Private|PRIVATE SENTINEL/)
  expect(data.toasts.join('\n')).not.toMatch(/Private|PRIVATE SENTINEL/)
}

test('demo ignores session, timer, turn and refresh-button probes without leaking real data', OPTIONS, async ($, on) => {
  const { clock, data } = fixture(on)
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const baseline = { reads: data.fsReads, lists: data.fsLists, processes: data.processCalls, usage: data.usageCalls, prompts: data.promptFills }

  await $.session.start({ cwd: '/volD/Console', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(60_000)
  await $.turn.complete({ turnId: 'synthetic-turn', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' })
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'next-action' })
  await pane.press({ key: 'refresh' })

  expect({ reads: data.fsReads, lists: data.fsLists, processes: data.processCalls, usage: data.usageCalls, prompts: data.promptFills }).toEqual(baseline)
  expectDemoIsPrivate(data)
  await pane.unmount()
  await $.command.run({ command: 'console', args: 'refresh' } as any)
})

test('a real refresh that succeeds after demo starts is discarded', OPTIONS, async ($, on) => {
  const { clock, data } = fixture(on)
  data.listDelay = 1_000
  let refreshSettled = false
  const refreshing = $.command.run({ command: 'console', args: 'refresh' } as any).then(value => { refreshSettled = true; return value })
  await clock.settle()
  expect(data.privateReads).toBeGreaterThan(0)
  expect(data.listStarted).toBeGreaterThan(0)
  expect(data.listSettled).toBe(0)
  expect(refreshSettled).toBe(false)
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const toasts = data.toasts.length
  await clock.advance(1_000)
  await refreshing

  expect(refreshSettled).toBe(true)
  expect(data.listSettled).toBeGreaterThan(0)
  expect(data.toasts.length).toBe(toasts)
  expectDemoIsPrivate(data)
  data.listDelay = 0
  await $.command.run({ command: 'console', args: 'refresh' } as any)
})

test('a real refresh error arriving after demo starts is discarded', OPTIONS, async ($, on) => {
  const { clock, data } = fixture(on)
  data.sessionDelay = 1_000
  data.failSession = true
  let refreshSettled = false
  const refreshing = $.command.run({ command: 'console', args: 'refresh' } as any).then(value => { refreshSettled = true; return value })
  await clock.settle()
  expect(data.privateReads).toBeGreaterThan(0)
  expect(data.sessionReadStarted).toBeGreaterThan(0)
  expect(data.sessionReadSettled).toBe(0)
  expect(refreshSettled).toBe(false)
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const toasts = data.toasts.length
  await clock.advance(1_000)
  await refreshing

  expect(refreshSettled).toBe(true)
  expect(data.sessionReadSettled).toBeGreaterThan(0)
  expect(data.toasts.length).toBe(toasts)
  expect(data.state.snapshot?.error).toBe(null)
  expectDemoIsPrivate(data)
  data.sessionDelay = 0
  data.failSession = false
  await $.command.run({ command: 'console', args: 'refresh' } as any)
})

test('/console refresh exits demo and pane plus band show a faint demo chip', OPTIONS, async ($, on) => {
  const { data } = fixture(on)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const livePane = await $.ui.mount(PANE)
  await livePane.press({ key: 'sel-Private Fixture' })
  await livePane.unmount()
  data.ask = 'Changed private decision'
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(data.state.selected).toBe('Private Fixture')
  expect(JSON.stringify(data.state.feed)).toMatch(/Private/)

  data.toasts.length = 0 // Only notices emitted after entering demo are relevant to the isolation boundary.
  await $.command.run({ command: 'console', args: 'demo' } as any)
  expect(data.state.selected).toBe(null)
  expectDemoIsPrivate(data)
  const pane = await $.ui.mount(PANE)
  const band = await $.ui.mount(BAND)
  const paneChip = await pane.find({ type: 'Text', text: /^ 示範資料 $/ })
  const bandChip = await band.find({ type: 'Text', text: /^ 示範資料 $/ })
  expect(paneChip).toBeDefined()
  expect(bandChip).toBeDefined()
  expect(JSON.stringify(paneChip)).toMatch(/#6E7787/)
  expect(JSON.stringify(bandChip)).toMatch(/#6E7787/)
  await pane.unmount()
  await band.unmount()

  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(data.state.isDemo).toBe(false)
  expect(data.state.snapshot?.demo).not.toBe(true)
  expect(data.state.snapshot?.projects.map((project: any) => project.name)).toEqual(['Private Fixture'])
})
