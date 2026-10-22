import { expect, test } from 'claude-code/testing'
import { addFolder, excludeWith, localMinute, newStatusFile, projectNameFor, registryWith } from '../hooks/projects'
import { buildProject, inbox, nextInbox, parseCard, parseRegistry, staleFor } from '../hooks/logic'
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
