// Pure logic for console-status: no I/O, so tests can exercise it directly.
import type { Blocked, ExecutorTask, JobFlag, Project, Snapshot } from '../types'
import { parseProjectExecutor } from './dispatch'
import type { ProjectExecutor } from './dispatch'

export const STALE_DAYS = 3
export const ROTATE_PERCENT = 50
const NONE = new Set(['', '無', '沒有', '-', '未知'])

export type RegistryRow = { name: string; statusPath: string; executor?: ProjectExecutor }
export type Job = { id: string; kind?: 'sync' | 'continue'; fallbackFrom?: 'codex'; fallbackReason?: string; unmanagedSessionId?: string; warning?: string; executor?: 'claude' | 'codex'; nativeId?: string; sessionId?: string; jobClass?: string; status?: string; summary?: string; createdAt?: string; updatedAt?: string; completedAt?: string; startedAt?: string; phase?: string; logFile?: string; request?: { prompt?: string; effort?: string; model?: string } }
export type Agent = { name?: string; kind?: string; status?: string; state?: string; waitingFor?: string; sessionId?: string; cwd?: string }

/**
 * Rows of the "STATUS 卡位置" table in projects-scope.md; `~` expanded to `home`.
 * An optional `Executor` header column (claude | codex | manual | blank) sets a project's executor;
 * tables without that column parse exactly as before.
 */
export function parseRegistry(text: string, home: string): RegistryRow[] {
  const parts = text.split('## STATUS 卡位置')
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

/** `- key：value` lines between `<!-- CARD ... -->` and `<!-- /CARD -->`; null when absent. */
export function parseCard(text: string): Record<string, string> | null {
  const m = text.match(/<!-- CARD[\s\S]*?-->([\s\S]*?)<!-- \/CARD -->/)
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

/** Local time of the CARD's 更新 field in ms, or null. */
export function cardTime(updated: string): number | null {
  const m = updated.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime()
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

export function jobFlags(jobs: Job[], cardMs: number | null): JobFlag[] {
  const flags: JobFlag[] = []
  for (const j of jobs) {
    const summary = (j.summary ?? '').slice(0, 60)
    if (isActiveJob(j)) {
      flags.push({ kind: 'running', id: j.id, executor: j.executor, status: j.status ?? 'unknown', summary, startedAt: j.startedAt ?? j.createdAt, phase: j.phase, logFile: j.logFile })
      continue
    }
    if (j.jobClass !== 'task') continue
    // A successful sync already incorporates results into CARD; observation time is not new work.
    if (j.executor === 'claude' && j.kind === 'sync' && j.status === 'completed') continue
    const t = Date.parse(j.completedAt ?? j.createdAt ?? '')
    if (cardMs === null || (!Number.isNaN(t) && t > cardMs)) flags.push({ kind: 'newer', id: j.id, executor: j.executor, status: j.status ?? '?', summary })
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

export function buildProject(row: RegistryRow, cardText: string | null, jobs: Job[], now: number): Project {
  const card = cardText === null ? null : parseCard(cardText)
  const updated = card?.['更新'] ?? ''
  const ms = cardTime(updated)
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
    jobs: jobFlags(jobs, ms),
    tasks: jobTasks(jobs),
  }
}

/** An ask counts unless it is empty or starts with a "none" word (e.g. 「無；示範結果等待整理」). */
export const hasAsk = (p: Project) =>
  p.hasCard && !NONE.has(p.ask) && !/^(無|沒有|none|n\/a)([；;，,。\s(（]|$)/i.test(p.ask)

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
  const prevBlocked = new Set(prev.blocked.map(b => b.name))
  for (const b of cur.blocked) if (!prevBlocked.has(b.name)) out.push(`session「${b.name}」${b.why}`)
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
      buildProject({ name: 'Project-Alpha', statusPath: 'demo/a' }, card('選擇示範介面配色', '示範測試通過；等待配色選擇', 12 * 60_000), [], now),
      buildProject({ name: 'Project-Beta', statusPath: 'demo/b' }, card('無；示範結果等待整理', '示範文件已整理', 3 * 3_600_000),
        [{ id: 'task-demo-new', jobClass: 'task', status: 'completed', completedAt: new Date(now - 60_000).toISOString() }], now),
      buildProject({ name: 'Project-Gamma', statusPath: 'demo/gamma' }, card('無', '示範證據已備妥', 86_400_000, 'review: 確認示範審核結果'), [], now),
      buildProject({ name: 'Sample-Docs', statusPath: 'demo/c' }, card('無', '示範工作執行中', 4 * 86_400_000),
        [
          { id: 'task-demo-run', jobClass: 'task', status: 'running', executor: 'codex', startedAt: new Date(now - 8 * 60_000).toISOString(), request: { prompt: '示範任務：檢查合成 API 文件', model: 'codex-demo-running', effort: 'medium' } },
          { id: 'task-demo-done', jobClass: 'task', status: 'completed', executor: 'codex', completedAt: new Date(now - 60 * 60_000).toISOString(), request: { prompt: '示範任務：整理合成測試結果', model: 'codex-demo-completed', effort: 'high' } },
        ], now),
      buildProject({ name: 'Sample-API', statusPath: 'demo/api' }, card('無', '示範 API 穩定', 2 * 86_400_000), [], now),
    ],
    blocked: [{ name: '示範 session', why: '等批准' }],
    executor: 'claude', codex: 'OK demo', contextPercent: 62, error: null,
    limits: [
      { kind: 'five_hour', percent: 31, resetsAt: new Date(now + 4 * 3_600_000).toISOString() },
      { kind: 'seven_day', percent: 75, resetsAt: new Date(now + 2 * 86_400_000).toISOString() },
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

/** Sessions that belong to this console (its folder or a registered project), not this one, waiting on a person. */
export function relevantBlocked(agents: Agent[], selfId: string | null, roots: string[], home: string): Blocked[] {
  const allowed = roots.map(normPath)
  const consoleDir = normPath(home)
  const mine = agents.filter(a => {
    if (a.sessionId && a.sessionId === selfId) return false
    const cwd = normPath(a.cwd ?? '')
    return cwd === consoleDir || allowed.some(r => cwd === r || cwd.startsWith(r + '/'))
  })
  return blockedSessions(mine).map(b => ({ ...b, why: b.why === '等批准' ? '等待批准' : '等待輸入' }))
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

/** Readable name of a rate-limit window kind (`five_hour` → `5 小時`). */
export function limitName(kind: string): string {
  if (/five|5h|5_hour/i.test(kind)) return '5 小時'
  if (/seven|week|7d/i.test(kind)) return '本週'
  if (/opus/i.test(kind)) return 'Opus'
  return kind
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
  const prevBlocked = new Set(prev.blocked.map(b => b.name))
  for (const b of cur.blocked) if (!prevBlocked.has(b.name)) out.push({ at: cur.at, text: `工作階段「${b.name}」${b.why}`, tone: 'amber' })
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

/** Parse `codex-quota.ps1` output; a window past its reset counts as unused. */
export function parseCodexQuota(text: string, now: number): { at: string; limits: { label: string; percent: number; resetsAt?: string }[]; credits?: string } | null {
  let d: any
  try { d = JSON.parse(text.trim().split('\n').pop() ?? '') } catch { return null }
  const rl = d?.rate_limits
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
  return { at: String(d.at ?? ''), limits, ...(bal ? { credits: Number(bal).toLocaleString('en-US') } : {}) }
}
