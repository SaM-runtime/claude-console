// ⟳ 自動接力: one press runs a project's cycle (continue → sync → review → gate → …) by pressing the existing
// buttons in turn, and stops wherever a person is needed. Pure planning, no I/O; register.tsx runs the loop.
import type { CycleRun, Project } from '../types'
import type { State } from './logic'
import { hasAsk, parseGate, saysNone } from './logic'
import { actionKinds, dispatchBlockReason, isManual } from './actions'
import { AUTO_SYNC_GRACE_MS, autoSyncPlan } from './sync'

/** A press of ⟳ dispatches at most this many hops unless `cycleMaxHops` says otherwise. */
export const CYCLE_DEFAULT_HOPS = 6
const CYCLE_MIN_HOPS = 1
const CYCLE_MAX_HOPS = 20
/** A cycle with no hop for this long is let go of: whatever it waited for is not coming. */
export const CYCLE_MAX_AGE_MS = 6 * 3_600_000

/** `cycleMaxHops` option: hops per press of ⟳, 1–20; blank or not a number is the default. */
export function cycleMaxHops(value: unknown): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN
  if (!Number.isFinite(raw)) return CYCLE_DEFAULT_HOPS
  return Math.max(CYCLE_MIN_HOPS, Math.min(CYCLE_MAX_HOPS, Math.round(raw)))
}

export type { CycleRun }

/** The cycles kept in `$.store`, each checked: anything else (an older shape, a half-written value) is dropped. */
export function storedCycles(value: unknown): Record<string, CycleRun> {
  const out: Record<string, CycleRun> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [path, raw] of Object.entries(value as Record<string, unknown>)) {
    const r = raw as Record<string, unknown> | null
    if (!r || typeof r !== 'object') continue
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
    if (!num(r.startedAt) || !num(r.hops) || !num(r.max) || !num(r.lastAt) || typeof r.lastNext !== 'string') continue
    const kind = r.lastKind === 'continue' || r.lastKind === 'gate' || r.lastKind === 'sync' ? r.lastKind : ''
    out[path] = {
      startedAt: r.startedAt as number, hops: r.hops as number, max: r.max as number, lastAt: r.lastAt as number,
      lastRev: num(r.lastRev) ? r.lastRev as number : null, lastNext: r.lastNext, lastKind: kind,
      ...(typeof r.lastGate === 'string' ? { lastGate: r.lastGate } : {}),
      ...(typeof r.waiting === 'string' ? { waiting: r.waiting } : {}),
      ...(typeof r.owner === 'string' ? { owner: r.owner } : {}),
    }
  }
  return out
}

export type CyclePlan = { action: 'continue' | 'gate' | 'sync' } | { wait: string } | { stop: string; done?: boolean }

export type CycleOptions = {
  autoSync: 'on' | 'off'
  demo?: boolean
  /** A gate this cycle sent is still out (its review turn has not ended). */
  gatePending?: boolean
  /** How the project's latest sync ended, when one did. */
  syncStage?: string
}

export const newCycleRun = (now: number, max: number, owner?: string): CycleRun => ({ startedAt: now, hops: 0, max, lastRev: null, lastNext: '', lastKind: '', lastAt: 0, ...(owner !== undefined ? { owner } : {}) })

/** A cycle another console armed: shown here, never run, stopped or rewritten here. */
export const FOREIGN_CYCLE = '另一主控台接力中'

/** The rev in a CARD's 更新 line (`… · rev 7 · …`), or null when it has none. */
export function cardRev(updated: string): number | null {
  const m = /\brev\s*(\d+)/i.exec(updated)
  return m ? Number(m[1]) : null
}

const SYNC_FAILED = new Set(['unchanged', 'dispatch-failed', 'run-failed'])

/**
 * The next hop of a cycle, a reason to wait for the next refresh, or a reason to stop. Every hop is an
 * existing action; a gate is reviewed by the console, and release, a decision, an executor's question, a
 * failure, an unchanged CARD and the hop limit all stop and hand the project back to a person.
 */
export function cyclePlan(project: Project, state: State, run: CycleRun, now: number, options: CycleOptions): CyclePlan {
  if (options.demo) return { stop: '示範資料不接力' }
  if (state === 'NOCARD' || !project.hasCard) return { stop: '找不到狀態卡' }
  if (isManual(project)) return { stop: '手動交接的專案不接力' }
  // An executor that ended its turn on a question waits for you, whatever the row shows: rows() ranks a gate
  // above it, so a GATE row can hide one, and a gate hop then would answer past the question.
  if (project.jobs.some(job => job.kind === 'newer' && job.asks)) return { stop: '執行者在等你回覆' }
  // A gate hop waits for its review turn, and a gate the console left in place is not sent a second time.
  if (options.gatePending) return { wait: '等回合' }
  const gate = parseGate(project.gate)
  if (run.lastKind === 'gate' && run.lastGate !== undefined && gate && (project.gate ?? '').trim() === run.lastGate) return { stop: '主控台未放行關卡' }
  if (state === 'ACTION' || hasAsk(project)) return { stop: '等你決定／回覆' }
  if (gate?.kind === 'release') return { stop: '到 release 關卡，等你核准' }
  if (gate && gate.kind === 'unknown') return { stop: '關卡無法辨識' }
  if (project.jobs.some(job => job.kind === 'newer' && (job.status === 'failed' || job.status === 'cancelled'))) return { stop: '工作失敗' }
  if (state === 'RUNNING' || dispatchBlockReason(project)) return { wait: '等執行者' }
  let action: 'continue' | 'gate' | 'sync' | null = null
  if (state === 'SYNC') {
    if (options.syncStage && SYNC_FAILED.has(options.syncStage)) return { stop: '同步沒有寫回狀態卡' }
    const plan = autoSyncPlan(project, now)
    // Finished work no sync will take (only a sync's own result is left): a person looks.
    if (!plan.ready.length && !plan.waiting) return { stop: '結果未同步，需要人看' }
    if (options.autoSync === 'on' || plan.waiting) return { wait: '等同步' }
    action = 'sync'
  } else if (state === 'GATE' && gate) {
    action = 'gate'
  } else if (state === 'IDLE') {
    if (!actionKinds(project, state).includes('continue')) {
      return saysNone(project.next.trim()) || !project.next.trim() ? { stop: '沒有下一步了', done: true } : { stop: '沒有可做的動作' }
    }
    const rev = cardRev(project.updated)
    if (run.lastKind === 'continue' && rev !== null && rev === run.lastRev && project.next.trim() === run.lastNext) return { stop: '上一跳沒有改到狀態卡' }
    action = 'continue'
  }
  if (!action) return { stop: '沒有可做的動作' }
  // Like auto-sync, a hop sent a moment ago leaves room for the person's own continue or reply.
  if (run.lastAt && now - run.lastAt < AUTO_SYNC_GRACE_MS) return { wait: '稍候' }
  if (run.hops >= run.max) return { stop: `已達上限 ${run.max} 跳` }
  return { action }
}

/** The chip on the row and the next-step card: hops sent of the limit, or what the cycle waits for. */
export function cycleChip(run: CycleRun, foreign = false): string {
  if (foreign) return `⟳ ${FOREIGN_CYCLE}`
  return run.waiting && run.waiting !== '稍候' ? `⟳ ${run.waiting}` : `⟳ ${run.hops}/${run.max}`
}

/** Why a hop was taken, for its feed line: the next step it continues, the gate it sends, or the sync. */
export function hopDetail(kind: 'continue' | 'gate' | 'sync', project: Project): string {
  if (kind === 'continue') return project.next.trim()
  if (kind === 'gate') return `${parseGate(project.gate)?.kind ?? ''} 關卡`
  return '結果寫回狀態卡'
}
