// Prompt-cache clock for this console session: how long until the cached context goes cold, and
// what the next prompt would cost to re-write it once it has. Pure: no I/O.
import type { CacheClock } from '../types'

export type CacheTtl = '5m' | '1h'
export const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
/** Contexts smaller than this cost too little to be worth a chip or a toast. */
export const CACHE_MIN_TOKENS = 20_000
/** The warning toast fires once this much of the TTL is left. */
export const CACHE_WARN_MS = 60_000

/** `cacheTtl` option: `5m`, `1h`, or `auto` (learned from what the API served after an idle gap, 5m until then). */
export function cacheTtlOption(value: unknown): CacheTtl | 'auto' {
  const v = String(value ?? '').trim().toLowerCase()
  return v === '5m' || v === '1h' ? v : 'auto'
}

/** List input price per million tokens (USD) by model id; null for a model this table does not know. */
export function inputPricePerMTok(model: string): number | null {
  const m = model.toLowerCase()
  if (/fable|mythos/.test(m)) return 10
  if (/opus-5-5|opus-5\.5/.test(m)) return 4
  if (/opus/.test(m)) return 5
  if (/sonnet-5/.test(m)) return 2
  if (/sonnet/.test(m)) return 3
  if (/haiku-4/.test(m)) return 1
  if (/haiku/.test(m)) return 0.8
  return null
}

/** What re-writing `tokens` to the cache costs: 1.25× input for the 5-minute TTL, 2× for one hour. */
export function rewriteCost(tokens: number, model: string, ttl: CacheTtl, override?: number | null): number | null {
  const perMTok = override && override > 0 ? override : (() => {
    const input = inputPricePerMTok(model)
    return input === null ? null : input * (ttl === '1h' ? 2 : 1.25)
  })()
  return perMTok === null ? null : (tokens / 1_000_000) * perMTok
}

/** `cacheWritePrice` option: USD per million cache-write tokens, or null (use the model table). */
export function priceOverride(value: unknown): number | null {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The TTL a request's usage proves, or null. A request that starts more than five minutes after the
 * previous one and still reads most of the previous context from the cache can only be on the
 * one-hour TTL; one that reads almost nothing after a 5–60 minute gap on the same model is on five.
 */
export function learnTtl(prev: CacheClock | null, startedAt: number, model: string, cacheRead: number): CacheTtl | null {
  if (!prev || prev.model !== model || prev.tokens < CACHE_MIN_TOKENS) return null
  const gap = startedAt - prev.at
  if (gap <= TTL_MS['5m'] + 15_000 || gap >= TTL_MS['1h'] - 60_000) return null
  if (cacheRead >= prev.tokens * 0.5) return '1h'
  if (cacheRead <= prev.tokens * 0.1) return '5m'
  return null
}

export function usd(value: number): string {
  return value >= 10 ? `$${value.toFixed(1)}` : `$${value.toFixed(2)}`
}

export function tokensText(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`
}

/** `4m`, `45s` in the last minute, `1h`. */
export function leftText(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.ceil(ms / 1000))}s`
  const minutes = Math.floor(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`
}

export type CacheView = { warm: boolean; leftMs: number; coldForMs: number; cost: number | null; ttl: CacheTtl }

/** Where the clock stands at `now`; null while a turn runs (it refreshes the cache) or the context is small. */
export function cacheView(clock: CacheClock | null | undefined, now: number, busy: boolean, override: number | null): CacheView | null {
  if (!clock || busy || clock.tokens < CACHE_MIN_TOKENS) return null
  const ttl = clock.ttl
  const left = clock.at + TTL_MS[ttl] - now
  return { warm: left > 0, leftMs: Math.max(0, left), coldForMs: Math.max(0, -left), cost: rewriteCost(clock.tokens, clock.model, ttl, override), ttl }
}

/** The band chip: `快取 4m` while warm, `快取已冷 $0.90` once cold. */
export function cacheChip(view: CacheView, compact: boolean): { text: string; tone: 'green' | 'amber' | 'red' } {
  if (view.warm) return { text: compact ? `⧗${leftText(view.leftMs)}` : `快取 ${leftText(view.leftMs)}`, tone: view.leftMs <= CACHE_WARN_MS ? 'amber' : 'green' }
  const cost = view.cost === null ? '' : ` ${usd(view.cost)}`
  return { text: compact ? `⧗冷${cost}` : `快取已冷${cost}`, tone: 'red' }
}

/** The one-line toast before the cache goes cold, and the one when a prompt goes out on a cold cache. */
export function cacheWarning(clock: CacheClock, view: CacheView): string {
  const cost = view.cost === null ? '' : `（約 ${usd(view.cost)}）`
  return view.warm
    ? `主控台快取 ${leftText(view.leftMs)} 後過期：之後送出的提示會重寫約 ${tokensText(clock.tokens)} tokens${cost}`
    : `主控台快取已過期 ${leftText(view.coldForMs)}：這則提示會重寫約 ${tokensText(clock.tokens)} tokens${cost}`
}

export type TtlSource = 'usage' | 'learned' | 'option' | 'default'

/** The last main-thread response a Claude Code transcript (JSONL) records, with the TTL its cache writes used. */
export type TranscriptCache = { at: number; tokens: number; model: string; ttl: CacheTtl | null }

/**
 * Reads a transcript's tail: the newest main-thread response with usage, timed from the entry before it
 * (the request's start), and the TTL of the newest response that wrote to the cache. Claude Code records
 * the API's `usage.cache_creation` split (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`),
 * which is the TTL actually in force. Null when no response is there.
 */
export function transcriptCache(text: string): TranscriptCache | null {
  const rows: any[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try { rows.push(JSON.parse(line)) } catch { /* a cut first line of a tail */ }
  }
  const main = rows.filter(r => r && !r.isSidechain && typeof r.timestamp === 'string' && (r.type === 'assistant' || r.type === 'user'))
  let last = -1
  for (let i = main.length - 1; i >= 0; i--) if (main[i].type === 'assistant' && main[i].message?.usage) { last = i; break }
  if (last < 0) return null
  const msg = main[last].message
  const u = msg.usage
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0
  // A response is split into one row per block, all under one message id: start before the first.
  let first = last
  while (first > 0 && main[first - 1].type === 'assistant' && main[first - 1].message?.id === msg.id) first--
  const startRow = first > 0 ? main[first - 1] : main[first]
  const at = Date.parse(startRow.timestamp)
  if (!Number.isFinite(at)) return null
  let ttl: CacheTtl | null = null
  for (let i = last; i >= 0 && !ttl; i--) {
    const c = main[i].type === 'assistant' ? main[i].message?.usage?.cache_creation : null
    if (!c) continue
    if (num(c.ephemeral_1h_input_tokens) > 0) ttl = '1h'
    else if (num(c.ephemeral_5m_input_tokens) > 0) ttl = '5m'
  }
  return {
    at,
    tokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens),
    model: String(msg.model ?? ''),
    ttl,
  }
}

/** Where Claude Code keeps a session's transcript when no hook has named it: `<config>/projects/<cwd, non-alphanumerics as ->/<id>.jsonl`. */
export function transcriptPathFor(configDir: string, cwd: string, sessionId: string): string {
  return `${configDir.replace(/[\\/]+$/, '')}/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
}

/** The TTL label in the pane: `1h・實際` when read from usage, `5m・預設` before anything is known. */
export function ttlLabel(ttl: CacheTtl, source: TtlSource | undefined): string {
  return `${ttl}・${source === 'usage' ? '實際' : source === 'option' ? '設定' : source === 'learned' ? '推測' : '預設'}`
}
