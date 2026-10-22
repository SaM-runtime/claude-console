import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { localMinute } from '../hooks/projects'

const NOW = Date.parse('2030-01-10T12:00:00Z')
const DAY = 86_400_000
const REGISTRY = 'D:/Fixtures/registry.md'
const PANE = (surface = 'terminal') => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface,
  props: { title: 'Console', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
const OPTIONS = { options: { activation: 'always', registryPath: REGISTRY, companionStateRoots: '["D:/State"]', gitProbe: 'off', cacheHint: 'off' } }
const AMBER = '#F0C674'

const status = (name: string) => `D:/${name}/.console/STATUS.md`
const card = (fields: Record<string, string>, at: number) =>
  `<!-- CARD -->\n- 更新：${localMinute(at)}\n${Object.entries({ 等使用者: '無', 關卡: '無', 下一步: '無', ...fields }).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n<!-- /CARD -->`
const registry = (names: string[]) => `## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n${names.map(name => `| ${name} | \`${status(name)}\` |`).join('\n')}\n`

/** A console over the given projects (name → CARD); folders listed in `dirs` exist without files of their own. */
function fixture(on: any, cards: Record<string, string>, dirs: string[] = []) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    [REGISTRY]: registry(Object.keys(cards)),
    'C:/Users/example/.claude/handoffs/dispatch.json': '{"executor":"claude","model":"","effort":""}',
    'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
  }
  for (const [name, text] of Object.entries(cards)) files[status(name)] = text
  const toasts: string[] = []
  const runs: string[][] = []
  const exists = (path: string) => path in files || dirs.includes(path) || Object.keys(files).some(file => file.startsWith(path + '/'))
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' })
    return { value: files[path] }
  })
  on('fs.exists', (_: any, e: any) => ({ value: exists(fixturePath(e.path)) }))
  on('fs.stat', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return { value: { kind: 'file', size: files[path]!.length, mtimeMs: NOW - 10 * DAY, isLink: false } }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_: any, e: any) => { runs.push([...e.argv]); return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text ?? JSON.stringify(e)); return { value: undefined } })
  on('prompt.suggest', () => ({ isShown: true }))
  return { clock, files, toasts, runs }
}

const WAITING = {
  'Project Alpha': card({ 等使用者: '用 A 還是 B？' }, NOW - 3_600_000),
  'Project Beta': card({ 關卡: 'review：看測試結果' }, NOW - 7_200_000),
  'Project Delta': card({ 下一步: '加匯出功能' }, NOW - 3_600_000),
  'Project Gamma': card({ 下一步: '補文件' }, NOW - 5 * DAY),
}

test('n opens what waits on you one after another, round again after the last; the next-step card counts them', OPTIONS, async ($, on) => {
  const h = fixture(on, WAITING)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Text', text: '　共 2 件・n 下一件' })).toBeDefined()
  expect(await ui.find({ key: 'm-close' })).toBeUndefined()
  await ui.post({ key: 'n' }, { in: 'rows' } as any)
  expect(await ui.find({ key: 'm-close' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /・n 下一件等你的事・Esc 關閉/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /d 做決定/ })).toBeDefined()
  await ui.post({ key: 'n' }, { in: 'rows' } as any)
  expect(await ui.find({ type: 'Text', text: 'Project Beta' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /g 審核關卡/ })).toBeDefined()
  // Past the last it comes round to the first; an idle project is never on the list.
  await ui.post({ key: 'n' }, { in: 'rows' } as any)
  expect(await ui.find({ type: 'Text', text: 'Project Beta' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /d 做決定/ })).toBeDefined()
  expect(h.toasts).toEqual([])
  await ui.unmount()

  const text = (await $.command.run({ command: 'console', args: 'inbox' } as any) as any).text as string
  expect(text).toBe([
    '等你處理（2 件）：',
    '・Project Alpha：用 A 還是 B？',
    '・Project Beta：審核：看測試結果',
    '久未動：',
    '・Project Gamma：5 天沒動，下一步：補文件',
    '在面板按 n，依序跳到每一件並打開它的動作選單。',
  ].join('\n'))
})

test('with nothing waiting, n says so', OPTIONS, async ($, on) => {
  const h = fixture(on, { 'Project Delta': WAITING['Project Delta'] })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.post({ key: 'n' }, { in: 'rows' } as any)
  expect(h.toasts).toContain('沒有在等你的事')
  expect(await ui.find({ key: 'm-close' })).toBeUndefined()
  await ui.unmount()
  expect((await $.command.run({ command: 'console', args: 'inbox' } as any) as any).text).toBe('沒有在等你的事。')
})

test('a project left alone past staleDays is the one the card offers, its age in amber and marked 久未動', OPTIONS, async ($, on) => {
  fixture(on, { 'Project Delta': WAITING['Project Delta'], 'Project Gamma': WAITING['Project Gamma'] })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE('mobile'))
  expect(await ui.find({ type: 'Text', text: '⇢ 沒有在等你，可以繼續' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '　5 天沒動' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '補文件' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '5天' }))?.props.color).toBe(AMBER)
  expect((await ui.find({ type: 'Text', text: '1時' }))?.props.color).not.toBe(AMBER)
  // The project's own card says so beside its age.
  await ui.press({ key: 'sel-Project Gamma' })
  await ui.press({ key: 'detail' })
  expect(await ui.find({ type: 'Text', text: '久未動' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '5 天前更新' }))?.props.color).toBe(AMBER)
  await ui.unmount()
})

test('staleDays off leaves every project as before', { options: { ...OPTIONS.options, staleDays: 'off' } }, async ($, on) => {
  fixture(on, { 'Project Delta': WAITING['Project Delta'], 'Project Gamma': WAITING['Project Gamma'] })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE('mobile'))
  expect(await ui.find({ type: 'Text', text: '加匯出功能' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /天沒動/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: '5天' }))?.props.color).not.toBe(AMBER)
  await ui.unmount()
})

test('/console add in a project folder registers it with a STATUS file, keeps it out of git, and leaves the session light', { options: { registryPath: REGISTRY } }, async ($, on) => {
  const h = fixture(on, { 'Project Delta': WAITING['Project Delta'] }, ['D:/Work/new-app', 'D:/Work/new-app/.git/info'])
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'D:\\Work\\new-app', surface: 'terminal', isInteractive: true } as any)
  await h.clock.settle()
  const text = (await $.command.run({ command: 'console', args: 'add' } as any) as any).text as string
  expect(text.split('\n')[0]).toBe('已加入專案「new-app」：建立 .console/STATUS.md、.console/ 加進 .git/info/exclude（不會被 commit）、寫進登錄表。')
  // In its own folder the session is trusted already: no word about trust.
  expect(text.includes('信任')).toBe(false)
  expect(h.files[REGISTRY]!.endsWith('| Project Delta | `D:/Project Delta/.console/STATUS.md` |\n| new-app | `D:/Work/new-app/.console/STATUS.md` |\n')).toBe(true)
  expect(h.files['D:/Work/new-app/.console/STATUS.md']!.startsWith('# new-app STATUS\n')).toBe(true)
  expect(h.files['D:/Work/new-app/.console/STATUS.md']).toContain('- 更新：2030-01-10')
  expect(h.files['D:/Work/new-app/.git/info/exclude']).toBe('.console/\n')
  expect(h.toasts[0]).toMatch(/^已加入專案「new-app」/)
  // Nothing was refreshed: the session did not become a console.
  expect(h.runs).toEqual([])

  expect((await $.command.run({ command: 'console', args: 'add' } as any) as any).text).toBe('已經登錄過：new-app（D:/Work/new-app/.console/STATUS.md）')
  expect((await $.command.run({ command: 'console', args: 'add D:/Work/missing' } as any) as any).text).toBe('找不到資料夾：D:/Work/missing')
})

test('/console add <folder> from elsewhere keeps an existing STATUS file and says the folder must be trusted first', OPTIONS, async ($, on) => {
  const h = fixture(on, { 'Project Delta': WAITING['Project Delta'] }, ['D:/Work/api'])
  h.files['D:/Work/api/.console/STATUS.md'] = card({ 下一步: '接著做' }, NOW - 3_600_000)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const text = (await $.command.run({ command: 'console', args: 'add "D:\\Work\\api"' } as any) as any).text as string
  expect(text.split('\n')[0]).toBe('已加入專案「api」：沿用已有的 .console/STATUS.md、寫進登錄表。')
  expect(text).toContain('第一次派工前，要先在那個資料夾開過一次 claude 並選「信任」')
  expect(h.files['D:/Work/api/.console/STATUS.md']).toContain('- 下一步：接著做')
  // A console refreshes at once: the new project is in the table.
  const ui = await $.ui.mount(PANE('mobile'))
  expect(await ui.find({ key: 'sel-api' })).toBeDefined()
  await ui.unmount()
})
