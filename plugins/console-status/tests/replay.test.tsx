import { expect, test, mock } from 'claude-code/testing'
import { diffToasts, events } from '../hooks/logic'
import { fixturePath } from './fixture-path'

const base = (extra: Record<string, unknown>) => ({ at: 2, projects: [], codex: 'OK', contextPercent: 10, error: null, ...extra }) as any

test('(g) an older session that was already waiting is not announced when the newer one of its project is answered', () => {
  const prev = base({ blocked: [{ name: 'A', why: '等待批准', project: 'alpha' }], waiting: ['A', 'B'] })
  const cur = base({ blocked: [{ name: 'B', why: '停在提問', project: 'alpha' }], waiting: ['B'] })
  expect(diffToasts(prev, cur)).toEqual([])
  expect(events(prev, cur)).toEqual([])
})

test('(g) a session that starts waiting this round is still announced', () => {
  const prev = base({ blocked: [{ name: 'A', why: '等待批准', project: 'alpha' }], waiting: ['A'] })
  const cur = base({ blocked: [{ name: 'B', why: '停在提問', project: 'alpha' }], waiting: ['B'] })
  expect(diffToasts(prev, cur)).toEqual(['session「B」停在提問'])
  expect(events(prev, cur).map(e => e.text)).toEqual(['工作階段「B」停在提問'])
})

const NOW = Date.parse('2030-01-05T12:00:00Z')
const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const SESSIONS = 'C:/Users/example/.claude/handoffs/claude-sessions.json'
const OPTIONS = { options: { activation: 'always', registryPath: 'D:/Fixtures/registry.md', companionStateRoots: '["D:/State"]', gitProbe: 'off' } }

test('(h) after a reload, a warning on a job that finished before this lifetime is not replayed; unfinished or updated ones are', OPTIONS, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example' })
  const job = (id: string, status: string, updatedAt: string, warning: string, done = true) => ({
    id, root: 'D:/Project Alpha', prompt: 'work', startedAt: '2030-01-05T01:00:00Z', status, phase: status, updatedAt, warning,
    ...(done ? { completedAt: updatedAt } : {}),
  })
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project Alpha | \`${STATUS}\` |`,
    [STATUS]: '<!-- CARD -->\n- 更新：2030-01-05 11:00\n- 等使用者：無\n- 下一步：無\n<!-- /CARD -->',
    'C:/Users/example/.claude/handoffs/dispatch.json': '{"executor":"claude"}',
    [SESSIONS]: JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', jobs: [
      job('old-done', 'completed', '2030-01-05T02:11:00Z', 'Claude resume created an unmanaged copy (old)'),
      job('fresh-done', 'completed', '2030-01-05T12:00:00Z', 'Claude resume created an unmanaged copy (fresh)'),
      job('still-open', 'unknown', '2030-01-05T03:00:00Z', 'Claude resume created an unmanaged copy (open)', false),
    ] } } }),
  }
  const toasts: string[] = []
  const state: Record<string, any> = {}
  on('fs.read', (_: any, e: any) => ({ value: files[fixturePath(e.path)] ?? '' }))
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('state.set', async (_: any, e: any, next: any) => { const value = await next(e); state[e.key] = e.value; return value })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const feed = (state.feed ?? []).map((event: any) => event.text)
  expect(feed.some((text: string) => text.includes('(old)'))).toBe(false)
  expect(toasts.some(text => text.includes('(old)'))).toBe(false)
  expect(feed.some((text: string) => text.includes('(fresh)'))).toBe(true)
  expect(feed.some((text: string) => text.includes('(open)'))).toBe(true)
})
