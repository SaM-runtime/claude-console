import { expect, test } from 'claude-code/testing'

import type { JobFlag } from '../types'
import {
  ago,
  blockedSessions,
  codexHealth,
  demoEvents,
  demoSnapshot,
  displayWidth,
  projectColumnWidth,
  rows,
  runLine,
} from '../hooks/logic'

const NOW = new Date(2030, 0, 5, 12, 0).getTime()

test('A1: age is bounded to four columns and future timestamps are not ages', () => {
  const cases: Array<[number, string]> = [
    [NOW, 'now'],
    [NOW - 12 * 60_000, '12m'],
    [NOW - 3 * 3_600_000, '3h'],
    [NOW - 4 * 86_400_000, '4d'],
    [NOW - 100 * 86_400_000, '>99d'],
    [NOW + 60_000, '—'],
  ]
  for (const [time, expected] of cases) {
    expect(ago(time, NOW)).toBe(expected)
    expect(displayWidth(ago(time, NOW)) <= 4).toBe(true)
  }
})

test('A1/A6: demo dates are relative to now and demo preflight is healthy', () => {
  const demo = demoSnapshot(NOW)
  expect(rows(demo).map(row => row.age).sort()).toEqual(['12m', '1d', '2d', '3h', '4d'])
  expect(codexHealth(demo.codex)).toBe('ok')

  const betweenMinutes = demoSnapshot(NOW + 37_000)
  expect(rows(betweenMinutes).map(row => row.age).sort()).toEqual(['12m', '1d', '2d', '3h', '4d'])
})

test('demo covers all useful states, quotas, tasks and two relative feed events', () => {
  const demo = demoSnapshot(NOW) as ReturnType<typeof demoSnapshot>
  expect(demo.demo).toBe(true)
  expect(rows(demo).map(row => row.state).sort()).toEqual(['ACTION', 'GATE', 'IDLE', 'RUNNING', 'SYNC'])
  expect(demo.limits?.map(limit => [limit.kind, limit.percent])).toEqual([
    ['five_hour', 31],
    ['seven_day', 75],
  ])
  expect(Date.parse(demo.limits?.[0].resetsAt ?? '') - NOW).toBe(4 * 3_600_000)
  expect(Date.parse(demo.limits?.[1].resetsAt ?? '') - NOW).toBe(2 * 86_400_000)
  expect(demo.codexQuota?.limits.map(limit => [limit.label, limit.percent])).toEqual([['Codex 週', 12]])
  expect(demo.codexQuota?.credits).toBe('1,000')
  expect((demo.codexQuota?.limits[0].resetsAt ?? '').startsWith('2030-')).toBe(true)

  const sampleDocs = demo.projects.find(project => project.name === 'Sample-Docs')
  expect(sampleDocs?.jobs.some(job => job.kind === 'running' && job.executor === 'codex')).toBe(true)
  expect(sampleDocs?.tasks?.map(task => task.status).sort()).toEqual(['completed', 'running'])
  expect(sampleDocs?.tasks?.every(task => task.model.includes('demo'))).toBe(true)

  const feed = demoEvents(NOW)
  expect(feed.length).toBe(2)
  expect(feed.every(event => event.at <= NOW && event.text.includes('示範'))).toBe(true)
})

test('SYNC row wording says the result is not synchronized', () => {
  const sync = rows(demoSnapshot(NOW)).find(row => row.state === 'SYNC')
  expect(sync?.item).toBe('結果未同步至 STATUS')
})

test('A2: project width uses display columns and clamps from 8 through 18', () => {
  expect(displayWidth('Project-A')).toBe(9)
  expect(displayWidth('專案一')).toBe(6)
  expect(projectColumnWidth(['サンプル案件'])).toBe(12)
  expect(projectColumnWidth(['A', '專案一'])).toBe(8)
  expect(projectColumnWidth(['Project-Alpha'])).toBe(13)
  expect(projectColumnWidth(['12345678901234567890'])).toBe(18)
})

test('A2: project rows preserve names containing spaces', () => {
  const demo = demoSnapshot(NOW)
  demo.projects[0].name = 'Project Alpha Long'
  expect(rows(demo).some(row => row.project === 'Project Alpha Long')).toBe(true)
})

test('A5: unnamed sessions get a useful label and fully empty entries are removed', () => {
  expect(blockedSessions([
    { name: '  ', sessionId: 's-1', state: 'blocked' },
    { status: 'waiting', waitingFor: '  ' },
    { name: 'named', status: 'waiting' },
  ])).toEqual([
    { name: '(未命名 session)', why: '等批准' },
    { name: 'named', why: '等輸入' },
  ])
})

test('A7: running text names its executor or gives a neutral fallback', () => {
  const job = (extra: Partial<JobFlag>): JobFlag => ({ kind: 'running', id: 'x', status: 'running', summary: '', ...extra })
  expect(runLine(job({ executor: 'codex' }), NOW)).toBe('codex 執行中')
  expect(runLine(job({}), NOW)).toBe('執行中')
  expect(runLine(job({ executor: 'claude', startedAt: new Date(NOW - 12 * 60_000).toISOString(), last: '跑測試' }), NOW))
    .toBe('claude · 已跑 12m・跑測試')
})
