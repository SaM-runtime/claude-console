// Pure logic for console-status: no I/O, so tests can exercise it directly.
import type { Blocked, ExecutorTask, JobFlag, Project, Snapshot } from '../types'
import { commitLine, gitLine, prLine, prTransitions } from './git'
import { parseProjectExecutor } from './dispatch'
import type { ProjectExecutor } from './dispatch'

export const STALE_DAYS = 3
export const ROTATE_PERCENT = 50
const NONE = new Set(['', '無', '沒有', '-', '未知'])

export type RegistryRow = { name: string; statusPath: string; executor?: ProjectExecutor }
export type Job = { id: string; kind?: 'sync' | 'continue'; fallbackFrom?: 'codex'; fallbackReason?: string; unmanagedSessionId?: string; warning?: string; executor?: 'claude' | 'codex'; nativeId?: string; sessionId?: string; jobClass?: string; status?: string; summary?: string; createdAt?: string; updatedAt?: string; completedAt?: string; startedAt?: string; phase?: string; logFile?: string; request?: { prompt?: string; effort?: string; model?: string } }
export type Agent = { name?: string; kind?: string; status?: string; state?: string; waitingFor?: string; sessionId?: string; cwd?: string; pid?: number | null; startedAt?: number | string }

/**
 * Rows of the "STATUS 卡位置" table in projects-scope.md; `~` expanded to `home`.
 * An optional `Executor` header column (claude | codex | manual | blank) sets a project's executor;
 * tables without that column parse exactly as before.
 */
export function parseRegistry(text: string, home: string): RegistryRow[] {
  const parts = lf(text).split('## STATUS 卡位置')
  if (parts.length < 2) return []
  const section = parts[1].split('\n## ')[0]
  const rows: RegistryRow[] = []
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
  let executorColumn = -1
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`/)
    if (!m) {
      if (/^\s*\|/.test(line) && !/^\s*\|[\s|:-]*$/.test(line)) {
        const header = cells(line).findIndex(cell => /^executor$/i.test(cell))
        if (header >= 0) executorColumn = header
      }
      continue
    }
    const row: RegistryRow = { name: m[1], statusPath: m[2].replace(/^~/, home).replace(/\\/g, '/') }
    const executor = executorColumn >= 0 ? parseProjectExecutor(cells(line)[executorColumn]?.replace(/`/g, '')) : undefined
    if (executor) row.executor = executor
    rows.push(row)
  }
  return rows
}

/** CRLF (or a lone CR) as LF: a STATUS or registry saved on Windows reads like any other. */
const lf = (text: string) => text.replace(/\r\n?/g, '\n')

/** `- key：value` lines between `<!-- CARD ... -->` and `<!-- /CARD -->`; null when absent. */
export function parseCard(text: string): Record<string, string> | null {
  const m = lf(text).match(/<!-- CARD[\s\S]*?-->([\s\S]*?)<!-- \/CARD -->/)
  if (!m) return null
  const card: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s*-\s*([^：:]+)[：:]\s*(.*)$/)
    if (km) card[km[1].trim()] = km[2].trim()
  }
  return card
}

export type Gate = { kind: 'spec' | 'review' | 'release' | 'unknown'; detail: string }

/** A CARD gate; supported kinds use `kind: detail`, while unknown text stays intact. */
export function parseGate(value?: string): Gate | null {
  const raw = (value ?? '').trim()
  if (!raw || /^(?:無|none)$/i.test(raw)) return null
  const match = raw.match(/^(spec|review|release)\s*[：:]\s*(.*)$/i)
  if (!match) return { kind: 'unknown', detail: raw }
  return { kind: match[1].toLowerCase() as Gate['kind'], detail: match[2].trim() }
}

/**
 * The CARD's 更新 field in ms, or null. Executors write it by hand: `2030-01-05 12:00`, but also
 * `2030/1/5 9:05`, with seconds, or as an instant with a zone (`2030-01-05T04:00:00Z`, `+08:00`).
 * A zone is honoured; without one it is local time.
 */
export function cardTime(updated: string): number | null {
  const m = updated.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+|\s*T\s*)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/i)
  if (!m) return null
  const [y, mo, d, h, mi, sec] = [+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)]
  const zone = m[7]
  if (!zone) return new Date(y, mo, d, h, mi, sec).getTime()
  const offset = /^z$/i.test(zone) ? 0 : (zone[0] === '-' ? -1 : 1) * (+zone.slice(1, 3) * 60 + +zone.slice(-2))
  return Date.UTC(y, mo, d, h, mi, sec) - offset * 60_000
}

/** The job a CARD names in its 更新 field (`· job <id>`, as the STATUS template asks), or ''. */
export function cardJob(updated: string): string {
  return updated.match(/\bjob\s+[`"]?([\w:.-]{4,})/i)?.[1] ?? ''
}

/** Project root that owns a STATUS path (`.console/STATUS.md` → repo root). */
export function projectRoot(statusPath: string): string {
  const dir = statusPath.replace(/\/[^/]*$/, '')
  return dir.endsWith('/.console') ? dir.slice(0, -'/.console'.length) : dir
}

/** Running jobs, and finished jobs newer than the CARD (results the CARD doesn't reflect). */
export function isActiveJob(job: Job): boolean {
  if (['completed', 'failed', 'cancelled'].includes(job.status ?? '')) return false
  return ['running', 'queued', 'starting', 'unknown'].includes(job.status ?? '') || ['starting', 'unknown'].includes(job.phase ?? '')
}

/**
 * The CARD was written after a job started, so the job (which ends by updating the CARD) already
 * wrote its result back. 更新 has minute precision and the job finishes after writing it, so its
 * completion time is no test: compare with the minute the job started in.
 */
export function cardWrittenSince(cardMs: number | null, startedAt: string | undefined): boolean {
  const start = Date.parse(startedAt ?? '')
  return cardMs !== null && !Number.isNaN(start) && cardMs >= Math.floor(start / 60_000) * 60_000
}

/** The CARD names this job as the one that wrote it (the id, its native id, or a launch id ending in it). */
function namedByCard(job: Job, named: string): boolean {
  if (!named) return false
  const ids = [job.id, job.nativeId ?? ''].filter(Boolean)
  return ids.some(id => id === named || (named.length >= 6 && (id.endsWith(`:${named}`) || id.startsWith(`${named}:`))))
}

/**
 * `cardMs`: when the CARD was last written, the later of its 更新 and the STATUS file's modification time;
 * `named`: the job its 更新 names. Either way a finished job the CARD was written after (or by) is synced.
 */
export function jobFlags(jobs: Job[], cardMs: number | null, named = ''): JobFlag[] {
  const flags: JobFlag[] = []
  for (const j of jobs) {
    const summary = (j.summary ?? '').slice(0, 60)
    if (isActiveJob(j)) {
      flags.push({ kind: 'running', id: j.id, executor: j.executor, status: j.status ?? 'unknown', summary, startedAt: j.startedAt ?? j.createdAt, phase: j.phase, logFile: j.logFile })
      continue
    }
    if (j.jobClass !== 'task') continue
    // A finished sync's output is the CARD itself: whether or not it changed it, the sync is not new work.
    if (j.kind === 'sync' && j.status === 'completed') continue
    if (j.status === 'completed' && (cardWrittenSince(cardMs, j.startedAt ?? j.createdAt) || namedByCard(j, named))) continue
    const t = Date.parse(j.completedAt ?? j.createdAt ?? '')
    // A Claude job whose turn ended on a question to the user (the agent went idle while blocked).
    const asks = j.status === 'completed' && (j.phase ?? '').startsWith('idle: 等你回覆')
    if (cardMs === null || (!Number.isNaN(t) && t > cardMs)) flags.push({ kind: 'newer', id: j.id, executor: j.executor, status: j.status ?? '?', summary, ...(j.kind ? { task: j.kind } : {}), ...(asks ? { asks: true, ...(j.sessionId ? { sessionId: j.sessionId } : {}) } : {}) })
  }
  return flags
}

/** The verdict part of a 驗證 line: after `→`/`->`, else after the backticked command, else none. */
export function verifyNote(line: string): string {
  const quoted = /^`[^`]+`/.test(line)
  const rest = line.replace(/^`[^`]+`/, '')
  const arrow = rest.match(/(?:→|->)\s*(.*)$/)
  if (arrow) return (arrow[1] ?? '').trim()
  return quoted ? rest.trim() : ''
}

/**
 * `statusMtime`: when STATUS.md was last written, by the clock that also stamps the jobs. The 更新 text is
 * written by an executor that may guess the time, write UTC or keep an old value, so the file's own
 * time decides whether a job's result reached the CARD whenever it is later.
 */
export function buildProject(row: RegistryRow, cardText: string | null, jobs: Job[], now: number, statusMtime?: number): Project {
  const card = cardText === null ? null : parseCard(cardText)
  const updated = card?.['更新'] ?? ''
  const ms = cardTime(updated)
  const mtime = card !== null && typeof statusMtime === 'number' && Number.isFinite(statusMtime) && statusMtime > 0 ? statusMtime : null
  const written = ms === null ? mtime : mtime === null ? ms : Math.max(ms, mtime)
  return {
    name: row.name,
    statusPath: row.statusPath,
    hasCard: card !== null,
    state: card?.['狀態'] ?? '',
    ask: card?.['等使用者'] ?? '',
    next: card?.['下一步'] ?? '',
    gate: card?.['關卡'] ?? '',
    verify: (card?.['驗證'] ?? '').replace(/^`([^`]+)`.*$/, '$1'),
    verifyNote: verifyNote(card?.['驗證'] ?? ''),
    updated,
    isStale: ms !== null && now - ms > STALE_DAYS * 86400000,
    jobs: jobFlags(jobs, written, cardJob(updated)),
    ...(mtime !== null ? { statusMtime: mtime } : {}),
    tasks: jobTasks(jobs),
  }
}

/** A CARD value that says "nothing": a none word alone or before punctuation or a note (「無；…」, 「無（等使用者決定）」). */
export const saysNone = (value: string) => /^(?:無|沒有|none|n\/a|-)(?:$|[；;，,。\s(（])/i.test(value.trim())

/** An ask counts unless it is empty or starts with a "none" word (e.g. 「無；示範結果等待整理」). */
export const hasAsk = (p: Project) =>
  p.hasCard && !NONE.has(p.ask) && !saysNone(p.ask)

export type Severity = 'ask' | 'running' | 'stale' | 'ok' | 'missing'

/** The single badge a project card shows, most urgent first. */
export function severity(p: Project): Severity {
  if (!p.hasCard) return 'missing'
  if (hasAsk(p)) return 'ask'
  if (p.jobs.some(j => j.kind === 'running')) return 'running'
  if (p.isStale || p.jobs.some(j => j.kind === 'newer')) return 'stale'
  return 'ok'
}

export type Tile = { label: string; value: string; tone: 'warn' | 'info' | 'bad' | 'quiet' }

/** The summary tiles across the top of the pane. */
export function tiles(s: Snapshot): Tile[] {
  const asks = s.projects.filter(hasAsk).length
  const stale = s.projects.filter(p => severity(p) === 'stale').length
  const running = s.projects.reduce((n, p) => n + p.jobs.filter(j => j.kind === 'running').length, 0)
  const ctx = s.contextPercent
  return [
    { label: '等你決定', value: String(asks), tone: asks ? 'warn' : 'quiet' },
    { label: 'CARD 待更新', value: String(stale), tone: stale ? 'info' : 'quiet' },
    { label: '執行者執行中', value: String(running), tone: running ? 'info' : 'quiet' },
    { label: 'session 等你', value: String(s.blocked.length), tone: s.blocked.length ? 'warn' : 'quiet' },
    { label: '主控台 context', value: ctx === null ? '—' : `${ctx}%`, tone: ctx !== null && ctx >= ROTATE_PERCENT ? 'bad' : 'quiet' },
  ]
}

/**
 * Keep the preflight line only when a stale broker belongs to a registered project's workspace
 * (`STALE codex=V brokers=PID(ws) PID(ws2) ...`); other workspaces' brokers are not ours to report.
 */
export function relevantCodex(line: string, projectBases: string[]): string {
  if (!line.startsWith('STALE')) return line
  const mine = [...line.matchAll(/(\d+)\(([^)]*)\)/g)].filter(m => projectBases.includes(m[2])).map(m => `${m[1]}(${m[2]})`)
  if (mine.length === 0) return line.replace(/^STALE/, 'OK*').replace(/ brokers=.*$/, '（其他 workspace 有舊 broker，與本主控台無關）')
  return `STALE 需處理的 broker：${mine.join(' ')}  ->  ! for p in ${mine.map(s => s.split('(')[0]).join(' ')}; do taskkill //PID $p //T //F; done`
}

/** Only an explicit successful probe is healthy; unavailable data stays unknown. */
export function codexHealth(line: string): 'ok' | 'stale' | 'unknown' {
  if (line.startsWith('STALE')) return 'stale'
  return /^OK(?:\*|\s|$)/.test(line) && !/\b(?:UNKNOWN|MISSING)\b/i.test(line) ? 'ok' : 'unknown'
}

/** Sessions waiting on a person: blocked on a permission prompt, or waiting for input. */
export function blockedSessions(agents: Agent[], selfName?: string): Blocked[] {
  return agents
    .filter(a => {
      const name = a.name?.trim() ?? ''
      const hasIdentity = Boolean(name || a.sessionId?.trim() || a.cwd?.trim() || a.waitingFor?.trim())
      return hasIdentity && name !== selfName && (a.state === 'blocked' || a.status === 'waiting')
    })
    .map(a => ({
      name: a.name?.trim() || '(未命名 session)',
      why: a.state === 'blocked' ? '等批准' : (a.waitingFor?.trim() || '等輸入'),
    }))
}

export function bandText(s: Snapshot): string {
  const asks = s.projects.filter(hasAsk).length
  const gates = s.projects.filter(p => parseGate(p.gate) !== null).length
  const stale = s.projects.filter(p => p.isStale || p.jobs.some(j => j.kind === 'newer')).length
  const running = s.projects.reduce((n, p) => n + p.jobs.filter(j => j.kind === 'running').length, 0)
  const parts = [`${s.projects.length} 專案`, `等你 ${asks}`]
  if (gates) parts.push(`待審核 ${gates}`)
  if (stale) parts.push(`CARD 待更新 ${stale}`)
  if (running) parts.push(`執行者執行中 ${running}`)
  if (s.blocked.length) parts.push(`session 等你 ${s.blocked.length}`)
  if (s.codex.startsWith('STALE')) parts.push('Codex broker 過期')
  if (s.contextPercent !== null) parts.push(`context ${s.contextPercent}%${s.contextPercent >= ROTATE_PERCENT ? '（建議換主控台）' : ''}`)
  if (s.error) parts.push(`讀取錯誤：${s.error}`)
  return `主控台｜${parts.join('｜')}`
}

/** Sessions already waiting in `prev`: all of them, not only the one per project it listed (snapshots before 0.9.5 have only those). */
const waitingBefore = (prev: Snapshot) => new Set(prev.waiting ?? prev.blocked.map(b => b.name))

/** Toasts for changes since `prev`; the first snapshot (prev null) is only the baseline. */
export function diffToasts(prev: Snapshot | null, cur: Snapshot): string[] {
  if (prev === null) return []
  const out: string[] = []
  const prevAsk = new Map(prev.projects.map(p => [p.name, hasAsk(p) ? p.ask : '']))
  for (const p of cur.projects) {
    if (hasAsk(p) && prevAsk.get(p.name) !== p.ask) out.push(`${p.name} 等你：${p.ask.slice(0, 60)}`)
  }
  const prevGate = new Map(prev.projects.map(p => [p.name, parseGate(p.gate) ? (p.gate ?? '').trim() : '']))
  for (const p of cur.projects) {
    const gate = parseGate(p.gate)
    if (gate && prevGate.get(p.name) !== (p.gate ?? '').trim()) out.push(`${p.name} 待審核：${p.gate?.slice(0, 60)}`)
  }
  const prevNewer = new Set(prev.projects.flatMap(p => p.jobs.filter(j => j.kind === 'newer').map(j => j.id)))
  for (const p of cur.projects) {
    for (const j of p.jobs) if (j.kind === 'newer' && !prevNewer.has(j.id)) {
      const result = jobResult(j.status)
      out.push(`${p.name}：執行者 ${result.label}（${j.id}）${result.followup ? `，${result.followup}` : ''}`)
    }
  }
  for (const p of cur.projects) {
    for (const t of prTransitions(p.name, prev.projects.find(x => x.name === p.name)?.pr, p.pr)) if (t.toast) out.push(t.text.replace('　', '：'))
  }
  const prevWaiting = waitingBefore(prev)
  for (const b of cur.blocked) if (!prevWaiting.has(b.name)) out.push(`session「${b.name}」${b.why}`)
  if (cur.codex.startsWith('STALE') && !prev.codex.startsWith('STALE')) out.push('Codex app 已更新，broker 過期：派工前請先處理')
  if (
    cur.contextPercent !== null && cur.contextPercent >= ROTATE_PERCENT &&
    (prev.contextPercent === null || prev.contextPercent < ROTATE_PERCENT)
  ) out.push(`主控台 context 已達 ${cur.contextPercent}%，建議換新的主控台`)
  return out
}

/** Example data for `/console demo` and the UI tests; clearly not the person's real projects. */
export function demoSnapshot(now: number): Snapshot & { demo: true } {
  const localMinute = (time: number) => {
    const d = new Date(time)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const card = (ask: string, state: string, age: number, gate = '') =>
    `<!-- CARD -->\n- 更新：${localMinute(now - age)}（示範）\n- 狀態：${state}\n- 驗證：\`php tests/run.php\` → PASS\n- 等使用者：${ask}\n${gate ? `- 關卡：${gate}\n` : ''}- 下一步：示範資料，/console refresh 換回實際狀態\n<!-- /CARD -->`
  return {
    demo: true,
    at: now,
    projects: [
      { ...buildProject({ name: 'Project-Alpha', statusPath: 'demo/a' }, card('選擇示範介面配色：A) 深色主題 B) 淺色主題；示範資料是否保留：1) 保留 2) 清除', '示範測試通過；等待配色選擇', 12 * 60_000), [], now),
        git: { branch: 'demo/theme', upstream: 'origin/demo/theme', ahead: 1, behind: 0, changed: 3, untracked: 1, conflicts: 0 } },
      { ...buildProject({ name: 'Project-Beta', statusPath: 'demo/b' }, card('無；示範結果等待整理', '示範文件已整理', 3 * 3_600_000),
        [{ id: 'task-demo-new', jobClass: 'task', status: 'completed', completedAt: new Date(now - 60_000).toISOString() }], now),
        git: { branch: 'demo/docs', upstream: 'origin/demo/docs', ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0 },
        pr: { number: 42, title: '示範：整理文件', state: 'OPEN', draft: false, url: '', checks: { pass: 3, fail: 1, pending: 0, failing: ['demo-lint'] } } },
      buildProject({ name: 'Project-Gamma', statusPath: 'demo/gamma' }, card('無', '示範證據已備妥', 86_400_000, 'review: 確認示範審核結果'), [], now),
      buildProject({ name: 'Sample-Docs', statusPath: 'demo/c' }, card('無', '示範工作執行中', 4 * 86_400_000),
        [
          { id: 'task-demo-run', jobClass: 'task', status: 'running', executor: 'codex', startedAt: new Date(now - 8 * 60_000).toISOString(), request: { prompt: '示範任務：檢查合成 API 文件', model: 'codex-demo-running', effort: 'medium' } },
          { id: 'task-demo-done', jobClass: 'task', status: 'completed', executor: 'codex', completedAt: new Date(now - 60 * 60_000).toISOString(), request: { prompt: '示範任務：整理合成測試結果', model: 'codex-demo-completed', effort: 'high' } },
        ], now),
      { ...buildProject({ name: 'Sample-API', statusPath: 'demo/api' }, card('無', '示範 API 穩定', 2 * 86_400_000), [], now),
        git: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0 } },
    ],
    blocked: [{ name: '示範 session', why: '等批准' }],
    executor: 'claude', codex: 'OK demo', contextPercent: 62, error: null,
    limits: [
      { kind: 'five_hour', percent: 31, resetsAt: new Date(now + 4 * 3_600_000).toISOString() },
      { kind: 'seven_day', percent: 75, resetsAt: new Date(now + 2 * 86_400_000).toISOString() },
      { kind: 'seven_day_fable', percent: 48, resetsAt: new Date(now + 2 * 86_400_000).toISOString() },
    ],
    codexQuota: {
      at: new Date(now).toISOString(),
      limits: [{ label: 'Codex 週', percent: 12, resetsAt: new Date(now + 5 * 86_400_000).toISOString() }],
      credits: '1,000',
    },
  }
}

/** Two recent, synthetic feed entries shown when demo mode opens. */
export function demoEvents(now: number): Event[] {
  return [
    { at: now - 45_000, text: '示範：Codex 任務正在執行', tone: 'teal' },
    { at: now - 2 * 60_000, text: '示範：審核關卡已建立', tone: 'amber' },
  ]
}

export type DecisionOption = { key: string; text: string }
export type Decision = { title: string; options: DecisionOption[] }

const OPEN = '（(「【['
const CLOSE = '）)」】]'
// An option marker: `A)` `(A)` `A.` `A、` `A：` `1)` `(1)` `①`, at the start or after a space/punctuation.
const OPTION_MARK = /(^|[\s，,。:：、])(?:[(（]([A-H]|[1-9])[)）]|([A-H]|[1-9])[)）]|([A-H])[.．、:：](?=\s*\S)|([①-⑨]))\s*/g

const FIRST_KEYS = ['A', '1', '①']
const optionKey = (m: RegExpMatchArray) => (m[2] ?? m[3] ?? m[4] ?? m[5])!
const nextKey = (key: string) => String.fromCodePoint(key.codePointAt(0)! + 1)

/** Split on `；` `;` and newlines that are not inside brackets (commands in parentheses stay whole). */
function splitDecisions(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of text) {
    if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === '；' || ch === ';' || ch === '\n')) {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/**
 * A CARD ask as separate decisions, each with its lettered or numbered options when it lists
 * at least two (`選配色：A) 深色 B) 淺色；是否上線`). Text without markers stays one decision.
 */
export function parseAsk(ask: string): Decision[] {
  return splitDecisions(ask.replace(/\\n/g, '\n')).map(part => {
    // Keep the last run that counts up from A / 1 / ①, so a stray `Plan A.` is not an option.
    let marks: RegExpMatchArray[] = []
    for (const m of part.matchAll(OPTION_MARK)) {
      const k = optionKey(m)
      if (FIRST_KEYS.includes(k)) marks = [m]
      else if (marks.length && k === nextKey(optionKey(marks[marks.length - 1]))) marks.push(m)
    }
    if (marks.length < 2) return { title: part, options: [] }
    const start = (m: RegExpMatchArray) => (m.index ?? 0) + m[1].length
    const options = marks.map((m, i) => ({
      key: optionKey(m),
      text: part.slice((m.index ?? 0) + m[0].length, i + 1 < marks.length ? start(marks[i + 1]) : part.length).trim().replace(/[，,、]$/, ''),
    }))
    return { title: part.slice(0, start(marks[0])).trim().replace(/[：:，,]$/, ''), options }
  })
}

/** A long CARD value (下一步, 狀態) as its `；`-separated clauses, brackets kept whole. */
export function splitClauses(text: string): string[] {
  return splitDecisions(text.replace(/\\n/g, '\n'))
}

/**
 * The reply the console expects for picked options: `1A 2B`, a numeric key set apart (`2-1`),
 * and a decision without options left as `3：` for the person to finish.
 */
export function decisionAnswer(decisions: Decision[], picks: Record<string, string>): string {
  return decisions.map((d, i) => {
    const key = picks[String(i)]
    if (!d.options.length || !key) return `${i + 1}：`
    return /^[A-Z]$/.test(key) ? `${i + 1}${key}` : `${i + 1}-${key}`
  }).join(' ')
}

/** One line for narrow places: every decision title, options folded away. */
export function askSummary(ask: string): string {
  const decisions = parseAsk(ask)
  const titles = decisions.map(d => d.title || d.options.map(o => o.text).join(' / ')).join('｜')
  return decisions.length > 1 ? `${decisions.length} 項決策：${titles}` : titles
}

/** First clause of a CARD ask, short enough for one line (ADHD-style: action, not context). */
export function shortAsk(ask: string, max = 34): string {
  const first = ask.split(/[；;。]|（|\(/)[0].trim()
  return first.length > max ? first.slice(0, max - 1) + '…' : first
}

export type Item = { text: string; tone: 'warn' | 'bad' | 'info' | 'win' }

/** What the person should do now, most urgent first; each one line. */
export function todo(s: Snapshot): Item[] {
  const items: Item[] = []
  if (s.error) items.push({ text: `修正：${s.error}`, tone: 'bad' })
  if (s.codex.startsWith('STALE')) items.push({ text: '處理過期的 Codex broker（面板有指令）', tone: 'bad' })
  for (const b of s.blocked) items.push({ text: `回應 session「${b.name}」（${b.why}）`, tone: 'warn' })
  for (const p of s.projects) if (hasAsk(p)) items.push({ text: `${p.name.replace(/\s.*$/, '')}：${shortAsk(p.ask)}`, tone: 'warn' })
  for (const p of s.projects) if (!hasAsk(p) && parseGate(p.gate)) items.push({ text: `${p.name.replace(/\s.*$/, '')}：審核 ${shortAsk(p.gate ?? '')}`, tone: 'warn' })
  if (s.contextPercent !== null && s.contextPercent >= ROTATE_PERCENT) items.push({ text: `換新主控台（context ${s.contextPercent}%）`, tone: 'info' })
  return items
}

/** Executor work in flight, and results that landed since the CARD (visible wins). */
export function running(s: Snapshot): string[] {
  return s.projects.flatMap(p => p.jobs.filter(j => j.kind === 'running').map(() => `${p.name.replace(/\s.*$/, '')}：執行者執行中`))
}
export function wins(s: Snapshot): string[] {
  return s.projects.flatMap(p => p.jobs.filter(j => j.kind === 'newer').map(j => `${p.name.replace(/\s.*$/, '')}：執行者 ${j.status === 'completed' ? '完成' : j.status}，待寫入 CARD`))
}

/** The one-line band: lead with the next action. */
export function focusLine(s: Snapshot): string {
  const items = todo(s)
  const run = running(s).length
  const tail = [items.length > 1 ? `另有 ${items.length - 1} 件` : '', run ? `執行中 ${run}` : '', wins(s).length ? `✓ ${wins(s).length} 件新結果` : '']
    .filter(Boolean).join('｜')
  const head = items.length ? `▶ 下一步：${items[0].text}` : '✓ 沒有要你處理的事'
  return tail ? `${head}｜${tail}` : head
}

export type Card = { id: string; title: string; text: string; meta: string }
export type Column = { key: 'ask' | 'run' | 'done' | 'idle'; label: string; cards: Card[] }

const short = (name: string) => name.replace(/\s.*$/, '')

/** The four board columns of the design: 等你 / 進行中 / 剛完成 / 待命. */
export function board(s: Snapshot): Column[] {
  const ask: Card[] = []
  if (s.error) ask.push({ id: 'err', title: '主控台', text: s.error, meta: '讀取錯誤' })
  if (s.codex.startsWith('STALE')) ask.push({ id: 'codex', title: 'Codex', text: '處理過期的 broker', meta: '派工前' })
  for (const b of s.blocked) ask.push({ id: 'b-' + b.name, title: b.name, text: b.why, meta: 'session' })
  for (const p of s.projects) if (hasAsk(p)) ask.push({ id: 'a-' + p.name, title: short(p.name), text: shortAsk(p.ask, 40), meta: hhmm(p.updated) })
  const run: Card[] = s.projects.flatMap(p =>
    p.jobs.filter(j => j.kind === 'running').map(j => ({ id: 'r-' + j.id, title: short(p.name), text: '執行者執行中', meta: j.id.slice(5, 13) })))
  const done: Card[] = s.projects.flatMap(p =>
    p.jobs.filter(j => j.kind === 'newer').map(j => ({ id: 'd-' + j.id, title: short(p.name), text: shortAsk(j.summary || `執行者 ${j.status}`, 40), meta: '待寫入 CARD' })))
  const busy = new Set([...ask, ...run, ...done].map(c => c.title))
  const idle: Card[] = s.projects
    .filter(p => !busy.has(short(p.name)))
    .map(p => ({ id: 'i-' + p.name, title: short(p.name), text: shortAsk(p.state || '—', 40), meta: hhmm(p.updated) }))
  return [
    { key: 'ask', label: '等你', cards: ask },
    { key: 'run', label: '進行中', cards: run },
    { key: 'done', label: '剛完成', cards: done },
    { key: 'idle', label: '待命', cards: idle },
  ]
}

/** `2030-01-05 09:40（job…）` → `09:40`; other dates → `MM/DD`. */
export function hhmm(updated: string): string {
  const m = updated.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/)
  if (!m) return ''
  const today = new Date()
  const isToday = +m[1] === today.getFullYear() && +m[2] === today.getMonth() + 1 && +m[3] === today.getDate()
  return isToday ? m[4] : `${m[2]}/${m[3]}`
}

export type State = 'ACTION' | 'GATE' | 'RUNNING' | 'SYNC' | 'IDLE' | 'NOCARD'
export type Row = { state: State; project: string; item: string; age: string; full: string }
export const STATE_ORDER: State[] = ['ACTION', 'GATE', 'RUNNING', 'SYNC', 'IDLE', 'NOCARD']

/** `now - t` as now / 12m / 3h / 4d / >99d; a future timestamp has no age. */
export function ago(t: number | null, now: number): string {
  if (t === null || !Number.isFinite(t) || !Number.isFinite(now)) return '—'
  if (t > now) return '—'
  const m = Math.floor((now - t) / 60000)
  if (m === 0) return 'now'
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  const days = Math.floor(m / 1440)
  return days > 99 ? '>99d' : `${days}d`
}

/** Terminal display width: CJK and other wide glyphs occupy two columns. */
export function displayWidth(value: string): number {
  let width = 0
  for (const char of value) {
    const cp = char.codePointAt(0) ?? 0
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) ||
        (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) ||
        (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) ||
        (cp >= 0xfe20 && cp <= 0xfe2f)) continue
    const wide = cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
    )
    width += wide ? 2 : 1
  }
  return width
}

/** Width of the project column, fitted to content while leaving room for the item column. */
export function projectColumnWidth(names: string[]): number {
  const widest = names.reduce((max, name) => Math.max(max, displayWidth(name)), 0)
  return Math.max(8, Math.min(18, widest))
}

/** One row per project, its most urgent state first; neutral, system-style wording. */
export function rows(s: Snapshot): Row[] {
  const out = s.projects.map((p): Row => {
    const name = p.name
    const age = ago(cardTime(p.updated), s.at)
    const full = p.name
    if (!p.hasCard) return { state: 'NOCARD', project: name, item: 'STATUS 卡不存在', age: '—', full }
    if (hasAsk(p)) return { state: 'ACTION', project: name, item: shortAsk(p.ask, 30), age, full }
    if (parseGate(p.gate)) return { state: 'GATE', project: name, item: shortAsk(p.gate ?? '', 30), age, full }
    const running = p.jobs.filter(j => j.kind === 'running')
    if (running.length) return { state: 'RUNNING', project: name, item: (running.length > 1 ? `${running.length} 個任務・` : '') + runLine(running[0], s.at), age, full }
    // A manual project has no sync button, so the way on is only taking over the session.
    if (p.jobs.some(j => j.kind === 'newer' && j.asks)) return { state: 'ACTION', project: name, item: `執行者在等你回覆：接手該 session${p.executor === 'manual' ? '' : ' 或同步'}`, age, full }
    if (p.jobs.some(j => j.kind === 'newer')) return { state: 'SYNC', project: name, item: '結果未同步至 STATUS', age, full }
    return { state: 'IDLE', project: name, item: shortAsk(p.state || '—', 30), age, full }
  })
  return out.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state))
}

export function counts(s: Snapshot): Record<State, number> {
  const c: Record<State, number> = { ACTION: 0, GATE: 0, RUNNING: 0, SYNC: 0, IDLE: 0, NOCARD: 0 }
  for (const r of rows(s)) c[r.state]++
  return c
}

/** NEXT: the single most important action (system blockers before project actions). */
export function next(s: Snapshot): string | null {
  if (s.error) return `主控台：${s.error}`
  if (s.codex.startsWith('STALE')) return 'Codex：處理過期的 broker'
  const all = rows(s)
  const r = all.find(x => x.state === 'ACTION' || x.state === 'GATE')
  if (r) return `${r.project}・${r.item}`
  const sync = all.find(x => x.state === 'SYNC')
  if (sync) return `${sync.project}・同步執行者結果至 STATUS`
  return null
}

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Lines of the waiting-sessions list in the pane; the rest is summed up as `…另 N 條`. */
export const BLOCKED_MAX = 3

/**
 * A background session the daemon retired stays in `claude agents` with its last state, but with
 * neither `pid` nor `status`. Nobody can answer it, so it is not a session waiting on a person.
 */
const retiredAgent = (a: Agent) => a.kind === 'background' && (a.pid === undefined || a.pid === null) && !a.status?.trim()

/** What the session is actually waiting for: a permission prompt, a question it stopped on, or other input. */
const BLOCKED_RANK = ['等待批准', '停在提問', '等待輸入']
function blockedWhy(a: Agent): string {
  if (a.status === 'waiting') return '等待批准'
  if (a.status === 'idle' && a.state === 'blocked') return '停在提問'
  return '等待輸入'
}

const startedMs = (a: Agent) => typeof a.startedAt === 'number' ? a.startedAt : Date.parse(a.startedAt ?? '') || 0

/** Every session of this console or a registered project, not this one and not retired, that waits on a person, with its project. */
function waitingAgents(agents: Agent[], selfId: string | null, roots: (string | { root: string; name: string })[], home: string): { agent: Agent; project: { key: string; name: string } }[] {
  const allowed = roots.map(r => typeof r === 'string' ? { root: normPath(r), name: '' } : { root: normPath(r.root), name: r.name })
  const consoleDir = normPath(home)
  const projectOf = (a: Agent): { key: string; name: string } | null => {
    const cwd = normPath(a.cwd ?? '')
    const hit = allowed.filter(r => cwd === r.root || cwd.startsWith(r.root + '/')).sort((x, y) => y.root.length - x.root.length)[0]
    if (hit) return { key: hit.root, name: hit.name }
    return cwd === consoleDir ? { key: consoleDir, name: '主控台' } : null
  }
  // The same sessions blockedSessions lists: with some identity, blocked or waiting.
  return agents.flatMap(a => {
    const project = projectOf(a)
    const listed = project && !(a.sessionId && a.sessionId === selfId) && !retiredAgent(a)
      && Boolean(a.name?.trim() || a.sessionId?.trim() || a.cwd?.trim() || a.waitingFor?.trim())
      && (a.state === 'blocked' || a.status === 'waiting')
    return listed ? [{ agent: a, project }] : []
  })
}

/**
 * The names of every waiting session before the list is cut to one per project. The toasts and the feed
 * compare these, so an older session of a project that shows up once the newer one is answered is not new.
 */
export function waitingNames(agents: Agent[], selfId: string | null, roots: (string | { root: string; name: string })[], home: string): string[] {
  return waitingAgents(agents, selfId, roots, home).map(({ agent }) => agent.name?.trim() || '(未命名 session)')
}

/**
 * Sessions that belong to this console (its folder or a registered project), not this one, waiting on a person:
 * retired ones left out, the newest per project only, newest first, each named with its project.
 * `roots` may be bare paths (no project name) or `{ root, name }`.
 */
export function relevantBlocked(agents: Agent[], selfId: string | null, roots: (string | { root: string; name: string })[], home: string): Blocked[] {
  const listed = waitingAgents(agents, selfId, roots, home)
  // Per project the most pressing wording wins (a permission prompt must not hide behind a newer question); then the newest.
  const rank = (a: Agent) => BLOCKED_RANK.indexOf(blockedWhy(a))
  const newest = new Map<string, { agent: Agent; name: string }>()
  for (const { agent: a, project } of listed) {
    const seen = newest.get(project.key)
    const better = !seen || rank(a) < rank(seen.agent) || (rank(a) === rank(seen.agent) && startedMs(a) > startedMs(seen.agent))
    if (better) newest.set(project.key, { agent: a, name: project.name })
  }
  return [...newest.values()]
    .sort((x, y) => startedMs(y.agent) - startedMs(x.agent))
    .map(({ agent, name }) => ({ name: agent.name?.trim() || '(未命名 session)', why: blockedWhy(agent), ...(name ? { project: name } : {}) }))
}

/** The pane's lines for waiting sessions: `name（project）：why`, at most `max`, then `…另 N 條`. */
export function blockedLines(blocked: Blocked[], max = BLOCKED_MAX): string[] {
  const lines = blocked.slice(0, max).map(b => `${b.name}${b.project ? `（${b.project}）` : ''}：${b.why}`)
  return blocked.length > max ? [...lines, `…另 ${blocked.length - max} 條`] : lines
}

/**
 * What rides along with the person's next prompt while a project is selected in the panel:
 * enough for the console to know which project "this" means, without reading anything else.
 */
export function selectionContext(snap: Snapshot | null, full: string | null): string | null {
  if (!snap || !full) return null
  const p = snap.projects.find(x => x.name === full)
  if (!p) return null
  const lines = [
    `【主控台面板選取】使用者在 console-status 面板選了專案「${p.name}」。這則提示若沒有另外指明專案，指的就是它。`,
    `STATUS：${p.statusPath}`,
  ]
  if (p.state) lines.push(`狀態：${p.state}`)
  if (hasAsk(p)) lines.push(`需決策：${p.ask}`)
  if (parseGate(p.gate)) lines.push(`關卡：${p.gate}`)
  if (p.next) lines.push(`下一步：${p.next}`)
  for (const j of p.jobs) lines.push(j.kind === 'running' ? `執行者執行中：${j.id}` : `執行者結果未同步至 STATUS：${j.id}（${j.status}）`)
  if (p.git) lines.push(`Git：${gitLine(p.git)}`)
  if (p.git?.commits?.[0]) lines.push(`最新提交：${commitLine(p.git.commits[0], snap.at)}`)
  if (p.pr) lines.push(`PR：${prLine(p.pr)}${p.pr.url ? ` ${p.pr.url}` : ''}`)
  return lines.join('\n')
}

export type Limit = { kind: string; percent: number }
export type Event = { at: number; text: string; tone: 'amber' | 'teal' | 'blue' | 'red' | 'green' }

function jobResult(status: string): { label: string; followup: string; event: string; tone: 'blue' | 'red' } {
  if (status === 'completed') return { label: '完成', followup: 'CARD 待更新', event: '完成，待同步', tone: 'blue' }
  if (status === 'failed') return { label: '失敗', followup: '請檢查任務', event: '失敗，請檢查', tone: 'red' }
  if (status === 'cancelled') return { label: '已取消', followup: '', event: '已取消', tone: 'red' }
  return { label: status || '狀態未知', followup: '請檢查任務', event: status || '狀態未知', tone: 'red' }
}

/** `█████░░░` for a 0–100 value in `width` cells. */
export function meter(percent: number, width = 8): string {
  const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(full) + '░'.repeat(width - full)
}

/** A window kind split into its window and the model it is scoped to (`seven_day_fable` → seven_day, fable); null when the kind is not a window. */
export function parseLimitKind(kind: string): { window: 'five_hour' | 'seven_day'; model: string } | null {
  const m = /^(five_hour|5_hour|5h|seven_day|7_day|7d|weekly|week)(?:[_-]([a-z0-9]+))?$/i.exec(kind.trim())
  if (!m) return null
  return { window: /^(five_hour|5_hour|5h)$/i.test(m[1]) ? 'five_hour' : 'seven_day', model: m[2] ?? '' }
}

/** Spellings of the model names the host scopes windows to; any other name is shown as sent. */
const MODEL_NAMES: Record<string, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }

/** The model a per-model window kind names (`seven_day_fable` → `Fable`), or '' for a window shared by every model. */
export function limitModel(kind: string): string {
  const model = parseLimitKind(kind)?.model ?? ''
  return model ? MODEL_NAMES[model.toLowerCase()] ?? model : ''
}

/** Readable name of a rate-limit window kind: `five_hour` → `5 小時`, `seven_day` → `本週`, `seven_day_fable` → `Fable 週`, `spend_limit` → `花費上限`; a kind it does not know keeps its name. */
export function limitName(kind: string): string {
  const parsed = parseLimitKind(kind)
  if (!parsed) return kind === 'spend_limit' ? '花費上限' : kind
  const model = limitModel(kind)
  const window = parsed.window === 'five_hour' ? '5 小時' : model ? '週' : '本週'
  return model ? `${model} ${window}` : window
}

/** Hover help for a usage row, naming the model when the window is scoped to one. */
export function limitHelp(kind: string): string {
  const base = limitHelpBase(kind)
  return parseLimitKind(kind) ? `${base}照這個視窗開始以來的平均速度會撐不到重置時，後面會標出約多久後用完。` : base
}

function limitHelpBase(kind: string): string {
  const parsed = parseLimitKind(kind)
  const model = limitModel(kind)
  const name = limitName(kind)
  if (parsed && model) {
    return parsed.window === 'five_hour'
      ? `${name}：Claude 帳號 5 小時滾動額度中 ${model} 專用的剩餘量，與整體「5 小時」分開計算，到重置時間回滿。`
      : `${name}：Claude 帳號本週 ${model} 專用額度的剩餘量，與整體「本週」分開計算，到重置時間回滿。`
  }
  if (parsed?.window === 'five_hour') return '5 小時：Claude 帳號 5 小時滾動額度的剩餘量，到重置時間回滿。'
  if (parsed) return '本週：Claude 帳號每週額度的剩餘量。'
  if (kind === 'spend_limit') return '花費上限：Claude gateway 為這個帳號設定的花費上限還剩多少，超額後電池見底，到週期重置時回滿。'
  return `${kind}：host 回報的額度視窗，名稱照原字串顯示。`
}

/** The activity feed: what changed between two snapshots, newest first, as short system lines. */
export function events(prev: Snapshot | null, cur: Snapshot): Event[] {
  if (prev === null) return []
  const out: Event[] = []
  const short = (n: string) => n.replace(/\s.*$/, '')
  const prevAsk = new Map(prev.projects.map(p => [p.name, hasAsk(p) ? p.ask : '']))
  const prevGate = new Map(prev.projects.map(p => [p.name, parseGate(p.gate) ? (p.gate ?? '').trim() : '']))
  const prevJobs = new Map(prev.projects.flatMap(p => p.jobs.map(j => [j.id, j.kind] as const)))
  const prevUpd = new Map(prev.projects.map(p => [p.name, p.updated]))
  for (const p of cur.projects) {
    if (hasAsk(p) && prevAsk.get(p.name) !== p.ask) out.push({ at: cur.at, text: `${short(p.name)}　新的決策項目`, tone: 'amber' })
    const gate = parseGate(p.gate)
    if (gate && prevGate.get(p.name) !== (p.gate ?? '').trim()) out.push({ at: cur.at, text: `${short(p.name)}　新的審核關卡`, tone: 'amber' })
    if (prevUpd.get(p.name) !== p.updated && prevUpd.has(p.name)) out.push({ at: cur.at, text: `${short(p.name)}　STATUS 已更新`, tone: 'green' })
    for (const j of p.jobs) {
      const was = prevJobs.get(j.id)
      if (j.kind === 'running' && was !== 'running') out.push({ at: cur.at, text: `${short(p.name)}　執行者開始執行`, tone: 'teal' })
      if (j.kind === 'newer' && was !== 'newer') {
        const result = jobResult(j.status)
        const executor = j.executor === 'codex' ? 'Codex' : j.executor === 'claude' ? 'Claude' : '執行者'
        out.push({ at: cur.at, text: `${short(p.name)}　${executor} ${result.event}`, tone: result.tone })
      }
    }
  }
  for (const p of cur.projects) {
    for (const t of prTransitions(short(p.name), prev.projects.find(x => x.name === p.name)?.pr, p.pr)) out.push({ at: cur.at, text: t.text, tone: t.tone })
  }
  const prevWaiting = waitingBefore(prev)
  for (const b of cur.blocked) if (!prevWaiting.has(b.name)) out.push({ at: cur.at, text: `工作階段「${b.name}」${b.why}`, tone: 'amber' })
  if (cur.codex.startsWith('STALE') && !prev.codex.startsWith('STALE')) out.push({ at: cur.at, text: 'Codex broker 過期', tone: 'red' })
  return out
}

/**
 * A phone-style battery of what is LEFT (100 − used): the body is `width` cells with the
 * remaining percent centred in it, split at the fill edge so each half takes its own background.
 * Spaces and ASCII only: block glyphs render double-width in CJK terminals.
 */
export function battery(usedPercent: number, width = 10, low = 40, critical = 20): { left: number; tone: 'green' | 'low' | 'red'; filled: string; empty: string } {
  const left = Math.max(0, Math.min(100, Math.round(100 - usedPercent)))
  const label = `${left}%`
  const start = Math.floor((width - label.length) / 2)
  const body = (' '.repeat(start) + label).padEnd(width)
  const cut = left > 0 ? Math.max(1, Math.round((left / 100) * width)) : 0
  return { left, tone: left <= critical ? 'red' : left <= low ? 'low' : 'green', filled: body.slice(0, cut), empty: body.slice(cut) }
}

/** The project behind `next(s)`, when it is a project row (so the bar can select it). */
export function nextProject(s: Snapshot): string | null {
  if (s.error || s.codex.startsWith('STALE')) return null
  const all = rows(s)
  return (all.find(x => x.state === 'ACTION' || x.state === 'GATE') ?? all.find(x => x.state === 'SYNC'))?.full ?? null
}

/** `重置 17:00・2 小時 13 分後` (same day) or `重置 10/8 (三) 09:00・2 天 4 小時後`. */
export function resetText(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const when = sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} (${'日一二三四五六'[d.getDay()]}) ${hm}`
  const mins = Math.max(0, Math.round((t - now) / 60000))
  const dd = Math.floor(mins / 1440), hh = Math.floor((mins % 1440) / 60), mm = mins % 60
  const left = dd ? `${dd} 天 ${hh} 小時後` : hh ? `${hh} 小時 ${mm} 分後` : `${mm} 分後`
  return `重置 ${when}・${left}`
}

/** Last meaningful line of an executor job log, trimmed for one table cell. */
export function lastLogLine(log: string): string {
  const lines = log.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^[-=─*`]+$/.test(l))
  return (lines.pop() ?? '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 80)
}

/** `已跑 12m・<last log line or phase>` for a running job. */
export function runLine(j: JobFlag, now: number): string {
  const t = Date.parse(j.startedAt ?? '')
  const elapsed = Number.isNaN(t) ? '' : `已跑 ${ago(t, now)}`
  const detail = j.last || (j.phase && j.phase !== 'running' ? j.phase : '') || ''
  if (!elapsed && !detail) return j.executor ? `${j.executor} 執行中` : '執行中'
  const body = elapsed && detail ? `${elapsed}・${detail}` : elapsed || detail
  return (j.executor ? `${j.executor} · ` : '') + body
}

/** A task's name: the prompt's first meaningful line, without markdown and a leading `任務：`. */
export function taskTitle(prompt: string | undefined, fallback: string): string {
  const line = (prompt ?? '').split(/\r?\n/).map(l => l.replace(/^#+\s*/, '').trim()).find(l => l && !l.startsWith('<!--'))
  return (line ?? fallback).replace(/^任務[：:]\s*/, '').slice(0, 60) || fallback
}

const LIVE = new Set(['running', 'queued'])

/** Every running or queued task, then the three most recently finished. */
export function jobTasks(jobs: Job[]): ExecutorTask[] {
  const tasks = jobs.filter(j => j.jobClass === 'task').map((j): ExecutorTask => ({
    id: j.id,
    status: j.status ?? '?',
    ...(j.executor ? { executor: j.executor } : {}),
    ...(j.fallbackFrom ? { fallbackFrom: j.fallbackFrom } : {}),
    title: taskTitle(j.request?.prompt, j.summary ?? j.id),
    model: j.request?.model ?? '',
    effort: j.request?.effort ?? '',
    startedAt: j.startedAt ?? j.createdAt,
    completedAt: j.completedAt,
  }))
  const live = tasks.filter(x => LIVE.has(x.status))
  const done = tasks.filter(x => !LIVE.has(x.status))
    .sort((a, b) => (Date.parse(b.completedAt ?? '') || 0) - (Date.parse(a.completedAt ?? '') || 0))
    .slice(0, 3)
  return [...live, ...done]
}

/** Compact a model id for one-line task metadata without knowing model names. */
export function shortModel(model: string, max = 14): string {
  let value = model.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/^.*\//, '')
  value = value.replace(/^[a-z]+[-_]\d+(?:\.\d+)*(?:[-_])?/i, '') || value
  return value.length > max ? value.slice(0, Math.max(1, max - 1)) + '…' : value
}

/** Icon, tone and the short right-hand meta of one task line. */
export function taskMeta(t: ExecutorTask, now: number): { icon: string; tone: 'teal' | 'dim' | 'green' | 'red'; meta: string } {
  const settings = [shortModel(t.model ?? ''), t.effort, t.fallbackFrom ? `${t.fallbackFrom}→claude` : ''].filter(Boolean).join(' · ')
  const suffix = settings ? ` · ${settings}` : ''
  if (t.status === 'running') return { icon: '●', tone: 'teal', meta: `已跑 ${ago(Date.parse(t.startedAt ?? ''), now)}${suffix}` }
  if (t.status === 'queued') return { icon: '○', tone: 'dim', meta: `排隊中${suffix}` }
  if (t.status === 'failed' || t.status === 'cancelled') return { icon: '✕', tone: 'red', meta: `${t.status === 'failed' ? '失敗' : '已取消'}${suffix}` }
  if (t.status !== 'completed') return { icon: '?', tone: 'dim', meta: `狀態未知（${t.status || '?'}）${suffix}` }
  return { icon: '✓', tone: 'green', meta: `${ago(Date.parse(t.completedAt ?? ''), now)} 前完成${suffix}` }
}

/**
 * Parse `codex-quota.ps1` output (`{ at, rate_limits }`) or the raw rollout event that
 * `codex-quota.sh` prints (`{ timestamp, payload: { rate_limits | info.rate_limits } }`);
 * a window past its reset counts as unused.
 */
export function parseCodexQuota(text: string, now: number): { at: string; limits: { label: string; percent: number; resetsAt?: string }[]; credits?: string } | null {
  let d: any
  try { d = JSON.parse(text.trim().split('\n').pop() ?? '') } catch { return null }
  const rl = d?.rate_limits ?? d?.payload?.rate_limits ?? d?.payload?.info?.rate_limits
  if (!rl) return null
  const limits: { label: string; percent: number; resetsAt?: string }[] = []
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w.used_percent !== 'number') continue
    const mins = Number(w.window_minutes) || 0
    const label = mins >= 10000 ? 'Codex 週' : mins >= 280 && mins <= 320 ? 'Codex 5h' : `Codex ${Math.round(mins / 60)}h`
    const reset = typeof w.resets_at === 'number' ? w.resets_at * 1000 : NaN
    const past = Number.isFinite(reset) && reset <= now
    limits.push({ label, percent: past ? 0 : w.used_percent, ...(Number.isFinite(reset) && !past ? { resetsAt: new Date(reset).toISOString() } : {}) })
  }
  const bal = rl.credits && !rl.credits.unlimited && rl.credits.balance != null ? String(rl.credits.balance) : undefined
  return { at: String(d.at ?? d.timestamp ?? ''), limits, ...(bal ? { credits: Number(bal).toLocaleString('en-US') } : {}) }
}

/**
 * Warnings a project's jobs carry, as feed lines. A job that had already finished, and was last
 * updated, before this plugin lifetime began (`since`) is history: after a reload its warning is not
 * said again. An unfinished job, or one updated since, still speaks.
 */
export function jobWarnings(projectName: string, jobs: { warning?: string; status?: string; completedAt?: string; updatedAt?: string }[], since: number): string[] {
  return jobs.filter(job => {
    if (!job.warning) return false
    const done = !!job.completedAt || ['completed', 'failed', 'cancelled'].includes(job.status ?? '')
    if (!done) return true
    const updated = Date.parse(job.updatedAt ?? job.completedAt ?? '')
    return Number.isFinite(updated) && updated >= since
  }).map(job => `${projectName}：${job.warning}`)
}
