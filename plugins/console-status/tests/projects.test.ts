import { expect, test } from 'claude-code/testing'
import { addFolder, archivedRows, excludeWith, localMinute, newStatusFile, projectNameFor, registryArchive, registryUnarchive, registryWith } from '../hooks/projects'
import { buildProject, inbox, nextInbox, parseCard, parseRegistry, rows, staleFor } from '../hooks/logic'
import { continuable, suggestedPrompt } from '../hooks/actions'
import { staleDaysOption } from '../hooks/config'
import { STATUS_TEMPLATE } from '../hooks/template'

const NOW = Date.parse('2030-01-10T12:00:00Z')
const DAY = 86_400_000
const stamp = (t: number) => localMinute(t)
const card = (fields: Record<string, string>, at = NOW - 3_600_000) =>
  `<!-- CARD -->\n- 更新：${stamp(at)}\n${Object.entries({ 等使用者: '無', 關卡: '無', 下一步: '無', ...fields }).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n<!-- /CARD -->`
const project = (name: string, fields: Record<string, string>, at?: number, jobs: any[] = []) =>
  buildProject({ name, statusPath: `D:/${name}/.console/STATUS.md` }, card(fields, at), jobs, NOW)
const snap = (projects: any[]) => ({ at: NOW, projects, blocked: [], codex: '', contextPercent: null, error: null }) as any

test('the inbox lists what waits on you, one item per project, most urgent first; n walks it and comes round again', () => {
  const ci = { ...project('Delta', { 下一步: '修 CI' }), pr: { number: 7, title: 'x', state: 'OPEN', draft: false, url: '', checks: { pass: 3, fail: 1, pending: 0, failing: ['test (ubuntu)'] } } }
  const s = snap([
    project('Echo', { 驗證: '`npm test` → FAIL' }),
    ci,
    project('Beta', { 關卡: 'review：看結果' }),
    project('Alpha', { 等使用者: '用 A 還是 B？' }),
    project('Idle', { 下一步: '寫文件' }),
  ])
  const failed = (p: any) => p.name === 'Echo'
  expect(inbox(s, failed).map(item => [item.project, item.kind])).toEqual([['Alpha', 'action'], ['Beta', 'gate'], ['Delta', 'ci'], ['Echo', 'verify']])
  expect(inbox(s, failed).find(item => item.kind === 'ci')!.text).toBe('PR #7 的 CI 失敗：test (ubuntu)')
  // A project already waiting for a decision is listed once, for its decision.
  const both = { ...project('Alpha', { 等使用者: '用 A 還是 B？' }), pr: ci.pr }
  expect(inbox(snap([both])).map(item => item.kind)).toEqual(['action'])
  const items = inbox(s, failed)
  expect(nextInbox(items, null)!.project).toBe('Alpha')
  expect(nextInbox(items, 'Alpha')!.project).toBe('Beta')
  expect(nextInbox(items, 'Echo')!.project).toBe('Alpha')
  expect(nextInbox(items, 'Idle')!.project).toBe('Alpha')
  expect(nextInbox([], null)).toBeUndefined()
  expect(inbox({ ...s, error: '讀不到登錄表' })).toEqual([])
})

test('a project is stale only past staleDays and only while something is left to do', () => {
  const old = NOW - 5 * DAY
  expect(staleFor(project('A', { 下一步: '寫測試' }, old), NOW, 3)).toBe(5)
  expect(staleFor(project('A', { 下一步: '寫測試' }, old), NOW, 7)).toBeNull()
  expect(staleFor(project('A', { 下一步: '寫測試' }, old), NOW, null)).toBeNull()
  expect(staleFor(project('A', { 下一步: '寫測試' }, NOW - DAY), NOW, 3)).toBeNull()
  // Nothing left: a finished project idles without nagging.
  expect(staleFor(project('A', { 下一步: '無' }, old), NOW, 3)).toBeNull()
  expect(staleFor(project('A', { 等使用者: '要上線嗎？' }, old), NOW, 3)).toBe(5)
  expect(staleFor(project('A', { 關卡: 'release：0.3.0' }, old), NOW, 3)).toBe(5)
  // A job running on it is progress, whatever the CARD says.
  const running = project('A', { 下一步: '寫測試' }, old, [{ id: 'j1', status: 'running', phase: 'running', startedAt: new Date(NOW - 60_000).toISOString() }])
  expect(staleFor(running, NOW, 3)).toBeNull()

  expect(staleDaysOption(undefined)).toBe(3)
  expect(staleDaysOption('')).toBe(3)
  expect(staleDaysOption('7')).toBe(7)
  expect(staleDaysOption('0')).toBe(1)
  expect(staleDaysOption('400')).toBe(60)
  expect(staleDaysOption('off')).toBeNull()
  expect(staleDaysOption('soon')).toBe(3)
})

test('with nothing waiting, the project left alone longest is the one to continue; off keeps the table order', () => {
  const s = snap([
    project('Fresh', { 下一步: '加功能' }, NOW - 3_600_000),
    project('Old', { 下一步: '補文件' }, NOW - 4 * DAY),
    project('Older', { 下一步: '修 bug' }, NOW - 9 * DAY),
  ])
  expect(continuable(s, {}, 3)!.name).toBe('Older')
  expect(suggestedPrompt(s, {}, 3)).toBe('/console continue Older')
  expect(continuable(s, {}, null)!.name).toBe('Fresh')
  expect(suggestedPrompt(s)).toBe('/console continue Fresh')
  // One already pressed is skipped as before.
  expect(continuable(s, { 'D:/Older/.console/STATUS.md': { kind: 'continue', at: NOW } }, 3)!.name).toBe('Old')
})

test('/console add: the folder, a free name, the registry row and the excluded STATUS folder', () => {
  expect(addFolder('', 'D:\\Work\\new app\\')).toBe('D:/Work/new app')
  expect(addFolder('"D:/Work/my api"', 'D:/Console')).toBe('D:/Work/my api')
  expect(addFolder('  ', null)).toBeNull()
  expect(addFolder('/', null)).toBe('/')
  // `~` is the home folder (`~\\` on Windows); a relative folder is the session's, `..` and `.` resolved.
  expect(addFolder('~/projects/api', '/home/me/work', '/home/me')).toBe('/home/me/projects/api')
  expect(addFolder('~\\專案', 'D:/Console', 'C:\\Users\\me')).toBe('C:/Users/me/專案')
  expect(addFolder('"~"', null, '/home/me/')).toBe('/home/me')
  expect(addFolder('~other/api', '/home/me', '/home/me')).toBe('~other/api')
  expect(addFolder('~/api', null)).toBe('~/api')
  expect(addFolder('..\\web', 'D:\\Work\\api', '')).toBe('D:/Work/web')
  expect(addFolder('./sub/', '/srv/app', '')).toBe('/srv/app/sub')
  expect(addFolder('../../..', '/srv/app', '')).toBe('/')
  expect(addFolder('..', 'C:/', '')).toBe(addFolder('C:/', null))
  expect(addFolder('sub', null)).toBe('sub')
  expect(addFolder('D:/Work/api', '/home/me', '/home/me')).toBe('D:/Work/api')

  expect(projectNameFor('D:/Work/api', ['Web'])).toBe('api')
  expect(projectNameFor('D:/Work/api', ['API', 'api 2'])).toBe('api 3')
  expect(projectNameFor('D:/Work/a|b', [])).toBe('a-b')

  // A new file gets the whole table; the parser reads the row back.
  const made = registryWith(null, 'api', 'D:/Work/api/.console/STATUS.md')
  expect(made.startsWith('# Project registry\n\n## STATUS 卡位置\n\n| Project | STATUS path |\n| --- | --- |\n| api | `D:/Work/api/.console/STATUS.md` |\n')).toBe(true)
  expect(parseRegistry(made, 'C:/Users/example')).toEqual([{ name: 'api', statusPath: 'D:/Work/api/.console/STATUS.md' }])
  // An existing table keeps its rows, its columns and what follows; a blank Executor is the global default.
  const existing = '# Registry\r\n\r\n## STATUS 卡位置\r\n\r\n| Project | STATUS path | Scope | Executor |\r\n| --- | --- | --- | --- |\r\n| Web | `D:/Web/.console/STATUS.md` | UI | codex |\r\n\r\n## Console rules\r\n\r\n- Read only the CARD.\r\n'
  const added = registryWith(existing, 'api', 'D:/Work/api/.console/STATUS.md')
  expect(added).toBe(existing.replace('| codex |\r\n', '| codex |\r\n| api | `D:/Work/api/.console/STATUS.md` |  |  |\r\n'))
  expect(parseRegistry(added, '').map(row => [row.name, row.executor])).toEqual([['Web', 'codex'], ['api', undefined]])
  // A registry without the section gets one at the end.
  expect(registryWith('# Notes\n', 'api', 'D:/api/.console/STATUS.md')).toBe('# Notes\n\n## STATUS 卡位置\n\n| Project | STATUS path |\n| --- | --- |\n| api | `D:/api/.console/STATUS.md` |\n')

  expect(excludeWith(null)).toBe('.console/\n')
  expect(excludeWith('# git ls-files --others --exclude-from=.git/info/exclude\n*.log')).toBe('# git ls-files --others --exclude-from=.git/info/exclude\n*.log\n.console/\n')
  expect(excludeWith('*.log\n/.console/\n')).toBeNull()
})

test('a new STATUS file is the workflow template with a CARD the console reads as just added', () => {
  const text = newStatusFile('api', '2030-01-10 20:00')
  expect(text.startsWith('# api STATUS\n')).toBe(true)
  expect(parseCard(text)).toEqual({ 更新: '2030-01-10 20:00 · rev 1 · /console add', 狀態: '剛加入主控台，還沒有工作紀錄', 驗證: '', 執行中: '無', 等使用者: '無', 下一步: '無', 關卡: '無' })
  // Everything after the CARD is the template's, rules included.
  const rest = (value: string) => value.slice(value.indexOf('<!-- /CARD -->'))
  expect(rest(text)).toBe(rest(STATUS_TEMPLATE))
  const p = buildProject({ name: 'api', statusPath: 'D:/api/.console/STATUS.md' }, text, [], NOW)
  expect(p.hasCard).toBe(true)
  expect(continuable(snap([p]))).toBeUndefined()
})

test('⊟ 封存 moves a row to the 已封存 section and ↺ 取回 moves it back; the table and the rest stay as they were', () => {
  const registry = '# Registry\r\n\r\n## STATUS 卡位置\r\n\r\n| Project | STATUS path | Executor |\r\n| --- | --- | --- |\r\n| Web | `D:/Web/.console/STATUS.md` | codex |\r\n| api | `~/api/.console/STATUS.md` |  |\r\n| Docs | `D:/Docs/.console/STATUS.md` |  |\r\n\r\n`Executor` is optional.\r\n\r\n## Console rules\r\n\r\n- Read only the CARD.\r\n'
  const archived = registryArchive(registry, 'api')!
  // The row leaves the list, the paragraph and the next section stay; the section is made at the end, same header.
  expect(archived).toBe(registry.replace('| api | `~/api/.console/STATUS.md` |  |\r\n', '') +
    '\r\n## 已封存\r\n\r\n| Project | STATUS path | Executor |\r\n| --- | --- | --- |\r\n| api | `~/api/.console/STATUS.md` |  |\r\n')
  expect(parseRegistry(archived, 'C:/Users/me').map(row => row.name)).toEqual(['Web', 'Docs'])
  expect(archivedRows(archived, 'C:/Users/me')).toEqual([{ name: 'api', statusPath: 'C:/Users/me/api/.console/STATUS.md' }])
  // A second one joins the same section, with its Executor cell.
  const two = registryArchive(archived, 'Web')!
  expect(archivedRows(two, '').map(row => [row.name, row.executor])).toEqual([['api', undefined], ['Web', 'codex']])
  expect(parseRegistry(two, '').map(row => row.name)).toEqual(['Docs'])
  // Back again: last in the list, and the section goes with its last row.
  const one = registryUnarchive(two, 'api')!
  expect(parseRegistry(one, 'C:/Users/me').map(row => row.name)).toEqual(['Docs', 'api'])
  expect(archivedRows(one, '').map(row => row.name)).toEqual(['Web'])
  const none = registryUnarchive(one, 'Web')!
  expect(none.includes('已封存')).toBe(false)
  expect(parseRegistry(none, '').map(row => [row.name, row.executor])).toEqual([['Docs', undefined], ['api', undefined], ['Web', 'codex']])
  expect(none.endsWith('- Read only the CARD.\r\n')).toBe(true)
  // Unknown names change nothing.
  expect(registryArchive(registry, 'Nope')).toBeNull()
  expect(registryUnarchive(registry, 'api')).toBeNull()
  expect(registryArchive('# Notes\n', 'api')).toBeNull()
})

test('an archived section someone wrote keeps its notes; a project registered again keeps its row', () => {
  const registry = '## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n| api | `D:/api/.console/STATUS.md` |\n\n## 已封存\n\n舊專案，之後再看。\n'
  const archived = registryArchive(registry, 'api')!
  expect(archived).toBe('## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n\n## 已封存\n\n| Project | STATUS path |\n| --- | --- |\n| api | `D:/api/.console/STATUS.md` |\n\n舊專案，之後再看。\n')
  // The note keeps the section when its last row leaves.
  const back = registryUnarchive(archived, 'api')!
  expect(back).toBe('## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n| api | `D:/api/.console/STATUS.md` |\n\n## 已封存\n\n| Project | STATUS path |\n| --- | --- |\n\n舊專案，之後再看。\n')
  // Added again by hand meanwhile: taking the archived copy back does not list it twice.
  const twice = registryWith(archived, 'api', 'D:/api/.console/STATUS.md')
  const merged = registryUnarchive(twice, 'api')!
  expect(parseRegistry(merged, '').map(row => row.name)).toEqual(['api'])
  expect(archivedRows(merged, '')).toEqual([])
})

test('▴ 置頂 puts a project first within its state and first to continue; the state order still comes first', () => {
  const pin = (p: any) => ({ ...p, pinned: true })
  const s = snap([
    project('Alpha', { 下一步: '加功能' }),
    project('Beta', { 等使用者: '用 A 還是 B？' }),
    pin(project('Gamma', { 下一步: '補文件' }, NOW - 3_600_000)),
    pin(project('Delta', { 等使用者: '要上線嗎？' })),
    project('Old', { 下一步: '修 bug' }, NOW - 9 * DAY),
  ])
  expect(rows(s).map(r => [r.full, r.state, !!r.pinned])).toEqual([
    ['Delta', 'ACTION', true], ['Beta', 'ACTION', false], ['Gamma', 'IDLE', true], ['Alpha', 'IDLE', false], ['Old', 'IDLE', false],
  ])
  expect(inbox(s).map(item => item.project)).toEqual(['Delta', 'Beta'])
  // The kinds without a state of their own (CI, verification) take the pinned first too.
  expect(inbox(s, p => p.name === 'Alpha' || p.name === 'Gamma').map(item => item.project)).toEqual(['Delta', 'Beta', 'Gamma', 'Alpha'])
  // With nothing waiting, a pinned project is continued before one left alone longer.
  const idle = snap(s.projects.filter((p: any) => !p.ask || p.ask === '無'))
  expect(continuable(idle, {}, 3)!.name).toBe('Gamma')
  expect(suggestedPrompt(idle, {}, 3)).toBe('/console continue Gamma')
  // Without pins the oldest comes first, as before.
  expect(continuable(snap(idle.projects.map(({ pinned, ...p }: any) => p)), {}, 3)!.name).toBe('Old')
})
