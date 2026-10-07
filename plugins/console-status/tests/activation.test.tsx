import { expect, test, mock } from 'claude-code/testing'

// A quick side session gets only the command guard; the console runs where /console is used.
const OPTIONS = { options: { registryPath: 'D:/Fixtures/registry.md' } }
const BAND = { plugin: 'console-status', component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: 160 } } as any
const START = { cwd: 'D:/Alpha', surface: 'terminal', isInteractive: true } as any
const result = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function fixture(on: any, sessionId = 'side') {
  const clock = mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const data = { runs: [] as string[][], asked: [] as string[], session: sessionId }
  on('fs.read', (_: any, e: any) => ({ value: e.path.includes('registry') ? '## STATUS 卡位置\n| Alpha | `D:/Alpha/.console/STATUS.md` |' : e.path.includes('claude-sessions') ? '{"version":1,"roots":{}}' : '' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_: any, e: any) => { data.runs.push(e.argv); return { value: result(e.argv[0] === 'claude' ? '[]' : '') } })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: data.session }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  const store: Record<string, unknown> = {}
  on('store.get', (_: any, e: any) => ({ value: store[e.key] ?? null }))
  on('store.set', (_: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', (_: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      data.asked.push(e.questions[0].question)
      return { result: { questions: e.questions, answers: { [e.questions[0].question]: '拒絕' } } }
    }
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return { data, clock, store }
}

const text = (node: any): string => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')

test('a light session runs nothing in the background and draws no band, but the guard still asks', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(10 * 60_000)
  expect(data.runs).toEqual([])
  const band = await $.ui.mount(BAND)
  expect(text(await band.drawn())).toBe('')
  await band.unmount()
  const refused: any = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' } as any)
  expect(refused.deny).toMatch(/指令護欄/)
  expect(data.asked.length).toBe(1)
})

test('/console starts the console in that session, a resume keeps it, /console off ends it', OPTIONS, async ($, on) => {
  const { data, clock, store } = fixture(on, 'main')
  await $.session.start(START)
  await clock.settle()
  expect(data.runs).toEqual([])
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  await clock.settle()
  expect(data.runs.length).toBeGreaterThan(0)
  expect(store.consoleSessions).toEqual(['main'])

  // A reload or resume of the same session starts the console without asking again.
  data.runs = []
  await $.session.start(START)
  await clock.settle()
  expect(data.runs.length).toBeGreaterThan(0)
  const band = await $.ui.mount(BAND)
  expect(text(await band.drawn())).not.toBe('')
  await band.unmount()

  const off: any = await $.command.run({ command: 'console', args: 'off' } as any)
  expect(off.text).toMatch(/已關閉主控台/)
  expect(store.consoleSessions).toEqual([])
  data.runs = []
  await clock.advance(10 * 60_000)
  expect(data.runs).toEqual([])
})

test('a non-interactive resume of a console session stays light', OPTIONS, async ($, on) => {
  const { data, clock, store } = fixture(on, 'main')
  store.consoleSessions = ['main']
  await $.session.start({ ...START, surface: null, isInteractive: false })
  await clock.settle()
  expect(data.runs).toEqual([])
})

test('activation always runs the console in every session', { options: { ...OPTIONS.options, activation: 'always' } }, async ($, on) => {
  const { data, clock } = fixture(on)
  await $.session.start(START)
  await clock.settle()
  expect(data.runs.length).toBeGreaterThan(0)
})

test('a pane left open across a reload into a light session says how to start the console', OPTIONS, async ($, on) => {
  const { data, clock, store } = fixture(on)
  const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'terminal', props: { title: '主控台', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any
  // The pane was opened before light sessions existed, so this session is not in the active list.
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  await clock.settle()
  store.consoleSessions = []
  data.runs = []
  await $.session.start(START)
  await clock.settle()
  expect(data.runs).toEqual([])
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /讀取各專案狀態中/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /\/console refresh/ })).toBeDefined()

  // /console refresh starts the console and the pane fills.
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  await clock.settle()
  expect(data.runs.length).toBeGreaterThan(0)
  expect(await pane.find({ type: 'Text', text: /沒有啟動主控台/ })).toBeUndefined()
  await pane.unmount()
})
