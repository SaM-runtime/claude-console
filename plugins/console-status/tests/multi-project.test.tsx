import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { localMinute, registryArchive } from '../hooks/projects'
import { capToasts, cursorRow, distinctRows, moveCursor, shortName, sharedFolderNotes } from '../hooks/logic'
import type { Row } from '../hooks/logic'
import { commandTarget, missingTarget } from '../hooks/actions'
import { readJobs, workspaceOf } from '../hooks/jobs'

const NOW = Date.parse('2030-01-10T12:00:00Z')
const MIN = 60_000
const REGISTRY = 'D:/Fixtures/registry.md'
const PANE = (surface = 'terminal') => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface,
  props: { title: 'Console', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
const OPTIONS = { options: { activation: 'always', registryPath: REGISTRY, companionStateRoots: '["D:/State"]', gitProbe: 'off', cacheHint: 'off' } }

const status = (folder: string) => `D:/${folder}/.console/STATUS.md`
const card = (fields: Record<string, string>, at = NOW - 60 * MIN) =>
  `<!-- CARD -->\n- 更新：${localMinute(at)}\n${Object.entries({ 等使用者: '無', 關卡: '無', 下一步: '無', ...fields }).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n<!-- /CARD -->`
/** Registry rows as [name, folder]: a name may be listed twice, each in a folder of its own. */
const registry = (rows: [string, string][]) =>
  `## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n${rows.map(([name, folder]) => `| ${name} | \`${status(folder)}\` |`).join('\n')}\n`

/** A console over the registry `rows`, each with an idle CARD; folders in `dirs` exist without files of their own. */
function fixture(on: any, rows: [string, string][], dirs: string[] = []) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    [REGISTRY]: registry(rows),
    'C:/Users/example/.claude/handoffs/dispatch.json': '{"executor":"claude","model":"","effort":""}',
    'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
  }
  for (const [, folder] of rows) files[status(folder)] = card({})
  const toasts: string[] = []
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
    return { value: { kind: 'file', size: files[path]!.length, mtimeMs: NOW - 60 * MIN, isLink: false } }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text ?? JSON.stringify(e)); return { value: undefined } })
  on('prompt.suggest', () => ({ isShown: true }))
  return { clock, files, toasts }
}

const say = async ($: any, args: string) => ((await $.command.run({ command: 'console', args } as any)) as any).text as string

test('a short name takes as many words as it needs to tell the projects apart', () => {
  const names = ['Project Alpha', 'Project Beta', 'api', 'api gateway', 'web shop']
  expect(shortName('Project Alpha', names)).toBe('Project Alpha')
  expect(shortName('api gateway', names)).toBe('api gateway')
  expect(shortName('api', names)).toBe('api')
  expect(shortName('web shop', names)).toBe('web')
  expect(shortName('My App Server', ['My App Server', 'My Site Builder'])).toBe('My App')
  expect(shortName('My Site', ['My App Server', 'My App Client', 'My Site'])).toBe('My Site')
  expect(shortName('alone here', [])).toBe('alone')
})

test('the registry lists each project once: a name used twice is numbered, a STATUS file listed twice is dropped', () => {
  const { rows, notes } = distinctRows([
    { name: 'api', statusPath: 'C:/a/api/.console/STATUS.md' },
    { name: 'API', statusPath: 'C:/b/api/.console/STATUS.md' },
    { name: 'api 2', statusPath: 'C:/c/api-2/.console/STATUS.md' },
    { name: 'web', statusPath: 'c:/A/api/.console/STATUS.md' },
  ])
  expect(rows.map(row => row.name)).toEqual(['api', 'API 3', 'api 2'])
  expect(notes).toEqual([
    '登錄表有兩個專案叫 API，第二個先顯示成「API 3」；改登錄表的名稱就好',
    '登錄表的 web 和 api 是同一張狀態卡，只列 api',
  ])
  expect(distinctRows([{ name: 'one', statusPath: 'C:/one/STATUS.md' }]).notes).toEqual([])
})

test('projects in folders of one name are named together, since their Codex jobs cannot be told apart', () => {
  expect(sharedFolderNotes([
    { name: 'web', statusPath: 'C:/clientA/web/.console/STATUS.md' },
    { name: 'web 2', statusPath: 'C:/clientB/Web/.console/STATUS.md' },
    { name: 'api', statusPath: 'C:/x/api/.console/STATUS.md' },
  ])).toEqual(['web、web 2 的資料夾同名：Codex 工作分不出是哪一個的，會出現在每一個；改掉資料夾名稱就好'])
  expect(sharedFolderNotes([{ name: 'api', statusPath: 'C:/x/api/.console/STATUS.md' }])).toEqual([])
})

test('a project reads only its own Codex workspace, not one whose folder name starts with its own', async () => {
  expect(workspaceOf('api-0123456789abcdef', 'api')).toBe(true)
  expect(workspaceOf('API-0123456789abcdef', 'api')).toBe(true)
  expect(workspaceOf('api-gateway-0123456789abcdef', 'api')).toBe(false)
  expect(workspaceOf('api-gateway-0123456789abcdef', 'api-gateway')).toBe(true)
  expect(workspaceOf('api-', 'api')).toBe(false)
  const files: Record<string, string> = {
    'D:/State/api-0123456789abcdef/state.json': '{"jobs":[{"id":"mine"}]}',
    'D:/State/api-gateway-fedcba9876543210/state.json': '{"jobs":[{"id":"theirs"}]}',
  }
  const fs = {
    list: async () => Object.keys(files).map(path => ({ name: path.split('/')[2]!, kind: 'dir' })),
    read: async (path: string) => files[path] ?? Promise.reject(new Error('missing')),
  }
  expect((await readJobs(fs, ['D:/State'], 'C:/Work/api')).map(job => job.id)).toEqual(['mine'])
  expect((await readJobs(fs, ['D:/State'], 'C:/Work/api-gateway')).map(job => job.id)).toEqual(['theirs'])
})

test('one refresh toasts three times at most, the last one counting the rest', () => {
  expect(capToasts(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  expect(capToasts(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', '另有 3 則更新，見主控台動態'])
})

test('the cursor keeps a project: it moves from it, and from none or a project gone starts at the top', () => {
  const list = ['b', 'a', 'c'].map(full => ({ full })) as Row[]
  expect(moveCursor(list, null, 1)).toBe('b')
  expect(moveCursor(list, null, -1)).toBe('b')
  expect(moveCursor(list, 'b', 1)).toBe('a')
  expect(moveCursor(list, 'c', 1)).toBe('c')
  expect(moveCursor(list, 'b', -1)).toBe('b')
  expect(moveCursor(list, 'gone', 1)).toBe('b')
  expect(moveCursor([], null, 1)).toBeNull()
  expect(cursorRow(list, 'a')?.full).toBe('a')
  expect(cursorRow(list, null)?.full).toBe('b')
})

test('a typed name that starts several project names says which it could be', () => {
  const projects = [{ name: 'api-gateway' }, { name: 'api' }, { name: 'auth' }, { name: 'web' }]
  expect(commandTarget(projects, 'a')).toBeNull()
  expect(missingTarget(projects, 'a')).toBe('「a」可能是 api-gateway、api、auth；請打完整的專案名稱。')
  expect(missingTarget(projects, 'ap fix the build')).toBe('「ap」可能是 api-gateway、api；請打完整的專案名稱。')
  expect(missingTarget(projects, 'nope')).toBe('找不到專案「nope」。')
  expect(missingTarget(projects, '  ')).toBe('')
})

test('archiving finds the registry row by its STATUS path, so a numbered name moves its own row', () => {
  const text = '## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n| api | `~/a/api/.console/STATUS.md` |\n| api | `~\\b\\api\\.console\\STATUS.md` |\n'
  expect(registryArchive(text, 'api 2', 'C:/Users/me/b/api/.console/STATUS.md', 'C:/Users/me')).toBe(
    '## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n| api | `~/a/api/.console/STATUS.md` |\n\n## 已封存\n\n| Project | STATUS path |\n| --- | --- |\n| api | `~\\b\\api\\.console\\STATUS.md` |\n')
  // Without a path the name finds the first row, as before; a name the registry does not have finds none.
  expect(registryArchive(text, 'api')).toContain('| api | `~\\b\\api\\.console\\STATUS.md` |\n\n## 已封存\n\n| Project | STATUS path |\n| --- | --- |\n| api | `~/a/api/.console/STATUS.md` |\n')
  expect(registryArchive(text, 'api 2')).toBeNull()
})

test('the row cursor stays on its project when a refresh moves the rows', OPTIONS, async ($, on) => {
  const h = fixture(on, [['Alpha', 'alpha'], ['Beta', 'beta'], ['Gamma', 'gamma']])
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.post({ key: 'down' }, { in: 'rows' } as any)
  await ui.post({ key: 'down' }, { in: 'rows' } as any)
  // Gamma now waits on a decision and goes to the top; the cursor was on Beta and stays there.
  h.files[status('gamma')] = card({ 等使用者: '用 A 還是 B？' })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  await ui.post({ key: 'm' }, { in: 'rows' } as any)
  expect(await ui.find({ type: 'Text', text: 'Beta' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Alpha' })).toBeUndefined()
  await ui.post({ key: 'escape' }, { in: 'rows' } as any)
  await ui.post({ key: 'up' }, { in: 'rows' } as any)
  await ui.post({ key: 'm' }, { in: 'rows' } as any)
  expect(await ui.find({ type: 'Text', text: 'Alpha' })).toBeDefined()
  await ui.unmount()
})

test('a refresh that changes many projects at once toasts three times, the last counting the rest', OPTIONS, async ($, on) => {
  const names = ['one', 'two', 'three', 'four', 'five']
  const h = fixture(on, names.map(name => [name, name] as [string, string]))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  for (const name of names) h.files[status(name)] = card({ 等使用者: `${name} 用 A 還是 B？` })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.toasts).toEqual(['one 等你：one 用 A 還是 B？', 'two 等你：two 用 A 還是 B？', '另有 3 則更新，見主控台動態'])
})

test('a name that could mean several projects is answered with them, never one picked silently', OPTIONS, async ($, on) => {
  const h = fixture(on, [['api-gateway', 'api-gateway'], ['api', 'api'], ['auth', 'auth'], ['web', 'web']])
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const settings = h.files['C:/Users/example/.claude/handoffs/dispatch.json']
  expect(await say($, 'project executor manual a')).toBe('「a」可能是 api-gateway、api、auth；請打完整的專案名稱。')
  expect(h.files['C:/Users/example/.claude/handoffs/dispatch.json']).toBe(settings)
  expect(await say($, 'project executor manual api')).toMatch(/^api 派工設定：manual/)
  expect(await say($, 'project executor manual api extra')).toBe('找不到專案「api extra」。')
  expect(await say($, 'continue a')).toBe('「a」可能是 api-gateway、api、auth；請打完整的專案名稱。用法：/console continue <專案名稱>')
})

test('a name the registry uses twice is numbered and said so; archiving it moves its own row', OPTIONS, async ($, on) => {
  const h = fixture(on, [['api', 'clientA/api'], ['api', 'clientB/api'], ['web', 'web']])
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect((await say($, 'project')).split('\n').slice(0, 3).map(line => line.split('：')[0])).toEqual(['api', 'api 2', 'web'])
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Text', text: '⚠ 登錄表有兩個專案叫 api，第二個先顯示成「api 2」；改登錄表的名稱就好' })).toBeDefined()
  await ui.unmount()
  expect(await say($, 'archive api 2')).toBe('api 2：已封存，不再更新（移到登錄表的「已封存」）；要找回來按面板最下面的 ↺ 取回，或 /console unarchive api')
  expect(h.files[REGISTRY]).toBe([
    '## STATUS 卡位置', '| Project | STATUS path |', '| --- | --- |', '| api | `D:/clientA/api/.console/STATUS.md` |', '| web | `D:/web/.console/STATUS.md` |',
    '', '## 已封存', '', '| Project | STATUS path |', '| --- | --- |', '| api | `D:/clientB/api/.console/STATUS.md` |', '',
  ].join('\n'))
})

test('/console add says when another project has a folder of the same name', OPTIONS, async ($, on) => {
  const h = fixture(on, [['web', 'clientA/web']], ['D:/clientB/web'])
  const text = await say($, 'add D:/clientB/web')
  expect(text.split('\n')[0]).toBe('已加入專案「web 2」：建立 .console/STATUS.md、寫進登錄表。')
  expect(text.split('\n').pop()).toBe('注意：web 的資料夾也叫 web；用 Codex 派工時，兩邊的 Codex 工作分不開，最好改掉其中一個資料夾的名稱。')
  expect(h.files[REGISTRY]).toContain('| web 2 | `D:/clientB/web/.console/STATUS.md` |')
  expect(await say($, 'add D:/clientB/web')).toBe('已經登錄過：web 2（D:/clientB/web/.console/STATUS.md）')
})
