import { expect, test } from 'claude-code/testing'
import { awayCounts, awayFor, awayHighlights, awayText, awayView, cameBack } from '../hooks/away'
import { awayMinutesOption } from '../hooks/config'
import { layoutBand } from '../hooks/band'
import type { FeedEvent } from '../types'

const NOW = Date.parse('2030-01-10T12:00:00Z')
const MIN = 60_000
const AWAY = 30 * MIN
const line = (minutesAgo: number, text: string, tone: FeedEvent['tone'], kind?: FeedEvent['kind']): FeedEvent =>
  ({ at: NOW - minutesAgo * MIN, text, tone, ...(kind ? { kind } : {}) })

test('a digest grows while nobody uses the console, freezes on the return and stays until dismissed or old', () => {
  const start = { activeAt: NOW - 120 * MIN, log: [] as FeedEvent[], digest: null }
  // Away long enough but nothing happened: nothing to show.
  expect(awayView(start, NOW, AWAY)).toBeNull()
  const log = [line(10, 'api　Claude 完成，待同步', 'blue', 'done'), line(50, 'web　新的決策項目', 'amber', 'decision')]
  const away = { ...start, log }
  // Still away: the digest so far, up to now.
  expect(awayView(away, NOW, AWAY)).toEqual({ from: NOW - 120 * MIN, to: NOW, events: log })
  // Not long enough: nothing yet.
  expect(awayView({ ...away, activeAt: NOW - 20 * MIN }, NOW, AWAY)).toBeNull()
  // Back: frozen, the log starts over.
  const back = cameBack(away, NOW, AWAY)
  expect(back).toEqual({ activeAt: NOW, log: [], digest: { from: NOW - 120 * MIN, to: NOW, events: log } })
  expect(awayView(back, NOW + 5 * MIN, AWAY)).toEqual(back.digest)
  // As old as an absence, it goes by itself.
  expect(awayView(back, NOW + 30 * MIN, AWAY)).toBeNull()
  // A quick look in between keeps the frozen one; a short absence makes no new digest.
  const look = cameBack({ ...back, log: [line(-3, 'api　STATUS 已更新', 'green', 'status')] }, NOW + 5 * MIN, AWAY)
  expect(look.digest).toBe(back.digest)
  expect(look.log).toEqual([])
  // What answered the person's own press, seconds after it, is not news on their return.
  const own = { activeAt: NOW - 60 * MIN, log: [{ at: NOW - 60 * MIN + 2_000, text: 'api：已封存', tone: 'green' as const }], digest: null }
  expect(awayView(own, NOW, AWAY)).toBeNull()
  expect(cameBack(own, NOW, AWAY).digest).toBeNull()
  // off: never.
  expect(awayView(away, NOW, null)).toBeNull()
  expect(cameBack(away, NOW, null).digest).toBeNull()
})

test('the digest counts what matters and lists failures and what waits on you first', () => {
  const events = [
    line(5, 'api　STATUS 已更新', 'green', 'status'),
    line(8, 'api　Claude 完成，待同步', 'blue', 'done'),
    line(20, 'web　Codex 失敗，請檢查', 'red', 'failed'),
    line(25, 'docs　新的審核關卡', 'amber', 'gate'),
    line(30, 'cli　PR #7 CI 失敗：test', 'red', 'ci-fail'),
    line(40, 'api　Claude 完成，待同步', 'blue', 'done'),
    line(45, '⟳ api 接力完成：沒有下一步（第 3 跳）', 'green', 'cycle-stop'),
    line(50, 'api　執行者開始執行', 'teal'),
  ]
  expect(awayCounts(events)).toBe('完成 2 個工作・1 個失敗或出錯・1 件新的等你處理・CI 失敗 1 次・自動接力停下 1 次・狀態卡更新 1 次')
  expect(awayCounts([line(1, 'api　執行者開始執行', 'teal')])).toBe('1 則動態')
  expect(awayHighlights(events).map(event => event.text)).toEqual(['web　Codex 失敗，請檢查', 'cli　PR #7 CI 失敗：test', 'docs　新的審核關卡', 'api　STATUS 已更新'])
  // The same line twice is listed once.
  expect(awayHighlights(events, 10).filter(event => event.text === 'api　Claude 完成，待同步')).toHaveLength(1)
  expect(awayText({ from: NOW - 135 * MIN, to: NOW, events }, at => `${Math.round((NOW - at) / MIN)} 分鐘前`)).toEqual([
    '你離開的 2 小時 15 分裡：完成 2 個工作・1 個失敗或出錯・1 件新的等你處理・CI 失敗 1 次・自動接力停下 1 次・狀態卡更新 1 次',
    '・web：Codex 失敗，請檢查（20 分鐘前）',
    '・cli：PR #7 CI 失敗：test（30 分鐘前）',
    '・docs：新的審核關卡（25 分鐘前）',
    '・api：STATUS 已更新（5 分鐘前）',
    '・…另 4 則',
  ])
  expect(awayFor(40 * MIN)).toBe('40 分鐘')
  expect(awayFor(120 * MIN)).toBe('2 小時')
  expect(awayFor((3 * 24 + 2) * 60 * MIN)).toBe('3 天 2 小時')
  expect(awayFor(48 * 60 * MIN)).toBe('2 天')
})

test('awayMinutes: 30 by default, 5 to 1440, off for never; the band counts the digest', () => {
  expect(awayMinutesOption(undefined)).toBe(30)
  expect(awayMinutesOption('')).toBe(30)
  expect(awayMinutesOption('90')).toBe(90)
  expect(awayMinutesOption('1')).toBe(5)
  expect(awayMinutesOption('99999')).toBe(1440)
  expect(awayMinutesOption('later')).toBe(30)
  expect(awayMinutesOption('OFF')).toBeNull()

  const s = { at: NOW, projects: [], blocked: [], codex: '', contextPercent: null, error: null }
  const wide = layoutBand(s, { columns: 100, demo: false, paneOpen: false, away: 9 })
  expect(wide.items[0]).toEqual({ id: 'away', text: '◷ 離開期間 9 則', width: 15 })
  expect(layoutBand(s, { columns: 30, demo: false, paneOpen: false, away: 9 }).items[0]!.text).toBe('◷9')
  expect(layoutBand(s, { columns: 100, demo: false, paneOpen: false }).items.some(item => item.id === 'away')).toBe(false)
})
