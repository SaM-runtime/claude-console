import { expect, test, mock } from 'claude-code/testing'
import { displayWidth } from '../hooks/logic'

const pane = (surface: string) => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface,
  props: { bodyColumns: 70, scroll: { offset: 0, total: 0, visible: 0 } } } as any)

async function demo($: any, on: any, executor = 'codex') {
  on('clock.now', () => ({ value: Date.parse('2030-01-05T12:00:00Z') }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: JSON.stringify({ executor }) }))
  on('ui.open', () => ({ value: {} }))
  on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'console', args: 'demo' } as any)
}

test('terminal rows fit 70 and 120 columns with an intact age and a right margin', async ($, on) => {
  await demo($, on)
  const text = (node: any): string => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')
  for (const bodyColumns of [70, 120]) {
    const options = pane('terminal')
    options.props.bodyColumns = bodyColumns
    const ui = await $.ui.mount(options)
    await ui.resize({ in: 'rows', columns: bodyColumns, rows: 5 })
    const drawing: any = await ui.drawn({ in: 'rows' })
    for (const row of drawing.children) {
      const cells = row.children
      const gaps = (cells.length - 1) * row.props.gap
      expect(cells.reduce((sum: number, cell: any) => sum + cell.props.width, gaps) <= bodyColumns - 1).toBe(true)
      expect(cells.reduce((sum: number, cell: any) => sum + displayWidth(text(cell)), gaps) <= bodyColumns - 1).toBe(true)
      for (const cell of cells) expect(displayWidth(text(cell)) <= cell.props.width).toBe(true)
      expect(displayWidth(text(cells[cells.length - 1]))).toBe(4)
      expect(text(cells[cells.length - 1]).trim()).toMatch(/^(now|\d+[mhd]|>99d|—)$/)
    }
    await ui.unmount()
  }
})

test('mobile demo shows both quota frames with static battery percentages outside the fill', async ($, on) => {
  await demo($, on)
  const ui = await $.ui.mount(pane('mobile'))
  expect(await ui.find({ type: 'Text', text: /^38%$/ })).toBeDefined()
  expect(await ui.find({ key: 'q-codex' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^69%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^25%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^88%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /餘額 1,000 credits/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^● 正常$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  ・$/ })).toBeUndefined()
  expect((await ui.find({ key: 'help' }))?.props.height).toBe(1)
  expect((await ui.find({ key: 'footer' }))?.props.gap).toBe(1)
  const before = JSON.stringify(await ui.find({ key: 'q-claude' }))
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  await ui.redraw()
  expect(JSON.stringify(await ui.find({ key: 'q-claude' }))).toBe(before)
  await ui.unmount()
})

test('default Claude demo includes review, idle, two feed events and running/completed Codex task details', async ($, on) => {
  await demo($, on, 'claude')
  const ui = await $.ui.mount(pane('mobile'))
  const found = async (query: any) => { const element = await ui.find(query); if (!element) throw new Error('Missing demo UI: ' + JSON.stringify(query)); return element }
  expect((await found({ key: 'dispatch-executor' }))?.text).toBe('claude')
  expect(await found({ key: 'q-claude' })).toBeDefined()
  expect(await found({ key: 'q-codex' })).toBeDefined()
  expect(await found({ type: 'Text', text: /^ 待審核 $/ })).toBeDefined()
  expect(await found({ type: 'Text', text: /^ 閒　置 $/ })).toBeDefined()
  expect(await found({ type: 'Text', text: /^示範：Codex 任務正在執行$/ })).toBeDefined()
  expect(await found({ type: 'Text', text: /^示範：審核關卡已建立$/ })).toBeDefined()
  expect(await found({ type: 'Text', text: /^結果未同步至 STATUS$/ })).toBeDefined()
  await ui.press({ key: 'sel-Sample-Docs' })
  await ui.press({ key: 'detail' })
  expect(await found({ type: 'Text', text: /^執行者任務$/ })).toBeDefined()
  expect(await found({ type: 'Text', text: /前完成/ })).toBeDefined()
  expect(await found({ type: 'Text', text: /^已跑 / })).toBeDefined()
  await ui.unmount()
})

test('terminal battery starts at zero and reaches its target after 400ms', async ($, on) => {
  await demo($, on)
  const ui = await $.ui.mount(pane('terminal'))
  const projectRows: any = await ui.drawn({ in: 'rows' })
  expect(projectRows.children[0].children[1].props.width).toBe(13)
  const value = async () => {
    const leaves = (node: any): string[] => typeof node === 'string' ? [node] : (node?.children ?? []).flatMap(leaves)
    return leaves(await ui.drawn({ in: 'battery-ctx-上下文' })).find(text => /^\d+%$/.test(text))
  }
  expect(await value()).toBe('0%')
  await ui.advance(200)
  expect(await value()).toBe('33%')
  await ui.advance(200)
  expect(await value()).toBe('38%')
  await ui.unmount()
})

test('refresh carries row transitions and fresh feed into Clients, with named fallback sessions', {
  options: { registryPath: 'D:/Fixtures/registry.md', companionStateRoots: '["D:/State"]' },
}, async ($, on) => {
  const clock = mock.clock(on, { now: new Date(2030, 0, 5, 12, 0).getTime() })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  let ask = '無'
  on('fs.read', (_, e) => ({ value: e.path.endsWith('registry.md') ? '## STATUS 卡位置\n| 日本語のサンプル | `D:/Project Alpha/.console/STATUS.md` |'
    : e.path.endsWith('STATUS.md') ? `<!-- CARD -->\n- 更新：2030-01-05 11:48\n- 等使用者：${ask}\n<!-- /CARD -->`
    : e.path.endsWith('claude-sessions.json') ? '{"version":1,"roots":{}}' : '{}' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify([
    { sessionId: 'sample-session', cwd: 'D:/Project Alpha', state: 'blocked' }, {},
  ]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', () => ({ value: undefined }))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /\(未命名 session\)/ })).toBeDefined()
  let table: any = await ui.drawn({ in: 'rows' })
  expect(table.children[0].children[1].props.width).toBe(16)
  expect(table.children[0].props.backgroundColor).toBeUndefined()
  ask = '選擇示範配色'
  await clock.advance(1000)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  table = await ui.drawn({ in: 'rows' })
  expect(table.children[0].props.backgroundColor).toBe('#2C3B4B')
  let activity = JSON.stringify(await ui.drawn({ in: 'feed' }))
  expect(activity.includes('"color":"#E5EAF0"')).toBe(true)
  await ui.advance(1500)
  table = await ui.drawn({ in: 'rows' })
  expect(table.children[0].props.backgroundColor).toBeUndefined()
  await ui.advance(1500)
  activity = JSON.stringify(await ui.drawn({ in: 'feed' }))
  expect(activity.includes('"color":"#E5EAF0"')).toBe(false)
  expect(activity.includes('"color":"#CAD3E0"')).toBe(true)
  await ui.unmount()
})

test('a missing registry names the path and the way out', { options: { registryPath: 'D:/Nowhere/registry.md' } }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example' })
  on('fs.read', () => { throw new Error('missing') })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: null } as any))
  on('session.id', () => ({ value: 'session' }))
  on('ui.toast', () => ({ value: undefined }) as any)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile', props: { bodyColumns: 200, scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  expect(await ui.find({ type: 'Text', text: /找不到登錄表 D:\/Nowhere\/registry\.md.*\/console demo/ })).toBeDefined()
  await ui.unmount()
})
