// Usage pace: whether a rate-limit window, used at the rate it has been so far, lasts until it resets.
// Pure: no I/O. The idea of showing pace beside the 5-hour and 7-day meters comes from session-meter in
// arasovic/claude-code-mods (MIT); this is console-status's own implementation.
import { parseLimitKind } from './logic'

const HOUR = 3_600_000
/** A window this young has too little history for a rate to mean anything. */
export const PACE_MIN_ELAPSED_MS = 10 * 60_000

export function windowMs(kind: string): number | null {
  const parsed = parseLimitKind(kind)
  return parsed ? (parsed.window === 'five_hour' ? 5 * HOUR : 7 * 24 * HOUR) : null
}

/** `1 天 4 小時`, `2 小時 13 分`, `40 分`. */
export function spanText(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000))
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60
  return d ? `${d} 天 ${h} 小時` : h ? `${h} 小時 ${m} 分` : `${m} 分`
}

export type Pace = { lasts: true } | { lasts: false; emptyInMs: number; text: string; tone: 'amber' | 'red' }

/**
 * At the average rate since the window opened (its length before `resetsAt`), does the rest last until the
 * reset? When not, how long until it runs out: red inside an hour, amber otherwise. Null when the window is
 * unknown, too young, already empty, or unused.
 */
export function limitPace(kind: string, percent: number, resetsAt: string | undefined, now: number): Pace | null {
  const length = windowMs(kind)
  const reset = resetsAt ? Date.parse(resetsAt) : NaN
  if (length === null || !Number.isFinite(reset) || percent <= 0 || percent >= 100) return null
  const left = reset - now
  const elapsed = length - left
  if (left <= 0 || elapsed < PACE_MIN_ELAPSED_MS) return null
  const rate = percent / elapsed
  if (percent + rate * left <= 100) return { lasts: true }
  const emptyInMs = (100 - percent) / rate
  return { lasts: false, emptyInMs, text: `照目前速度約 ${spanText(emptyInMs)}後用完`, tone: emptyInMs < HOUR ? 'red' : 'amber' }
}
