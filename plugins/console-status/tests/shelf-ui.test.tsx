import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { localMinute } from '../hooks/projects'

const NOW = Date.parse('2030-01-10T12:00:00Z')
const MIN = 60_000
const REGISTRY = 'D:/Fixtures/registry.md'
const PANE = (surface = 'terminal') => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface,
  props: { title: 'Console', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
const BAND = { plugin: 'console-status', component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: 120 } } as any
const OPTIONS = { options: { activation: 'always', registryPath: REGISTRY, companionStateRoots: '["D:/State"]', gitProbe: 'off', cacheHint: 'off', awayMinutes: '5' } }

const status = (name: string) => `D:/${name}/.console/STATUS.md`
const card = (fields: Record<string, string>, at: number) =>
  `<!-- CARD -->\n- 更新：${localMinute(at)}\n${Object.entries({ 等使用者: '無', 關卡: '無', 下一步: '無', ...fields }).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n<!-- /CARD -->`
const registry = (names: string[]) => `## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n${names.map(name => `| ${name} | \`${status(name)}\` |`).join('\n')}\n`

/** A console over the given projects (name → CARD), with a store and the files it reads. */
function fixture(on: any, cards: Record<string, string>) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    [REGISTRY]: registry(Object.keys(cards)),
    'C:/Users/example/.claude/handoffs/dispatch.json': '{"executor":"claude","model":"","effort":""}',
    'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
  }
  for (const [name, text] of Object.entries(cards)) files[status(name)] = text
  const toasts: string[] = []
  const reads: string[] = []
  const store: Record<string, unknown> = {}
  const exists = (path: string) => path in files || Object.keys(files).some(file => file.startsWith(path + '/'))
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    reads.push(path)
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' })
    return { value: files[path] }
  })
  on('fs.exists', (_: any, e: any) => ({ value: exists(fixturePath(e.path)) }))
  on('fs.stat', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return { value: { kind: 'file', size: files[path]!.length, mtimeMs: NOW - 10 * MIN, isLink: false } }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('store.get', (_: any, e: any) => ({ value: store[e.key] ?? null }))
  on('store.set', (_: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text ?? JSON.stringify(e)); return { value: undefined } })
  on('prompt.suggest', () => ({ isShown: true }))
  return { clock, files, toasts, reads, store }
}

const CARDS = {
  'Project Alpha': card({ 下一步: '加匯出功能' }, NOW - 60 * MIN),
  'Project Delta': card({ 下一步: '補文件' }, NOW - 60 * MIN),
  'Project Gamma': card({ 下一步: '寫測試' }, NOW - 60 * MIN),
}
/** The table's rows in order, as the plain (phone) table draws them: `sel-<name>` buttons with their labels. */
const order = async (ui: any) => [...JSON.stringify(await ui.drawn()).matchAll(/"key":"sel-([^"]+)"/g)].map(m => m[1])

test('⊟ 封存 moves a project out of the table and its refreshes; ↺ 取回 and /console add bring it back', OPTIONS, async ($, on) => {
  const h = fixture(on, CARDS)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.post({ menu: 'Project Delta' }, { in: 'rows' } as any)
  await ui.press({ key: 'm-archive' })
  expect(h.files[REGISTRY]).toBe(registry(['Project Alpha', 'Project Gamma']) + `\n## 已封存\n\n| Project | STATUS path |\n| --- | --- |\n| Project Delta | \`${status('Project Delta')}\` |\n`)
  expect(h.toasts.some(text => text.startsWith('Project Delta：已封存，不再更新'))).toBe(true)
  expect(await ui.find({ key: 'm-close' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '⊟ 已封存 1：Project Delta' })).toBeDefined()
  // Not read again: an archived project costs nothing on a refresh.
  h.reads.length = 0
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.reads.includes(status('Project Delta'))).toBe(false)
  expect(h.reads.includes(status('Project Alpha'))).toBe(true)

  await ui.press({ key: 'archived-toggle' })
  await ui.press({ key: `unarchive-${status('Project Delta')}` })
  expect(h.files[REGISTRY]).toBe(registry(['Project Alpha', 'Project Gamma', 'Project Delta']))
  expect(await ui.find({ type: 'Text', text: /已封存 1/ })).toBeUndefined()
  await ui.unmount()

  // The command does the same; adding an archived folder brings it back instead of listing it twice.
  expect(((await $.command.run({ command: 'console', args: 'archive Project Gamma' } as any)) as any).text).toMatch(/^Project Gamma：已封存/)
  expect(((await $.command.run({ command: 'console', args: 'unarchive' } as any)) as any).text).toBe('已封存：Project Gamma；用 /console unarchive <專案名稱> 取回。')
  const added = ((await $.command.run({ command: 'console', args: 'add D:/Project Gamma' } as any)) as any).text
  expect(added).toBe('這個資料夾之前封存過。Project Gamma：已取回，回到專案清單')
  expect(h.files[REGISTRY]).toBe(registry(['Project Alpha', 'Project Delta', 'Project Gamma']))
  expect(((await $.command.run({ command: 'console', args: 'unarchive Gamma' } as any)) as any).text).toBe('沒有已封存的專案。')
})

test('▴ 置頂 sorts a project first in its state for every console, and is the one the next-step card continues', OPTIONS, async ($, on) => {
  const h = fixture(on, CARDS)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const phone = await $.ui.mount(PANE('mobile'))
  expect(await order(phone)).toEqual(['Project Alpha', 'Project Delta', 'Project Gamma'])
  const pinned = ((await $.command.run({ command: 'console', args: 'pin Project Gamma' } as any)) as any).text
  expect(pinned).toBe('Project Gamma：已置頂，同一個狀態裡排在最前面，也先建議繼續它')
  expect(await order(phone)).toEqual(['Project Gamma', 'Project Alpha', 'Project Delta'])
  expect((await phone.find({ key: 'sel-Project Gamma' }))?.props.label).toBe('▴ Project Gamma')
  expect(Object.keys(h.store.pinned as object)).toEqual([status('Project Gamma')])
  // A refresh reads it back from the store.
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(await order(phone)).toEqual(['Project Gamma', 'Project Alpha', 'Project Delta'])
  expect(((await $.command.run({ command: 'console', args: 'pin' } as any)) as any).text.startsWith('置頂：Project Gamma\n')).toBe(true)
  await phone.unmount()

  // The menu's button takes it off again.
  const ui = await $.ui.mount(PANE())
  await ui.post({ menu: 'Project Gamma' }, { in: 'rows' } as any)
  expect((await ui.find({ key: 'm-pin' }))?.props.label).toBe('▵ 取消置頂')
  await ui.press({ key: 'm-pin' })
  expect((await ui.find({ key: 'm-pin' }))?.props.label).toBe('▴ 置頂')
  expect(h.store.pinned).toEqual({})
  await ui.unmount()
  expect(((await $.command.run({ command: 'console', args: 'pin Nope' } as any)) as any).text).toBe('找不到專案「Nope」。用法：/console pin <專案名稱>（加上 off 取消置頂）')
})

test('back after awayMinutes, the pane and the band sum up what happened; ✓ 知道了 puts it away', { ...OPTIONS, timeoutMs: 20_000 }, async ($, on) => {
  const h = fixture(on, CARDS)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ key: 'away-dismiss' })).toBeUndefined()
  // While nobody is at the console, a decision arrives and another project's CARD is written.
  h.files[status('Project Delta')] = card({ 等使用者: '用 A 還是 B？', 下一步: '補文件' }, NOW - 60 * MIN)
  h.files[status('Project Alpha')] = card({ 下一步: '加匯出功能' }, NOW + MIN)
  await h.clock.advance(2 * MIN)
  // Two minutes is not away yet.
  expect(await ui.find({ key: 'away-dismiss' })).toBeUndefined()
  await h.clock.advance(4 * MIN)
  expect(await ui.find({ type: 'Text', text: '◷ 你離開的 6 分鐘裡' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 件新的等你處理・狀態卡更新 1 次' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '· Project　新的決策項目' })).toBeDefined()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: '◷ 離開期間 2 則' })).toBeDefined()
  await band.unmount()

  // Asking for the inbox is coming back: it starts with the same digest, which then stays up.
  const inbox = ((await $.command.run({ command: 'console', args: 'inbox' } as any)) as any).text as string
  expect(inbox.split('\n').slice(0, 3)).toEqual([
    '你離開的 6 分鐘裡：1 件新的等你處理・狀態卡更新 1 次',
    '・Project：新的決策項目（5 分鐘前）',
    '・Project：STATUS 已更新（5 分鐘前）',
  ])
  await h.clock.advance(MIN)
  expect(await ui.find({ type: 'Text', text: '◷ 你離開的 6 分鐘裡' })).toBeDefined()
  await ui.press({ key: 'away-dismiss' })
  expect(await ui.find({ key: 'away-dismiss' })).toBeUndefined()
  // Present again: a new line soon after makes no digest.
  h.files[status('Project Gamma')] = card({ 下一步: '寫測試' }, NOW + 8 * MIN)
  await h.clock.advance(2 * MIN)
  expect(await ui.find({ key: 'away-dismiss' })).toBeUndefined()
  await ui.unmount()
})
