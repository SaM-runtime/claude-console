// The while-away digest: what the feed said while nobody used the console, summed up for the return.
// Pure logic; register.tsx keeps the state in atoms and calls these on use and on drawing.
import type { AwayDigest, FeedEvent, FeedKind } from '../types'

/** Feed lines kept for the digest; a longer absence keeps the newest. */
export const AWAY_LOG_MAX = 200
/** Lines the digest lists under its counts; the rest are only counted. */
export const AWAY_SHOWN = 4

/** When the person last used the console, the feed lines since, and the digest frozen at their last return. */
export type AwayState = { activeAt: number; log: FeedEvent[]; digest: AwayDigest | null }

/**
 * The person used the console at `now`. Back after `awayMs` or more with feed lines since: the digest of that time is
 * frozen, to stay up until dismissed. The log starts over either way, since what came before was seen.
 */
export function cameBack(state: AwayState, now: number, awayMs: number | null): AwayState {
  const since = state.log.filter(event => event.at > state.activeAt)
  const away = awayMs !== null && now - state.activeAt >= awayMs && since.length > 0
  return { activeAt: now, log: [], digest: away ? { from: state.activeAt, to: now, events: since } : state.digest }
}

/**
 * The digest to show at `now`: the one still growing while the person is away, else the one frozen at their return
 * until it is as old as an absence. `awayMs` null (`awayMinutes: off`) shows none.
 */
export function awayView(state: AwayState, now: number, awayMs: number | null): AwayDigest | null {
  if (awayMs === null) return null
  const since = state.log.filter(event => event.at > state.activeAt)
  if (now - state.activeAt >= awayMs && since.length) return { from: state.activeAt, to: now, events: since }
  return state.digest && now - state.digest.to < awayMs ? state.digest : null
}

/** `40 分鐘`, `2 小時 15 分`, `3 天 2 小時`. */
export function awayFor(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes} 分鐘`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} 小時 ${minutes % 60} 分` : `${hours} 小時`
  return hours % 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小時` : `${Math.floor(hours / 24)} 天`
}

const COUNTS: [FeedKind[], (n: number) => string][] = [
  [['done'], n => `完成 ${n} 個工作`],
  [['failed'], n => `${n} 個失敗或出錯`],
  [['decision', 'gate', 'asks', 'waiting'], n => `${n} 件新的等你處理`],
  [['ci-fail'], n => `CI 失敗 ${n} 次`],
  [['merged'], n => `合併 ${n} 個 PR`],
  [['cycle-stop'], n => `自動接力停下 ${n} 次`],
  [['status'], n => `狀態卡更新 ${n} 次`],
]

/** The counts line: `完成 3 個工作・1 個失敗或出錯・2 件新的等你處理`, or how many lines when none of them counts. */
export function awayCounts(events: FeedEvent[]): string {
  const parts = COUNTS.flatMap(([kinds, text]) => {
    const n = events.filter(event => event.kind && kinds.includes(event.kind)).length
    return n ? [text(n)] : []
  })
  return parts.length ? parts.join('・') : `${events.length} 則動態`
}

const RANK: Record<FeedEvent['tone'], number> = { red: 0, amber: 1, green: 2, blue: 3, teal: 4 }

/** The lines worth reading first: failures, then what waits on you, then the rest; newest first, each text once. */
export function awayHighlights(events: FeedEvent[], max = AWAY_SHOWN): FeedEvent[] {
  const seen = new Set<string>()
  return [...events]
    .sort((a, b) => RANK[a.tone] - RANK[b.tone] || b.at - a.at)
    .filter(event => !seen.has(event.text) && seen.add(event.text))
    .slice(0, max)
}

/** The digest as text, for /console inbox: the time away and the counts, then the lines worth reading first. */
export function awayText(digest: AwayDigest, ago: (at: number) => string): string[] {
  const shown = awayHighlights(digest.events)
  const more = digest.events.length - shown.length
  return [
    `你離開的 ${awayFor(digest.to - digest.from)}裡：${awayCounts(digest.events)}`,
    ...shown.map(event => `・${event.text.replace('　', '：')}（${ago(event.at)}）`),
    ...(more > 0 ? [`・…另 ${more} 則`] : []),
  ]
}
