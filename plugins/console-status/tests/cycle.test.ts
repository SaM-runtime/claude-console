import { expect, test } from 'claude-code/testing'
import { AUTO_SYNC_GRACE_MS } from '../hooks/sync'
import { CYCLE_DEFAULT_HOPS, cardRev, cycleMaxHops, cyclePlan, newCycleRun } from '../hooks/cycle'
import type { CycleRun } from '../hooks/cycle'

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
    ['SYNC with autoSync on waits for autoSync', project({ jobs: [job()] }), 'SYNC', run(), { autoSync: 'on' }, { wait: '等同步' }],
    ['SYNC with autoSync off syncs', project({ jobs: [job()] }), 'SYNC', run(), {}, { action: 'sync' }],
    ['SYNC with autoSync off waits out the grace', project({ jobs: [job({ completedAt: iso(NOW - 10_000) })] }), 'SYNC', run(), {}, { wait: '等同步' }],
    ['a sync that wrote nothing stops', project({ jobs: [job()] }), 'SYNC', run(), { syncStage: 'unchanged' }, { stop: '同步沒有寫回狀態卡' }],
    ['a running job waits', project({ jobs: [{ ...job(), kind: 'running', status: 'running' }] }), 'RUNNING', run(), {}, { wait: '等執行者' }],
    ['a failed job stops', project({ jobs: [job({ status: 'failed' })] }), 'SYNC', run(), {}, { stop: '工作失敗' }],
    ['a cancelled job stops', project({ jobs: [job({ status: 'cancelled' })] }), 'SYNC', run(), {}, { stop: '工作失敗' }],
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
