import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { parseCodexQuota, jobTasks, taskTitle, taskMeta, lastLogLine, runLine, battery, resetText, bandText, blockedSessions, buildProject, diffToasts, hasAsk, parseCard, parseRegistry, projectRoot, relevantCodex, focusLine, shortAsk, relevantBlocked, selectionContext } from '../hooks/logic'

const REGISTRY = [
  '# 案件範圍界線',
  '## STATUS 卡位置（主控台只讀）',
  '| 案件 | STATUS 路徑 |',
  '|---|---|',
  '| Project Alpha | `~/.codex/worktrees/k/Project Alpha-App/.console/STATUS.md` |',
  '| Project Beta | `~/Documents/Codex/project beta-localization/STATUS.md` |',
  '',
  '## 其他段落',
  '| 不是 | `這列` |',
].join('\n')

const card = (ask: string, updated = '2030-01-05 09:40') =>
  `# X STATUS\n<!-- CARD：說明 -->\n- 更新：${updated}（job x）\n- 狀態：SAMPLE PASS\n- 驗證：\`php t.php\` → PASS\n- 等使用者：${ask}\n- 下一步：派工\n<!-- /CARD -->\n## 範圍`

const NOW = new Date(2030, 0, 5, 12, 0).getTime()

test('registry rows come only from the STATUS table, with ~ expanded', () => {
  const rows = parseRegistry(REGISTRY, 'C:/Users/me')
  expect(rows.length).toBe(2)
  expect(rows[0].statusPath).toBe('C:/Users/me/.codex/worktrees/k/Project Alpha-App/.console/STATUS.md')
  expect(projectRoot(rows[0].statusPath)).toBe('C:/Users/me/.codex/worktrees/k/Project Alpha-App')
  expect(projectRoot(rows[1].statusPath)).toBe('C:/Users/me/Documents/Codex/project beta-localization')
})

test('card fields parse; 無 is not an ask; verify command is unwrapped', () => {
  expect(parseCard(card('無'))?.['狀態']).toBe('SAMPLE PASS')
  const row = { name: 'Project Beta', statusPath: 'x' }
  expect(hasAsk(buildProject(row, card('無'), [], NOW))).toBe(false)
  for (const ask of ['無（示範）', '無(之後再說)', '無；示範結果等待整理', '-'])
    expect([ask, hasAsk(buildProject(row, card(ask), [], NOW))]).toEqual([ask, false])
  const p = buildProject(row, card('選擇範例配色'), [], NOW)
  expect(hasAsk(p)).toBe(true)
  expect(p.verify).toBe('php t.php')
  expect(buildProject(row, null, [], NOW).hasCard).toBe(false)
})

test('jobs: running flagged; finished after the CARD flagged; status-card and older ignored', () => {
  const p = buildProject({ name: 'AI', statusPath: 'x' }, card('無', '2030-01-05 09:40'), [
    { id: 'run', jobClass: 'task', status: 'running' },
    { id: 'new', jobClass: 'task', status: 'completed', completedAt: new Date(2030, 0, 5, 10, 30).toISOString() },
    { id: 'old', jobClass: 'task', status: 'completed', completedAt: new Date(2030, 0, 5, 9, 0).toISOString() },
    { id: 'card', jobClass: 'status-card', status: 'completed', completedAt: new Date(2030, 0, 5, 11, 0).toISOString() },
  ], NOW)
  expect(p.jobs.map(j => `${j.kind}:${j.id}`)).toEqual(['running:run', 'newer:new'])
})

test('stale after 3 days', () => {
  const p = buildProject({ name: 'L', statusPath: 'x' }, card('無', '2030-01-01 09:00'), [], NOW)
  expect(p.isStale).toBe(true)
})

test('blocked sessions: blocked = 等批准, waiting = its reason', () => {
  const b = blockedSessions([
    { name: 'old', state: 'blocked', status: 'busy' },
    { name: 'idle', status: 'idle' },
    { name: 'ds', status: 'waiting', waitingFor: 'input needed' },
  ])
  expect(b).toEqual([{ name: 'old', why: '等批准' }, { name: 'ds', why: 'input needed' }])
})

const snap = (ask: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  at: NOW,
  projects: [buildProject({ name: 'K', statusPath: 'x' }, card(ask), [], NOW)],
  blocked: [], codex: 'OK codex=0.0.0-test', contextPercent: 20, error: null, ...extra,
})

test('first snapshot is only the baseline; later changes toast once', () => {
  expect(diffToasts(null, snap('決定 A'))).toEqual([])
  expect(diffToasts(snap('無'), snap('決定 A'))).toEqual(['K 等你：決定 A'])
  expect(diffToasts(snap('決定 A'), snap('決定 A'))).toEqual([])
  const t = diffToasts(snap('無'), snap('無', { contextPercent: 55, codex: 'STALE codex=0.0.0-test brokers=11111(alpha)' }))
  expect(t.length).toBe(2)
})

test('band summarises asks, context and rotation hint', () => {
  const text = bandText(snap('決定 A', { contextPercent: 62 }))
  expect(text.includes('等你 1')).toBe(true)
  expect(text.includes('context 62%（建議換主控台）')).toBe(true)
})

test('codex preflight: only brokers of registered projects count', () => {
  const line = 'STALE codex=0.0.0-test brokers=11111() 22222(sample-docs)  ->  only kill ...'
  expect(relevantCodex(line, ['Project Alpha-App', 'project beta-localization']).startsWith('OK*')).toBe(true)
  const mine = relevantCodex('STALE codex=0.0.0-test brokers=33333(Project Alpha-App) 22222(sample-docs)', ['Project Alpha-App'])
  expect(mine.startsWith('STALE')).toBe(true)
  expect(mine.includes('33333(Project Alpha-App)')).toBe(true)
  expect(mine.includes('22222')).toBe(false)
})

test('focus line leads with the next action', () => {
  expect(focusLine(snap('無')).startsWith('✓ 沒有要你處理的事')).toBe(true)
  expect(focusLine(snap('確認範例配色選項；另外版面差異'))).toBe('▶ 下一步：K：確認範例配色選項')
  const short = shortAsk('Choose a sample layout for Project Alpha with a deliberately long generic description; more sample text')
  expect(short.length).toBe(34)
  expect(short.endsWith('…')).toBe(true)
})

test('sessions: only this console or registered projects, never itself', () => {
  const agents = [
    { name: 'self', sessionId: 'S1', cwd: 'C:/Users/me', state: 'blocked' },
    { name: 'old-console', sessionId: 'S2', cwd: 'C:/Users/me', state: 'blocked' },
    { name: 'side', sessionId: 'S3', cwd: 'D:/side/sample-docs', status: 'waiting', waitingFor: 'input needed' },
    { name: 'project alpha', sessionId: 'S4', cwd: 'C:/Users/me/.codex/worktrees/k/Project Alpha-App/sub', status: 'waiting' },
  ]
  const b = relevantBlocked(agents as any, 'S1', ['C:/Users/me/.codex/worktrees/k/Project Alpha-App'], 'C:/Users/me')
  expect(b.map(x => x.name)).toEqual(['old-console', 'project alpha'])
  // Blocked without a status is not a permission prompt (0.9.4); `waiting` is.
  expect(b.map(x => x.why)).toEqual(['等待輸入', '等待批准'])
  expect(b[0].project).toBe('主控台')
})

test('selection context names the project, its STATUS and what it needs', () => {
  const s = snap('確認範例配色選項')
  expect(selectionContext(s, null)).toBe(null)
  expect(selectionContext(s, 'nope')).toBe(null)
  const ctx = selectionContext(s, 'K') as string
  expect(ctx.includes('選了專案「K」')).toBe(true)
  expect(ctx.includes('需決策：確認範例配色選項')).toBe(true)
})

test('battery shows what is left and turns red near empty', async () => {

  const a = battery(32, 10)
  expect(a.left).toBe(68); expect(a.tone).toBe('green'); expect((a.filled + a.empty).length).toBe(10)
  expect((a.filled + a.empty).includes('68%')).toBe(true)
  expect(battery(85, 10).tone).toBe('red')
  expect(battery(65, 10).tone).toBe('low')
  expect(battery(55, 10, 50, 30).tone).toBe('low')
})

test('reset time: same day shows clock and countdown, later days show the date', () => {
  const now = new Date(2030, 0, 5, 15, 0).getTime()
  expect(resetText(new Date(2030, 0, 5, 17, 13).toISOString(), now)).toBe('重置 17:13・2 小時 13 分後')
  expect(resetText(new Date(2030, 0, 8, 9, 0).toISOString(), now)).toBe('重置 1/8 (二) 09:00・2 天 18 小時後')
  expect(resetText(undefined, now)).toBe('')
  // A narrow pane keeps only the countdown.
  expect(resetText(new Date(2030, 0, 5, 17, 13).toISOString(), now, true)).toBe('2時13分後重置')
  expect(resetText(new Date(2030, 0, 8, 9, 0).toISOString(), now, true)).toBe('2天18時後重置')
  expect(resetText(new Date(2030, 0, 5, 15, 40).toISOString(), now, true)).toBe('40分後重置')
})

test('running job line: elapsed time and the last log line', () => {
  expect(lastLogLine(['start', '[12:00:01] reading files', '----', ''].join('\n'))).toBe('reading files')
  const now = Date.parse('2030-01-05T10:30:00Z')
  expect(runLine({ kind: 'running', id: 'x', status: 'running', summary: '', startedAt: '2030-01-05T10:18:00Z', last: '跑測試' }, now)).toBe('已跑 12m・跑測試')
  expect(runLine({ kind: 'running', id: 'x', status: 'running', summary: '' }, now)).toBe('執行中')
})

test('executor tasks: titles from the prompt, live first, three latest finished', () => {
  expect(taskTitle(['# 任務：記錄示範版面選擇', '內文'].join('\n'), 'x')).toBe('記錄示範版面選擇')
  const job = (id: string, status: string, completedAt?: string) => ({ id, jobClass: 'task', status, completedAt, request: { prompt: '# ' + id, effort: 'high' } })
  const list = jobTasks([job('a', 'completed', '2030-01-05T01:00:00Z'), job('b', 'running'), job('c', 'completed', '2030-01-05T03:00:00Z'),
    job('d', 'completed', '2030-01-05T02:00:00Z'), job('e', 'completed', '2030-01-04T02:00:00Z'), { id: 'f', jobClass: 'status-card', status: 'running' }])
  expect(list.map(t => t.id).join()).toBe('b,c,d,a')
  const now = Date.parse('2030-01-05T04:00:00Z')
  expect(taskMeta(list[1], now).meta).toBe('1h 前完成 · high')
  expect(taskMeta({ ...list[0], startedAt: '2030-01-05T03:48:00Z' }, now).meta).toBe('已跑 12m · high')
})

test('codex quota: weekly window, reset time, credits; a past reset counts as full', () => {
  const now = Date.parse('2030-01-05T06:30:00Z')
  const line = JSON.stringify({ at: '2030-01-05T00:00:00Z', rate_limits: { primary: { used_percent: 3, window_minutes: 10080, resets_at: 2000000000 }, secondary: null, credits: { unlimited: false, balance: '1000' } } })
  const q = parseCodexQuota(line, now)!
  expect(q.limits[0].label).toBe('Codex 週')
  expect(q.limits[0].percent).toBe(3)
  expect(q.credits).toBe('1,000')
  expect(parseCodexQuota(line, 2000000000 * 1000 + 1)!.limits[0].percent).toBe(0)
  expect(parseCodexQuota('', now)).toBe(null)
})
