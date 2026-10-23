// ⟳ 自動接力: one press runs a project's cycle (continue → sync → review → gate → …) by pressing the existing
// buttons in turn, and stops wherever a person is needed. Pure planning, no I/O; register.tsx runs the loop.
import type { CycleRun, PendingAction, Project, VerificationResult } from '../types'
import type { State } from './logic'
import { hasAsk, limitName, parseGate, parseLimitKind, saysNone } from './logic'
import { actionKinds, dispatchBlockReason, isManual } from './actions'
import { AUTO_SYNC_GRACE_MS, autoSyncPlan } from './sync'
import { limitPace } from './pace'

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

/** Most projects `cycleMaxRunning` lets run at once. */
const CYCLE_MAX_RUNNING = 10

/** `cycleMaxRunning` option: how many projects may run at once while ⟳ relays are armed, 1–10; blank or not a number is no limit. */
export function cycleMaxRunning(value: unknown): number | null {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN
  if (!Number.isFinite(raw)) return null
  return Math.max(1, Math.min(CYCLE_MAX_RUNNING, Math.round(raw)))
}

/** The projects running work now: a job of theirs is running, or a continue, sync or reply was just sent. */
export function runningPaths(projects: Project[], pending: Record<string, PendingAction>): Set<string> {
  const out = new Set(projects.filter(p => p.jobs.some(job => job.kind === 'running')).map(p => p.statusPath))
  for (const [path, action] of Object.entries(pending)) {
    if (action.kind === 'continue' || action.kind === 'sync' || action.kind === 'reply') out.add(path)
  }
  return out
}

/** Where a waiting ⟳ relay stands: its place in line, the relays holding the places, and the other work running. */
export type CycleQueueSpot = { place: number; relays: string[]; others: number }

/**
 * Which armed relays wait under `limit` (null: none do). Work already running holds its place first, a
 * person's own presses too, since every job spends the same quota; a relay whose project is running holds
 * the place of that work. The places left go to the other relays in the order they were armed, and a relay
 * keeps its place between its hops until it ends. Relays of every console count: they share `$.store`.
 */
export function cycleQueue(runs: Record<string, CycleRun>, running: ReadonlySet<string>, limit: number | null): Record<string, CycleQueueSpot> {
  if (limit === null) return {}
  const order = Object.keys(runs).sort((a, b) => runs[a]!.startedAt - runs[b]!.startedAt || a.localeCompare(b))
  const relays = order.filter(path => running.has(path))
  const taken = new Set(running)
  const waiting: string[] = []
  for (const path of order) {
    if (running.has(path)) continue
    if (taken.size < limit) { taken.add(path); relays.push(path) } else waiting.push(path)
  }
  const held = order.filter(path => relays.includes(path))
  const others = [...running].filter(path => !runs[path]).length
  return Object.fromEntries(waiting.map((path, i) => [path, { place: i + 1, relays: held, others }]))
}

/** Why a relay waits, in words: the relays ahead of it (by the names given) and the other work running. */
export function queueReason(spot: CycleQueueSpot, name: (path: string) => string): string {
  const relays = spot.relays.length ? `${spot.relays.map(name).join('、')} 在接力` : ''
  const others = spot.others ? `${relays ? '另有' : '已有'} ${spot.others} 個工作在跑` : ''
  return [relays, others].filter(Boolean).join('、')
}

/** A cycle stops before a hop once a 5-hour window is used this much, unless `cycleQuotaStop` says otherwise. */
export const CYCLE_DEFAULT_QUOTA_STOP = 70

/** `cycleQuotaStop` option: the 5-hour usage percent (1–100) at which a cycle stops; `off` turns the brake off. */
export function cycleQuotaStop(value: unknown): number | null {
  if (typeof value === 'string' && /^\s*off\s*$/i.test(value)) return null
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim().replace(/%$/, '')) : NaN
  if (!Number.isFinite(raw)) return CYCLE_DEFAULT_QUOTA_STOP
  return Math.max(1, Math.min(100, Math.round(raw)))
}

export type UsageLimit = { kind: string; percent: number; resetsAt?: string }

/**
 * Why Claude's quota should stop a cycle before its next hop, or null: a 5-hour window used at or past the
 * limit, or any window that at its pace runs out within the hour. Every hop spends Claude quota, a gate hop
 * the console's own and a Codex hop that falls back to Claude; Codex's own quota keeps `codexMinQuotaPercent`.
 */
export function quotaBrake(limits: UsageLimit[] | undefined, stopAt: number | null, now: number, readAt?: number): string | null {
  if (stopAt === null) return null
  // The windows come with the console's own responses; while hops run in the background it may answer
  // nothing for a long time, and numbers that old cannot show what the executors have used since.
  if (limits?.length && readAt !== undefined && now - readAt > QUOTA_STALE_MS) {
    return `額度數字已 ${Math.floor((now - readAt) / 60_000)} 分沒更新，無法確認還剩多少：在主控台送一則訊息就會更新，再按 ⟳`
  }
  for (const limit of limits ?? []) {
    if (parseLimitKind(limit.kind)?.window === 'five_hour' && limit.percent >= stopAt) {
      return `額度煞車：${limitName(limit.kind)}額度已用 ${Math.round(limit.percent)}%（門檻 ${stopAt}%）`
    }
  }
  for (const limit of limits ?? []) {
    const pace = limitPace(limit.kind, limit.percent, limit.resetsAt, now)
    if (pace && !pace.lasts && pace.tone === 'red') return `額度煞車：${limitName(limit.kind)}額度${pace.text}`
  }
  return null
}

/** Claude's windows older than this cannot brake a cycle: it stops instead of guessing. */
export const QUOTA_STALE_MS = 45 * 60_000

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
      ...(queuedSpot(r.queued) ? { queued: queuedSpot(r.queued)! } : {}),
      ...(num(r.queuedUntil) ? { queuedUntil: r.queuedUntil as number } : {}),
    }
  }
  return out
}

/** A stored place in line, checked. */
function queuedSpot(value: unknown): { place: number; why: string } | null {
  const q = value as { place?: unknown; why?: unknown } | null
  return q && typeof q === 'object' && typeof q.place === 'number' && Number.isFinite(q.place) && typeof q.why === 'string' ? { place: q.place, why: q.why } : null
}

export type CyclePlan = { action: 'continue' | 'gate' | 'sync' | 'verify' } | { wait: string } | { stop: string; done?: boolean }

export type CycleOptions = {
  autoSync: 'on' | 'off'
  demo?: boolean
  /** A gate this cycle sent is still out (its review turn has not ended). */
  gatePending?: boolean
  /** How the project's latest sync ended, when one did. */
  syncStage?: string
  /** Claude's rate-limit windows as the usage table reads them, and the 5-hour percent that stops a cycle (null: off). */
  limits?: UsageLimit[]
  quotaStop?: number | null
  /** When the console last read those windows (its last API response); unknown leaves the age unchecked. */
  limitsAt?: number
  /** The CARD's 驗證: its latest result here and whether this console may run it (the person confirmed it once). */
  verification?: { result?: VerificationResult; trusted: boolean }
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
  const failed = project.jobs.find(job => job.kind === 'newer' && job.asks && job.error)
  if (failed) return { stop: `執行者出錯：${failed.error}` }
  if (project.jobs.some(job => job.kind === 'newer' && job.asks)) return { stop: '執行者在等你回覆' }
  // A gate hop waits for its review turn, and a gate the console left in place is not sent a second time.
  if (options.gatePending) return { wait: '等回合' }
  const gate = parseGate(project.gate)
  if (run.lastKind === 'gate' && run.lastGate !== undefined && gate && (project.gate ?? '').trim() === run.lastGate) return { stop: '主控台未放行關卡' }
  if (state === 'ACTION' || hasAsk(project)) return { stop: '等你決定／回覆' }
  if (gate?.kind === 'release') return { stop: '到 release 關卡，等你核准' }
  if (gate && gate.kind === 'unknown') return { stop: '關卡無法辨識' }
  const ended = project.jobs.find(job => job.kind === 'newer' && (job.status === 'failed' || job.status === 'cancelled'))
  if (ended) return { stop: ended.status === 'cancelled' ? '工作已停止' : '工作失敗' }
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
  const brake = quotaBrake(options.limits, options.quotaStop === undefined ? CYCLE_DEFAULT_QUOTA_STOP : options.quotaStop, now, options.limitsAt)
  if (brake) return { stop: brake }
  // Work this cycle sent is checked with the CARD's 驗證 before the next step goes out: a pass newer than the
  // last hop lets it go, a failure stops, and a command nobody confirmed here is not run on its own.
  const command = project.verify.trim()
  if (action === 'continue' && run.hops > 0 && command && options.verification) {
    const { result, trusted } = options.verification
    const fresh = result && result.command === command && result.at > run.lastAt ? result : undefined
    if (!fresh && !trusted) return { stop: '驗證指令還沒確認過：先按一次 ▶ 執行驗證，之後每跳之間會自己驗證' }
    if (!fresh) return { action: 'verify' }
    if (!fresh.ok) return { stop: `驗證沒過${fresh.exitCode === null ? '（逾時或無法執行）' : `（結束碼 ${fresh.exitCode}）`}` }
  }
  return { action }
}

/** The chip on the row and the next-step card: hops sent of the limit, or what the cycle waits for. */
export function cycleChip(run: CycleRun, foreign = false): string {
  if (foreign) return `⟳ ${FOREIGN_CYCLE}`
  if (run.queued) return `⟳ 排隊中・第 ${run.queued.place} 個`
  return run.waiting && run.waiting !== '稍候' ? `⟳ ${run.waiting}` : `⟳ ${run.hops}/${run.max}`
}

/** Why a hop was taken, for its feed line: the next step it continues, the gate it sends, or the sync. */
export function hopDetail(kind: 'continue' | 'gate' | 'sync', project: Project): string {
  if (kind === 'continue') return project.next.trim()
  if (kind === 'gate') return `${parseGate(project.gate)?.kind ?? ''} 關卡`
  return '結果寫回狀態卡'
}
