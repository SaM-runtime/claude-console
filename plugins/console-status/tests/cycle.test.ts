import { expect, test } from 'claude-code/testing'
import { AUTO_SYNC_GRACE_MS } from '../hooks/sync'
import { CYCLE_DEFAULT_HOPS, CYCLE_DEFAULT_QUOTA_STOP, QUOTA_STALE_MS, cardRev, cycleMaxHops, cyclePlan, cycleQuotaStop, newCycleRun, quotaBrake } from '../hooks/cycle'
import type { CycleRun } from '../hooks/cycle'
import { claudeLimits } from '../hooks/logic'

const NOW = Date.parse('2030-01-05T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const project = (over: Record<string, unknown> = {}) => ({
  name: 'Alpha', statusPath: 'D:/Alpha/.console/STATUS.md', hasCard: true, state: 'ok', ask: '無', next: '.task/x.md',
  gate: '無', verify: '', updated: '2030-01-05 11:00 · rev 7 · job c-1', isStale: false, jobs: [], executor: 'claude', ...over,
}) as any
const job = (over: Record<string, unknown> = {}) => ({ kind: 'newer', id: 'j1', status: 'completed', summary: '', executor: 'claude', completedAt: iso(NOW - 5 * 60_000), ...over })
const run = (over: Partial<CycleRun> = {}): CycleRun => ({ ...newCycleRun(NOW - 30 * 60_000, 6), ...over })
const opts = (over: Record<string, unknown> = {}) => ({ autoSync: 'off' as const, ...over })

test('(a) cyclePlan: every way a project can be, and what one hop does with it', () => {
  const cases: [string, any, string, CycleRun, Record<string, unknown>, unknown][] = [
    ['IDLE with a next step continues', project(), 'IDLE', run(), {}, { action: 'continue' }],
    ['spec gate is sent to the console', project({ gate: 'spec：approve acceptance' }), 'GATE', run(), {}, { action: 'gate' }],
    ['review gate is sent to the console', project({ gate: 'review：0.21.0 PASS' }), 'GATE', run(), {}, { action: 'gate' }],
    ['release gate stops', project({ gate: 'release：push to fork' }), 'GATE', run(), {}, { stop: '到 release 關卡，等你核准' }],
    ['a decision stops', project({ ask: '選 A 或 B' }), 'ACTION', run(), {}, { stop: '等你決定／回覆' }],
    ['an executor asking stops, no sync', project({ jobs: [job({ asks: true })] }), 'ACTION', run(), {}, { stop: '執行者在等你回覆' }],
    ['an executor an API error stopped says why', project({ jobs: [job({ asks: true, error: '額度用完' })] }), 'ACTION', run(), {}, { stop: '執行者出錯：額度用完' }],
    ['SYNC with autoSync on waits for autoSync', project({ jobs: [job()] }), 'SYNC', run(), { autoSync: 'on' }, { wait: '等同步' }],
    ['SYNC with autoSync off syncs', project({ jobs: [job()] }), 'SYNC', run(), {}, { action: 'sync' }],
    ['SYNC with autoSync off waits out the grace', project({ jobs: [job({ completedAt: iso(NOW - 10_000) })] }), 'SYNC', run(), {}, { wait: '等同步' }],
    ['a sync that wrote nothing stops', project({ jobs: [job()] }), 'SYNC', run(), { syncStage: 'unchanged' }, { stop: '同步沒有寫回狀態卡' }],
    ['a running job waits', project({ jobs: [{ ...job(), kind: 'running', status: 'running' }] }), 'RUNNING', run(), {}, { wait: '等執行者' }],
    ['a failed job stops', project({ jobs: [job({ status: 'failed' })] }), 'SYNC', run(), {}, { stop: '工作失敗' }],
    ['a cancelled job stops', project({ jobs: [job({ status: 'cancelled' })] }), 'SYNC', run(), {}, { stop: '工作已停止' }],
    ['no card stops', project({ hasCard: false }), 'NOCARD', run(), {}, { stop: '找不到狀態卡' }],
    ['manual stops', project({ executor: 'manual' }), 'IDLE', run(), {}, { stop: '手動交接的專案不接力' }],
    ['demo stops', project(), 'IDLE', run(), { demo: true }, { stop: '示範資料不接力' }],
    ['nothing left to do ends well', project({ next: '無' }), 'IDLE', run(), {}, { stop: '沒有下一步了', done: true }],
    ['the hop limit stops', project(), 'IDLE', run({ hops: 6, lastAt: NOW - 5 * 60_000 }), {}, { stop: '已達上限 6 跳' }],
    ['a hop sent under a minute ago waits', project(), 'IDLE', run({ hops: 1, lastAt: NOW - (AUTO_SYNC_GRACE_MS - 1), lastNext: 'other', lastRev: 6, lastKind: 'continue' }), {}, { wait: '稍候' }],
    ['a continue that left the CARD as it was stops', project(), 'IDLE', run({ hops: 1, lastAt: NOW - 5 * 60_000, lastNext: '.task/x.md', lastRev: 7, lastKind: 'continue' }), {}, { stop: '上一跳沒有改到狀態卡' }],
    ['a gate still out waits for its turn', project({ gate: 'review：x' }), 'GATE', run({ hops: 1, lastKind: 'gate', lastGate: 'review：x', lastAt: NOW - 5 * 60_000 }), { gatePending: true }, { wait: '等回合' }],
    ['a gate the console did not pass stops, not sent twice', project({ gate: 'review：x' }), 'GATE', run({ hops: 1, lastKind: 'gate', lastGate: 'review：x', lastAt: NOW - 5 * 60_000 }), {}, { stop: '主控台未放行關卡' }],
    ['a gate the console replaced is a new gate', project({ gate: 'review：y' }), 'GATE', run({ hops: 1, lastKind: 'gate', lastGate: 'review：x', lastAt: NOW - 5 * 60_000 }), {}, { action: 'gate' }],
  ]
  expect(cases.length).toBeGreaterThanOrEqual(14)
  for (const [name, p, state, r, o, expected] of cases) {
    expect([name, cyclePlan(p, state as any, r, NOW, opts(o))]).toEqual([name, expected])
  }
})

test('(a2) with a 驗證 in the CARD, work this cycle sent is verified before the next step goes out', () => {
  const after = run({ hops: 1, lastAt: NOW - 5 * 60_000, lastNext: '.task/before.md', lastRev: 6, lastKind: 'continue' })
  const verified = (ok: boolean, at = NOW - 60_000, exitCode: number | null = ok ? 0 : 1) => ({ command: 'npm test', at, ok, exitCode, lines: [], truncated: false })
  const p = project({ verify: 'npm test' })
  const cases: [string, any, CycleRun, Record<string, unknown>, unknown][] = [
    ['the first hop goes without a check', p, run(), { verification: { trusted: true } }, { action: 'continue' }],
    ['after a hop, a trusted 驗證 runs first', p, after, { verification: { trusted: true } }, { action: 'verify' }],
    ['a pass from before the last hop does not count', p, after, { verification: { trusted: true, result: verified(true, NOW - 10 * 60_000) } }, { action: 'verify' }],
    ['a pass since the last hop lets the step go', p, after, { verification: { trusted: true, result: verified(true) } }, { action: 'continue' }],
    ['a failure since the last hop stops', p, after, { verification: { trusted: true, result: verified(false) } }, { stop: '驗證沒過（結束碼 1）' }],
    ['a check that could not run stops', p, after, { verification: { trusted: true, result: verified(false, NOW - 60_000, null) } }, { stop: '驗證沒過（逾時或無法執行）' }],
    ['a command nobody confirmed is not run on its own', p, after, { verification: { trusted: false } }, { stop: '驗證指令還沒確認過：先按一次 ▶ 執行驗證，之後每跳之間會自己驗證' }],
    ['a result of another command does not count', p, after, { verification: { trusted: true, result: { ...verified(true), command: 'old' } } }, { action: 'verify' }],
    ['no 驗證, no check, as before', project(), after, {}, { action: 'continue' }],
    ['a gate is not held for it', project({ verify: 'npm test', gate: 'review：x' }), after, { verification: { trusted: true } }, { action: 'gate' }],
  ]
  for (const [name, proj, r, o, expected] of cases) {
    const state = proj.gate !== '無' ? 'GATE' : 'IDLE'
    expect([name, cyclePlan(proj, state as any, r, NOW, opts(o))]).toEqual([name, expected])
  }
})

test('(a3) Claude windows the console read too long ago stop a cycle instead of braking on old numbers', () => {
  const limits = [{ kind: 'five_hour', percent: 20, resetsAt: iso(NOW + 3_600_000) }]
  expect(quotaBrake(limits, 70, NOW, NOW - 10 * 60_000)).toBeNull()
  expect(quotaBrake(limits, 70, NOW, NOW - QUOTA_STALE_MS - 60_000)).toBe('額度數字已 46 分沒更新，無法確認還剩多少：在主控台送一則訊息就會更新，再按 ⟳')
  // Unknown read time, no windows at all, or the brake off: as before.
  expect(quotaBrake(limits, 70, NOW)).toBeNull()
  expect(quotaBrake([], 70, NOW, NOW - 3 * 3_600_000)).toBeNull()
  expect(quotaBrake(limits, null, NOW, NOW - 3 * 3_600_000)).toBeNull()
  expect(cyclePlan(project(), 'IDLE', run(), NOW, opts({ limits, limitsAt: NOW - QUOTA_STALE_MS - 60_000 }))).toEqual({ stop: '額度數字已 46 分沒更新，無法確認還剩多少：在主控台送一則訊息就會更新，再按 ⟳' })
})

test('(b) cycleMaxHops: blank and junk fall back to 6; out of range is clamped to 1–20', () => {
  expect(CYCLE_DEFAULT_HOPS).toBe(6)
  expect(cycleMaxHops('')).toBe(6)
  expect(cycleMaxHops(undefined)).toBe(6)
  expect(cycleMaxHops('abc')).toBe(6)
  expect(cycleMaxHops(0)).toBe(1)
  expect(cycleMaxHops('0')).toBe(1)
  expect(cycleMaxHops(25)).toBe(20)
  expect(cycleMaxHops('4')).toBe(4)
  expect(cycleMaxHops(' 3 ')).toBe(3)
})

test('(c) a repeated hop is judged by the CARD rev and the next step only, not by time', () => {
  expect(cardRev('2030-01-05 11:00 · rev 7 · job c-1')).toBe(7)
  expect(cardRev('2030-01-05 11:00')).toBe(null)
  const same = run({ hops: 1, lastNext: '.task/x.md', lastRev: 7, lastKind: 'continue' })
  // Long after the last hop, an unchanged CARD is still the same hop.
  expect(cyclePlan(project(), 'IDLE', { ...same, lastAt: NOW - 5 * 3_600_000 }, NOW, opts())).toEqual({ stop: '上一跳沒有改到狀態卡' })
  // The rev moved: the executor wrote the CARD, even with the same next step.
  expect(cyclePlan(project({ updated: '2030-01-05 11:30 · rev 8 · job c-2' }), 'IDLE', { ...same, lastAt: NOW - 5 * 60_000 }, NOW, opts())).toEqual({ action: 'continue' })
  // The next step changed: a new hop, whatever the rev.
  expect(cyclePlan(project({ next: '.task/y.md' }), 'IDLE', { ...same, lastAt: NOW - 5 * 60_000 }, NOW, opts())).toEqual({ action: 'continue' })
  // A CARD without a rev cannot be judged the same.
  expect(cyclePlan(project({ updated: '2030-01-05 11:00' }), 'IDLE', { ...same, lastRev: null, lastAt: NOW - 5 * 60_000 }, NOW, opts())).toEqual({ action: 'continue' })
})

test('review P2-1: an executor waiting on its question stops the cycle in any state, a gate row too', () => {
  // rows() ranks a gate above a newer job that asks, so the row is GATE while the executor waits for you.
  const asking = project({ gate: 'review：x', jobs: [job({ asks: true })] })
  expect(cyclePlan(asking, 'GATE', run(), NOW, opts())).toEqual({ stop: '執行者在等你回覆' })
  expect(cyclePlan(project({ gate: 'release：ship', jobs: [job({ asks: true })] }), 'GATE', run(), NOW, opts())).toEqual({ stop: '執行者在等你回覆' })
  expect(cyclePlan(project({ jobs: [job({ asks: true })] }), 'ACTION', run(), NOW, opts())).toEqual({ stop: '執行者在等你回覆' })
  // Without a question, the gate goes to the console as before.
  expect(cyclePlan(project({ gate: 'review：x' }), 'GATE', run(), NOW, opts())).toEqual({ action: 'gate' })
})

test('quota brake: a 5-hour window at the threshold, or a window running out within the hour, stops the next hop', () => {
  expect(CYCLE_DEFAULT_QUOTA_STOP).toBe(70)
  expect(cycleQuotaStop(undefined)).toBe(70)
  expect(cycleQuotaStop('')).toBe(70)
  expect(cycleQuotaStop('abc')).toBe(70)
  expect(cycleQuotaStop('85%')).toBe(85)
  expect(cycleQuotaStop(0)).toBe(1)
  expect(cycleQuotaStop(150)).toBe(100)
  expect(cycleQuotaStop(' OFF ')).toBe(null)
  const fiveHour = (percent: number) => ({ kind: 'five_hour', percent, resetsAt: iso(NOW + 2 * 3_600_000) })
  // Under the threshold, and a weekly window high but not running out within the hour: no brake.
  expect(quotaBrake([fiveHour(40), { kind: 'seven_day', percent: 80, resetsAt: iso(NOW + 2 * 86_400_000) }], 70, NOW)).toBe(null)
  expect(quotaBrake([fiveHour(72)], 70, NOW)).toBe('額度煞車：5 小時額度已用 72%（門檻 70%）')
  expect(quotaBrake([fiveHour(72)], null, NOW)).toBe(null)
  expect(quotaBrake(undefined, 70, NOW)).toBe(null)
  // A weekly window at 99.5% five days in runs out in well under an hour.
  expect(quotaBrake([{ kind: 'seven_day', percent: 99.5, resetsAt: iso(NOW + 2 * 86_400_000) }], 70, NOW)).toMatch(/^額度煞車：本週額度照目前速度約 \d+ 分後用完$/)
  // In the plan: the brake stops a hop that would otherwise go out, and the default applies when unset.
  expect(cyclePlan(project(), 'IDLE', run(), NOW, opts({ limits: [fiveHour(70)] }))).toEqual({ stop: '額度煞車：5 小時額度已用 70%（門檻 70%）' })
  expect(cyclePlan(project(), 'IDLE', run(), NOW, opts({ limits: [fiveHour(70)], quotaStop: 90 }))).toEqual({ action: 'continue' })
  expect(cyclePlan(project(), 'IDLE', run(), NOW, opts({ limits: [fiveHour(95)], quotaStop: null }))).toEqual({ action: 'continue' })
  // A cycle that is only waiting is not stopped by quota: nothing would be spent.
  expect(cyclePlan(project({ jobs: [{ ...job(), kind: 'running', status: 'running' }] }), 'RUNNING', run(), NOW, opts({ limits: [fiveHour(95)] }))).toEqual({ wait: '等執行者' })
})

test('a 5-hour window past its reset is read as unused, so an old percent neither shows nor brakes', () => {
  const now = Date.parse('2030-01-05T12:00:00Z')
  const raw = [
    { kind: 'five_hour', percentUsed: 92, resetsAt: '2030-01-05T11:00:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2030-01-09T00:00:00Z' },
  ]
  expect(claudeLimits(raw, now)).toEqual([
    { kind: 'five_hour', percent: 0 },
    { kind: 'seven_day', percent: 40, resetsAt: '2030-01-09T00:00:00Z' },
  ])
  expect(quotaBrake(claudeLimits(raw, now), 70, now)).toBeNull()
  expect(quotaBrake(claudeLimits([{ ...raw[0], resetsAt: '2030-01-05T14:00:00Z' }], now), 70, now)).toMatch(/額度煞車/)
  expect(claudeLimits(null, now)).toEqual([])
})
