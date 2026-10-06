import { expect, test } from 'claude-code/testing'

const scroll = { offset: 0, total: 0, visible: 0 } as any
const PANE = (bodyColumns: number) => ({
  plugin: 'console-status', component: 'Pane', requestId: 'console-status',
  props: { title: '主控台', isFocused: true, bodyColumns, placement: 'dock', scroll } as any,
}) as const

async function demo($: any, on: any) {
  on('clock.now', () => ({ value: Date.parse('2030-01-05T12:00:00Z') }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: '{}' }))
  on('ui.open', () => ({ value: {} }) as any)
  on('ui.close', () => ({ value: undefined }) as any)
  on('command.run', () => ({ text: 'BENEATH' }) as any)
  const out = await $.command.run({ command: 'console', args: 'demo' } as any)
  expect(JSON.stringify(out).includes('示範')).toBe(true)
}

test('terminal: Client rows — click selects, keys move and select', async ($, on) => {
  await demo($, on)
  for (const bodyColumns of [70, 120]) {
    const ui = await $.ui.mount({ ...PANE(bodyColumns), surface: 'terminal' } as any)
    expect(await ui.find({ type: 'Text', text: /^下一步$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /示範 session/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /工作階段「/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /等你/ })).toBeUndefined()
    expect(JSON.stringify(await ui.drawn()).includes('undefined')).toBe(false)
    await ui.pointer({ in: 'rows', type: 'down', x: 12, y: 0, button: 'left' } as any)
    expect(await ui.find({ type: 'Text', text: /已選取 Project-Alpha/ })).toBeDefined()
    await ui.pointer({ in: 'rows', type: 'down', x: 12, y: 0, button: 'left' } as any)
    expect(await ui.find({ type: 'Text', text: /已選取/ })).toBeUndefined()
    await ui.key({ in: 'rows', key: 'down' } as any)
    await ui.key({ in: 'rows', key: 'return' } as any)
    expect(await ui.find({ type: 'Text', text: /已選取/ })).toBeDefined()
    await ui.key({ in: 'rows', key: 'escape' } as any)
    expect(await ui.find({ type: 'Text', text: /已選取/ })).toBeUndefined()
    // Right-click opens the row menu; hover puts the row's full text in the help strip.
    await ui.pointer({ in: 'rows', type: 'down', x: 12, y: 0, button: 'right' } as any)
    expect(await ui.find({ key: 'm-close' })).toBeDefined()
    await ui.press({ key: 'm-close' })
    expect(await ui.find({ key: 'm-close' })).toBeUndefined()
    await ui.pointer({ in: 'rows', type: 'move', x: 12, y: 0 } as any)
    expect(await ui.find({ type: 'Text', text: /^Project-Alpha　$/ })).toBeDefined()
    await ui.press({ key: 'detail' })
    expect(await ui.find({ type: 'Text', text: /前更新$|^無卡片$/ })).toBeDefined()
    await ui.press({ key: 'detail' })
    await ui.unmount()
  }
})

test('mobile: no Client — plain rows with tappable project names', async ($, on) => {
  await demo($, on)
  const ui = await $.ui.mount({ ...PANE(60), surface: 'mobile' } as any)
  expect(await ui.find({ type: 'Text', text: /^ 需決策 $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ 執行中 $/ })).toBeDefined()
  await ui.press({ key: 'sel-Project-Alpha' })
  expect(await ui.find({ type: 'Text', text: /已選取 Project-Alpha/ })).toBeDefined()
  await ui.unmount()
})

test('band: next action and non-zero counters only', async ($, on) => {
  await demo($, on)
  const band = await $.ui.mount({
    plugin: 'console-status', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, bodyColumns: 120, maxRows: 3, bodyRows: 3, scroll } as any,
  } as any)
  // Pane open (demo opened it): the band keeps counters only, the pane carries the next step.
  expect(await band.find({ type: 'Text', text: /^下一步/ })).toBeUndefined()
  await $.command.run({ command: 'console', args: '' } as any)
  expect(await band.find({ type: 'Text', text: /^下一步/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^● 需決策 1$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^○ 閒置 1$/ })).toBeDefined()
  await band.unmount()
})
