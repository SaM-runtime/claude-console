// Decide whether a Codex dispatch should go ahead, fall back to Claude, or ask the operator.
import type { FallbackMode } from './config'

export const QUOTA_STALE_MS = 6 * 3_600_000

export type CodexQuota = { at: string; limits: { label: string; percent: number; resetsAt?: string }[] } | null | undefined
export type QuotaReading = { state: 'ok' | 'low' | 'unknown'; remaining: number | null; ageMs: number | null }
export type FallbackDecision =
  | { action: 'codex' }
  | { action: 'claude'; reason: string }
  | { action: 'ask'; reason: string }

/**
 * Lowest remaining percentage across the quota windows. A reading older than six hours,
 * without a timestamp, or without windows is `unknown` and never triggers a fallback by itself.
 */
export function quotaReading(quota: CodexQuota, minPercent: number, now: number): QuotaReading {
  if (!quota || !quota.limits.length) return { state: 'unknown', remaining: null, ageMs: null }
  const at = Date.parse(quota.at)
  if (!Number.isFinite(at)) return { state: 'unknown', remaining: null, ageMs: null }
  const ageMs = Math.max(0, now - at)
  const remaining = Math.min(...quota.limits.map(limit => Math.max(0, Math.min(100, Math.round(100 - limit.percent)))))
  if (ageMs > QUOTA_STALE_MS) return { state: 'unknown', remaining, ageMs }
  return { state: remaining < minPercent ? 'low' : 'ok', remaining, ageMs }
}

/** Why the preflight line (already filtered to this project's workspace) blocks Codex, or ''. */
export function preflightProblem(line: string, companionPath: string): string {
  const text = line.trim()
  if (text.startsWith('STALE')) return 'Codex broker 過期（Codex app 已更新）'
  if (/\bcodex=unavailable\b/.test(text)) return '找不到 Codex app／broker'
  if (/\bcompanion=MISSING\b/.test(text)) return '找不到 codex-companion.mjs'
  if (!companionPath.trim()) return '未設定且找不到 codex-companion.mjs'
  return ''
}

export type FallbackInput = {
  mode: FallbackMode
  minPercent: number
  quota: CodexQuota
  preflight: string
  companionPath: string
  now: number
}

/** `off` keeps the 0.1 behavior: always try Codex. */
export function decideCodexDispatch(input: FallbackInput): FallbackDecision {
  if (input.mode === 'off') return { action: 'codex' }
  const reasons: string[] = []
  const problem = preflightProblem(input.preflight, input.companionPath)
  if (problem) reasons.push(problem)
  const quota = quotaReading(input.quota, input.minPercent, input.now)
  if (quota.state === 'low') reasons.push(`Codex 額度剩 ${quota.remaining}%（低於 ${input.minPercent}%）`)
  if (!reasons.length) return { action: 'codex' }
  return { action: input.mode === 'claude' ? 'claude' : 'ask', reason: reasons.join('；') }
}
