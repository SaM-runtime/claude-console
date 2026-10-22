/**
 * Each project's use: what the work the console dispatched for it used in this week's and this 5-hour window, read
 * from the transcripts of its sessions and priced at API list prices. Codex keeps no token record, so its jobs are only
 * counted. Pure parts first; `loadUsage` is the one that touches files, through the `DigestIo` it is given, and reads a
 * transcript again only past where it stopped the last time.
 */
import type { ProjectUsage, UsageSum } from '../types'
import { modelPrice, transcriptPathFor, usd } from './cache'
import { READ_LIMIT, findTranscript } from './digest'
import type { DigestIo } from './digest'
import { rootKey } from './executors'
import { parseLimitKind } from './logic'
import { PS_UTF8 } from './platform'

/** One API response a transcript records. */
export type UsageEntry = { at: number; model: string; input: number; write5m: number; write1h: number; read: number; output: number }
/** How far one transcript was read (bytes of whole lines) and the responses found there, one per response. */
export type TranscriptUsage = { size: number; mtimeMs: number; bytes: number; entries: Map<string, UsageEntry> }
/** Transcript path → what was read of it, kept while the console runs. */
export type UsageCache = Map<string, TranscriptUsage>
export type UsageWindow = { start: number; label: string }
/** Test hooks: where whole reads stop, and the span and output of one process read. */
export type UsageReadOptions = { limit?: number; span?: number; cap?: number }

const WEEK_MS = 7 * 86_400_000
const FIVE_HOURS_MS = 5 * 3_600_000
/** Bytes of a transcript one process read looks through, once the transcript is past what `$.fs.read` takes. */
export const USAGE_SPAN = 64 * 1024 * 1024
/** Bytes of usage lines one process read prints at most: under the 4 MiB of output a run keeps. */
export const USAGE_OUT = 3_500_000
/** Jobs claude-sessions.json keeps per project (executors.ts MAX_HISTORY): with that many, older ones may have dropped off. */
const KEPT_JOBS = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** Bytes `text` takes in UTF-8. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++ }
    else bytes += 3
  }
  return bytes
}

/**
 * The response one transcript line records, under a key the other lines of that response share (Claude Code writes a
 * line per content block, each with the whole response's usage, and a resumed copy of a session repeats them); null for
 * any other line.
 */
export function usageEntry(line: string): [string, UsageEntry] | null {
  if (!line.includes('"output_tokens"')) return null
  let row: any
  try { row = JSON.parse(line) } catch { return null }
  const message = row?.message
  const usage = message?.usage
  if (row?.type !== 'assistant' || !usage || typeof usage !== 'object') return null
  const at = Date.parse(String(row.timestamp ?? ''))
  const key = [message.id, row.requestId].filter(id => typeof id === 'string' && id).join('|') || (typeof row.uuid === 'string' ? row.uuid : '')
  if (!Number.isFinite(at) || !key) return null
  const written = count(usage.cache_creation_input_tokens)
  const write1h = Math.min(written, count(usage.cache_creation?.ephemeral_1h_input_tokens))
  const entry: UsageEntry = {
    at, model: typeof message.model === 'string' ? message.model : '',
    input: count(usage.input_tokens), write5m: written - write1h, write1h, read: count(usage.cache_read_input_tokens), output: count(usage.output_tokens),
  }
  return entryTokens(entry) > 0 ? [key, entry] : null
}

/** Tokens of every kind one response used: input, cache writes and reads, output. */
export const entryTokens = (e: UsageEntry) => e.input + e.write5m + e.write1h + e.read + e.output

/** What one response costs at API list prices (writes 1.25× input for 5 minutes, 2× for one hour; output 5×); null for a model with no list price. */
export function entryCost(e: UsageEntry): number | null {
  const price = modelPrice(e.model, e.input + e.write5m + e.write1h + e.read)
  if (!price) return null
  return (e.input * price.input + e.write5m * price.input * 1.25 + e.write1h * price.input * 2 + e.read * price.read + e.output * price.input * 5) / 1_000_000
}

/** The responses from `from` on: their tokens, and their cost when every model among them has a list price (`unknown` names the rest). */
export function usageSum(entries: Iterable<UsageEntry>, from: number): UsageSum & { unknown: string[] } {
  let tokens = 0
  let cost = 0
  const unknown = new Set<string>()
  for (const e of entries) {
    if (e.at < from) continue
    tokens += entryTokens(e)
    const price = entryCost(e)
    if (price === null) unknown.add(e.model || '?')
    else cost += price
  }
  return { tokens, cost: unknown.size ? null : cost, unknown: [...unknown] }
}

/**
 * The windows the figures cover: the weekly and 5-hour windows Claude Code reported with its last response (each starts
 * its length before its reset), else the last 7 days and 5 hours.
 */
export function usageWindows(limits: { kind: string; resetsAt?: string }[] | undefined, now: number): { week: UsageWindow; five: UsageWindow } {
  const start = (window: 'seven_day' | 'five_hour', length: number): number | null => {
    for (const limit of limits ?? []) {
      const kind = parseLimitKind(limit.kind)
      const reset = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
      if (kind?.window === window && !kind.model && Number.isFinite(reset) && reset > now && reset - length <= now) return reset - length
    }
    return null
  }
  const week = start('seven_day', WEEK_MS)
  return {
    week: week === null ? { start: now - WEEK_MS, label: '近 7 天' } : { start: week, label: '本週' },
    five: { start: start('five_hour', FIVE_HOURS_MS) ?? now - FIVE_HOURS_MS, label: '5 小時內' },
  }
}

/** What the console dispatched for a project root: the sessions its jobs ran in, and when each job it still keeps started. */
export function dispatchedWork(state: unknown, root: string): { sessions: string[]; starts: number[]; full: boolean } {
  const roots = (state as { roots?: unknown } | null)?.roots
  const entry = roots && typeof roots === 'object' ? (roots as Record<string, any>)[rootKey(root)] : null
  if (!entry || typeof entry !== 'object') return { sessions: [], starts: [], full: false }
  const jobs: any[] = Array.isArray(entry.jobs) ? entry.jobs : []
  const sessions = new Map<string, string>()
  for (const id of [entry.sessionId, ...jobs.flatMap(job => [job?.sessionId, job?.unmanagedSessionId])]) {
    if (typeof id === 'string' && UUID.test(id) && !sessions.has(id.toLowerCase())) sessions.set(id.toLowerCase(), id)
  }
  return { sessions: [...sessions.values()], starts: jobs.map(job => Date.parse(String(job?.startedAt ?? ''))).filter(Number.isFinite), full: jobs.length >= KEPT_JOBS }
}

/** awk, byte for byte: the usage lines of what it is fed, `cap` bytes of them at most, then `#consumed N`, the bytes of whole lines it went past. */
const USAGE_AWK = [
  'function take(line, n) {',
  '  if (index(line, "\\"output_tokens\\"")) {',
  '    if (out + n > cap) { if (out > 0) { stop = 1; return } }',
  '    else { print line; out += n }',
  '  }',
  '  done += n',
  '}',
  'NR > 1 { take(prev, size); if (stop) exit }',
  '{ prev = $0; size = length($0) + 1 }',
  'END { if (!stop && NR > 0 && done + size <= total) take(prev, size); print "#consumed " (done + 0) }',
].join('\n')

/**
 * Reads `bytes` bytes of a transcript from byte `from` and prints only its usage lines (`cap` bytes of them at most;
 * a longer one alone is passed over), then `#consumed N`: how far its whole lines went, where the next read starts.
 */
export function usageChunkArgs(path: string, windows: boolean, from: number, bytes: number, cap = USAGE_OUT): string[] {
  if (!windows) return ['sh', '-c', 'tail -c +"$2" -- "$1" | head -c "$3" | LC_ALL=C awk -v total="$3" -v cap="$4" "$5"', 'sh', path, String(from + 1), String(bytes), String(cap), USAGE_AWK]
  const quoted = path.replace(/'/g, "''")
  return ['powershell', '-NoProfile', '-NonInteractive', '-Command',
    `${PS_UTF8}$f=[IO.File]::Open('${quoted}','Open','Read','ReadWrite'); try { [void]$f.Seek(${from},'Begin'); $n=${bytes}; $b=New-Object byte[] $n; $t=0; `
    + 'while ($t -lt $n) { $r=$f.Read($b,$t,$n-$t); if ($r -le 0) { break }; $t+=$r }; '
    + "$u=New-Object Text.UTF8Encoding $false; $q=[string][char]34; $k=$q+'output_tokens'+$q; $o=New-Object Text.StringBuilder; $s=0; $w=0; "
    + `while ($s -lt $t) { $e=[Array]::IndexOf($b,[byte]10,$s,$t-$s); if ($e -lt 0) { break }; $l=$e-$s+1; $x=$u.GetString($b,$s,$e-$s); `
    + `if ($x.Contains($k)) { if ($w+$l -gt ${cap}) { if ($w -gt 0) { break } } else { [void]$o.Append($x).Append([char]10); $w+=$l } }; $s=$e+1 }; `
    + "[void]$o.Append('#consumed ').Append($s); [Console]::Out.Write($o.ToString()) } finally { $f.Close() }"]
}

/** A process read's output: the usage lines and how many bytes it went past; null when the output was cut short. */
export function usageChunk(stdout: string): { lines: string[]; consumed: number } | null {
  const text = stdout.replace(/\r?\n$/, '')
  const cut = text.lastIndexOf('\n')
  const tail = /^#consumed (\d+)\r?$/.exec(text.slice(cut + 1))
  return tail ? { lines: cut < 0 ? [] : text.slice(0, cut).split('\n'), consumed: Number(tail[1]) } : null
}

/**
 * Brings one transcript's responses up to date in `cache`: unchanged (same size and mtime) it is not read; grown, only
 * what was appended past the last whole line read is; shrunk (rewritten), it is read again. Up to 4 MiB it is read
 * whole; past that, a small process prints only its usage lines, a span at a time. Responses before `keepFrom` are dropped.
 */
export async function readTranscriptUsage(io: DigestIo, path: string, cache: UsageCache, keepFrom: number, opts: UsageReadOptions = {}): Promise<TranscriptUsage> {
  const { limit = READ_LIMIT, span = USAGE_SPAN, cap = USAGE_OUT } = opts
  const stat = await io.stat(path)
  const known = cache.get(path)
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known
  const entries = new Map<string, UsageEntry>()
  const add = (line: string) => {
    const found = usageEntry(line)
    if (found && found[1].at >= keepFrom) entries.set(found[0], found[1])
  }
  let bytes = 0
  if (stat.size <= limit) {
    const text = await io.read(path)
    const whole = text.slice(0, text.lastIndexOf('\n') + 1)
    for (const line of whole.split('\n')) add(line)
    bytes = utf8Length(whole)
  } else {
    if (known && known.bytes <= stat.size) {
      bytes = known.bytes
      for (const [key, entry] of known.entries) if (entry.at >= keepFrom) entries.set(key, entry)
    }
    while (bytes < stat.size) {
      const want = Math.min(span, stat.size - bytes)
      const result = await io.run(usageChunkArgs(path, io.windows, bytes, want, cap), { timeoutMs: 120_000 })
      const chunk = result.exitCode === 0 ? usageChunk(result.stdout) : null
      if (!chunk) throw new Error(`讀取對話紀錄失敗（${result.exitCode === 0 ? '輸出不完整' : `結束碼 ${result.exitCode}`}）`)
      for (const line of chunk.lines) add(line)
      if (chunk.consumed > 0) bytes += chunk.consumed
      // No line ends inside a whole span: step past it (the rest of that line will not parse on its own).
      else if (want === span) bytes += span
      // The last line is still being written.
      else break
    }
  }
  const read = { size: stat.size, mtimeMs: stat.mtimeMs, bytes, entries }
  cache.set(path, read)
  return read
}

export type UsageSources = {
  root: string
  claudeDir: string
  /** claude-sessions.json, parsed. */
  sessions: unknown
  /** The project's Codex jobs, as the companion's state lists them. */
  codex: { startedAt?: string; createdAt?: string }[]
}

/**
 * A project's figures: the responses of every session the console dispatched it in (subagents' transcripts included),
 * each counted once, in the weekly and 5-hour windows; its Claude and Codex jobs started this week. Transcripts last
 * written before the week are not read. Throws when a transcript cannot be read.
 */
export async function loadUsage(io: DigestIo, sources: UsageSources, cache: UsageCache, paths: Map<string, string>, windows: { week: UsageWindow; five: UsageWindow }, now: number, opts: UsageReadOptions = {}): Promise<ProjectUsage> {
  const { week, five } = windows
  const work = dispatchedWork(sources.sessions, sources.root)
  const entries = new Map<string, UsageEntry>()
  for (const id of work.sessions) {
    const direct = transcriptPathFor(sources.claudeDir, sources.root, id)
    const path = await io.exists(direct).catch(() => false) ? direct : await findTranscript(io, sources.claudeDir, id, paths)
    if (!path) continue
    const subagents = `${path.slice(0, -'.jsonl'.length)}/subagents`
    const listed = await io.list(subagents).catch(() => [])
    for (const file of [path, ...listed.filter(f => f.kind !== 'dir' && f.name.endsWith('.jsonl')).map(f => `${subagents}/${f.name}`)]) {
      const stat = await io.stat(file).catch(() => null)
      if (!stat || stat.mtimeMs < week.start) continue
      // Every window starts within the last 7 days, so older responses are never needed again.
      for (const [key, entry] of (await readTranscriptUsage(io, file, cache, now - WEEK_MS, opts)).entries) entries.set(key, entry)
    }
  }
  const all = [...entries.values()]
  const { unknown, ...weekSum } = usageSum(all, week.start)
  const { tokens, cost } = usageSum(all, five.start)
  const inWeek = (at: number) => Number.isFinite(at) && at >= week.start
  return {
    at: now, label: week.label, start: week.start,
    week: { ...weekSum, ...(unknown.length ? { unknown } : {}) },
    five: { tokens, cost },
    jobs: work.starts.filter(inWeek).length,
    ...(work.full && work.starts.length && inWeek(Math.min(...work.starts)) ? { atLeast: true } : {}),
    codex: sources.codex.filter(job => inWeek(Date.parse(job.startedAt ?? job.createdAt ?? ''))).length,
  }
}

/** `9,800`, `3.2 萬`, `180 萬`, `1.4 億`. */
export function tokenCount(tokens: number): string {
  const n = Math.round(tokens)
  const short = (value: number, unit: string) => `${value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value))} ${unit}`
  if (n < 10_000) return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (Math.round(n / 10_000) < 10_000) return short(n / 10_000, '萬')
  return short(n / 100_000_000, '億')
}

/** What a sum costs: `約 $4.20（API 牌價）`, or why it is not estimated. */
function costText(sum: ProjectUsage['week']): string {
  return sum.cost === null ? `${(sum.unknown ?? []).join('、') || '有的模型'} 沒有牌價，不估金額` : `約 ${usd(sum.cost)}（API 牌價）`
}

/** `4 次工作（Codex 2 次不計 token）`, `至少 20 次工作`, or '' with none. */
function jobsText(u: ProjectUsage): string {
  const all = u.jobs + u.codex
  if (!all) return ''
  const note = !u.codex ? '' : u.jobs || u.week.tokens ? `（Codex ${u.codex} 次不計 token）` : '（Codex 不提供 token 數）'
  return `${u.atLeast ? '至少 ' : ''}${all} 次工作${note}`
}

/** The card's 用量 row: `本週 4 次工作・180 萬 tokens・約 $4.20（API 牌價）・5 小時內 60 萬`. */
export function usageLine(u: ProjectUsage): string {
  const jobs = jobsText(u)
  if (!u.week.tokens) return jobs ? `${u.label} ${jobs}${u.jobs ? '・還沒有用量紀錄' : ''}` : `${u.label}沒有派工`
  const parts = [jobs, `${tokenCount(u.week.tokens)} tokens`, costText(u.week), u.five.tokens ? `5 小時內 ${tokenCount(u.five.tokens)}` : ''].filter(Boolean)
  return `${u.label} ${parts.join('・')}`
}

/** `10/20 (一) 21:00`. */
function whenText(at: number): string {
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()} (${'日一二三四五六'[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export type UsageReportRow = { name: string; usage: ProjectUsage | null; error?: string }

/**
 * `/console usage`: each project's figures, the most first, with its share of what the console's dispatched work used
 * (by cost when every project's has a list price, else by tokens); then the projects with none, and those that could not be read.
 */
export function usageReport(rows: UsageReportRow[]): string {
  const read = rows.filter((row): row is UsageReportRow & { usage: ProjectUsage } => !!row.usage)
  const first = read[0]?.usage
  if (!first) return rows.length ? rows.map(row => `${row.name}：讀不到（${row.error ?? '原因不明'}）`).join('\n') : '還沒有專案資料；先 /console refresh。'
  const used = read.filter(row => row.usage.week.tokens > 0)
  const priced = used.every(row => row.usage.week.cost !== null)
  const weight = (u: ProjectUsage) => priced ? u.week.cost ?? 0 : u.week.tokens
  const total = used.reduce((sum, row) => sum + weight(row.usage), 0)
  const lines = [
    `各專案用量・${first.label}${first.label === '本週' ? `（從 ${whenText(first.start)} 額度重置算起）` : ''}`,
    '金額照 API 牌價估，訂閱方案不會另外收這筆錢；只算主控台派出去的工作，主控台自己的對話看用量表的「花費」。',
  ]
  for (const row of [...used].sort((a, b) => weight(b.usage) - weight(a.usage))) {
    const u = row.usage
    const share = total > 0 ? `（${Math.round((weight(u) / total) * 100)}%）` : ''
    const parts = [`${tokenCount(u.week.tokens)} tokens${priced ? '' : share}`, u.week.cost === null ? costText(u.week) : `約 ${usd(u.week.cost)}${priced ? share : ''}`, jobsText(u), u.five.tokens ? `5 小時內 ${tokenCount(u.five.tokens)}` : '']
    lines.push(`${row.name}　${parts.filter(Boolean).join('・')}`)
  }
  for (const row of read.filter(r => !r.usage.week.tokens && r.usage.jobs + r.usage.codex > 0)) lines.push(`${row.name}　${jobsText(row.usage)}`)
  if (used.length > 1) {
    const tokens = used.reduce((sum, row) => sum + row.usage.week.tokens, 0)
    const cost = used.reduce((sum, row) => sum + (row.usage.week.cost ?? 0), 0)
    lines.push(`合計　${tokenCount(tokens)} tokens${priced ? `・約 ${usd(cost)}` : ''}`)
  }
  const idle = read.filter(r => !r.usage.week.tokens && !(r.usage.jobs + r.usage.codex)).map(r => r.name)
  if (idle.length) lines.push(`沒有派工：${idle.join('、')}`)
  for (const row of rows.filter(r => !r.usage)) lines.push(`${row.name}：讀不到（${row.error ?? '原因不明'}）`)
  return lines.join('\n')
}
