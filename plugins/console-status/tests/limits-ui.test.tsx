import { expect, test, mock } from 'claude-code/testing'

const NOW = Date.parse('2030-01-05T12:00:00Z')
const pane = (surface: string, bodyColumns = 100) => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface,
  props: { title: 'Console', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
const result = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** A console over one project, with the host reporting the given rate-limit windows. */
function fixture(on: any, rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) {
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  on('fs.read', (_: any, e: any) => ({ value: e.path.endsWith('registry.md') ? '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/.console/STATUS.md` |'
    : e.path.endsWith('STATUS.md') ? '<!-- CARD -->\n- 更新：2030-01-05 11:48\n- 狀態：示範\n- 等使用者：無\n- 下一步：無\n- 關卡：無\n<!-- /CARD -->'
    : e.path.endsWith('claude-sessions.json') ? '{"version":1,"roots":{}}' : '{}' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => result('[]'))
  on('session.usage', () => ({ value: { context: { percent: 40 }, rateLimits } } as any))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', () => ({ value: undefined }))
}

const OPTIONS = { options: { activation: 'always', registryPath: 'D:/Fixtures/registry.md', companionStateRoots: '["D:/State"]' } }

test('the usage pane draws every window the host reports; a per-model one is named after its model and has its own help', OPTIONS, async ($, on) => {
  fixture(on, [
    { kind: 'five_hour', percentUsed: 31, resetsAt: new Date(NOW + 4 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 75, resetsAt: new Date(NOW + 2 * 86_400_000).toISOString() },
    { kind: 'seven_day_fable', percentUsed: 48, resetsAt: new Date(NOW + 2 * 86_400_000).toISOString() },
  ])
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  for (const surface of ['terminal', 'mobile']) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: '5 小時' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '本週' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Fable 週' })).toBeDefined()
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.includes('undefined')).toBe(false)
    expect(drawn.includes('help-limit_seven_day_fable')).toBe(true)
    expect(drawn.includes('Fable 週：Claude 帳號本週 Fable 專用額度的剩餘量')).toBe(true)
    expect(drawn.includes('本週：Claude 帳號每週額度的剩餘量')).toBe(true)
    await ui.unmount()
  }
})

test('a third window is no longer cut off, and an unknown kind is shown by its name', OPTIONS, async ($, on) => {
  fixture(on, [
    { kind: 'five_hour', percentUsed: 10 },
    { kind: 'seven_day', percentUsed: 20 },
    { kind: 'spend_limit', percentUsed: 30 },
    { kind: 'seven_day_mythos', percentUsed: 40 },
  ])
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: '花費上限' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'mythos 週' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn()).includes('undefined')).toBe(false)
  await ui.unmount()
})

test('demo mode shows the per-model weekly row', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: '{}' }))
  on('ui.open', () => ({ value: {} }) as any)
  on('ui.close', () => ({ value: undefined }) as any)
  on('command.run', () => ({ text: 'BENEATH' }) as any)
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const ui = await $.ui.mount(pane('terminal', 100))
  expect(await ui.find({ type: 'Text', text: 'Fable 週' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '本週' })).toBeDefined()
  await ui.unmount()
})

test('a window used faster than it refills says when it runs out; one that lasts says nothing more', OPTIONS, async ($, on) => {
  fixture(on, [
    { kind: 'five_hour', percentUsed: 31, resetsAt: new Date(NOW + 4 * 3_600_000).toISOString() },
    { kind: 'seven_day_fable', percentUsed: 48, resetsAt: new Date(NOW + 2 * 86_400_000).toISOString() },
  ])
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(pane('terminal'))
  // One hour into the five-hour window at 31%: the rest lasts about 2 h 14 min, the reset is 4 h away.
  expect(await ui.find({ type: 'Text', text: '・照目前速度約 2 小時 14 分後用完' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn()).match(/照目前速度/g)?.length).toBe(1)
  await ui.unmount()
})
