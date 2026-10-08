import type { Project, Snapshot, ActionKind, ContinueConfirmation, VerificationResult, PendingAction, ReviewRequest } from '../types'
import { terminalLines } from './terminal'
import type { State } from './logic'
import { hasAsk, parseGate, rows, saysNone } from './logic'

export const ACTION_LABEL: Record<ActionKind, string> = {
  verify: '▶ 執行驗證', sync: '⇢ 同步 STATUS', continue: '⇢ 繼續下一步', reply: '↩ 回覆執行者',
  decide: '✎ 做決定', gate: '⚑ 審核關卡', open: '↗ 開啟 STATUS.md',
}

export function actionLabel(kind: ActionKind, project: Project): string {
  return kind === 'gate' && parseGate(project.gate)?.kind === 'release' ? '⚑ 最終審核' : ACTION_LABEL[kind]
}

export function dispatchBlockReason(project: Project): string {
  const active = project.jobs.filter(job => job.kind === 'running')
  return active.length ? `${[...new Set(active.map(job => job.executor ?? '執行者'))].join(' / ')} 工作尚未結束` : ''
}

/** A `manual` project is handoff-only: the panel never dispatches it, CARD/verify/gates still work. */
export const isManual = (project: Project) => project.executor === 'manual'

export function actionKinds(project: Project, state: State): ActionKind[] {
  const kinds: ActionKind[] = []
  const dispatchable = !isManual(project)
  if (project.verify.trim()) kinds.push('verify')
  // A finished job that stopped to ask the user is an ACTION row; syncing its result is still the way on.
  const asking = state === 'ACTION' && !hasAsk(project) && project.jobs.some(job => job.kind === 'newer' && job.asks)
  // The asking session can be answered in place: the reply resumes it with the person's words as its prompt.
  if (dispatchable && asking && askingSession(project) && !dispatchBlockReason(project)) kinds.push('reply')
  if (dispatchable && (state === 'SYNC' || asking) && !dispatchBlockReason(project)) kinds.push('sync')
  const gate = parseGate(project.gate)
  const next = project.next.trim()
  if (dispatchable && state === 'IDLE' && !dispatchBlockReason(project) && next && !saysNone(next) && !hasAsk(project) && !gate) kinds.push('continue')
  if (hasAsk(project)) kinds.push('decide')
  if (gate && gate.kind !== 'unknown') kinds.push('gate')
  return [...kinds, 'open']
}

/** A submitted review may wait this long for a turn to finish it before the row unlocks by itself. */
export const GATE_PENDING_MS = 10 * 60_000

/**
 * Whether a turn's text is the review a request submitted. The host may wrap a plugin's prompt
 * (`The console-status plugin sent a message:` above it, a note below it), so the prompt's first
 * line found inside the turn's text counts as much as the exact text.
 */
export function reviewTurnMatches(request: { text: string }, turnText: string): boolean {
  if (turnText === request.text) return true
  const marker = request.text.split(/\r?\n/).map(line => line.trim()).find(line => line) ?? ''
  return marker.length >= 12 && turnText.includes(marker)
}

/** A pending review whose CARD no longer carries a gate: over, as far as the row is concerned. */
export function staleGate(pending: PendingAction | undefined, project: Project): boolean {
  return !!pending && pending.kind === 'gate' && !parseGate(project.gate)
}

const sameGate = (current: string | undefined, submitted: string | undefined) => submitted === undefined || (current ?? '').trim() === submitted.trim()

/**
 * Why a pending action should be dropped, or null while someone still owns it: a review whose gate the CARD
 * moved past, or that waited GATE_PENDING_MS with no turn running for it; any other action nobody in this
 * plugin lifetime holds the lock for, which only an earlier lifetime (before a reload) can have left behind.
 */
export function stalePendingReason(pending: PendingAction, request: ReviewRequest | undefined, project: Project | undefined, now: number, locked: boolean, turnRunning: boolean): string | null {
  if (pending.kind !== 'gate') return locked ? null : '動作已失去追蹤'
  if (!request) return locked ? null : '審核已失去追蹤'
  if (project && !sameGate(project.gate, request.gate)) return '關卡已變更'
  if (request.turnId && turnRunning) return null
  if (now - pending.at >= GATE_PENDING_MS) return '審核狀態已逾時'
  return null
}

const SYNC_INSTRUCTION = '把最近完成的工作結果寫回 STATUS CARD，只改 CARD 與歷程，不做其他變更'
const CONTINUE_INSTRUCTION = '依 STATUS CARD 的下一步繼續；遵守任務骨架；結束時更新 CARD（含關卡欄）'

/** What a job was dispatched for, read back from its prompt (Codex's state file keeps the prompt, not our kind). */
export function dispatchKind(prompt: string | undefined): 'sync' | 'continue' | undefined {
  const text = (prompt ?? '').trimStart()
  return text.startsWith(SYNC_INSTRUCTION) ? 'sync' : text.startsWith(CONTINUE_INSTRUCTION) ? 'continue' : undefined
}

/**
 * How a continue turn starts and ends, so the session stays in step with the console: the rev that counts is
 * the one read now (a resumed session remembers older ones), a review gate waits for a finished review, and a
 * turn that reaches a gate or a decision ends instead of waiting on a question nobody is attached to see.
 */
const REV_RULE = '開始前先重讀 CARD，以這次讀到的 rev 為準；寫入前再重讀一次，只有這兩次不同才停下回報（不要跟記憶裡更早的 rev 比）。'
/** 更新 is how the console knows the CARD was written: a guessed or UTC time can read as older than the job. */
const TIME_RULE = '更新欄寫現在的本機時間：先執行 date（Windows 用 Get-Date）取得，不要猜；格式 YYYY-MM-DD HH:MM · rev <n+1> · job <這次的工作 id，若知道>。'
/**
 * A sync resumes the project's session, which remembers an older rev: without the rule it saw a "conflict" and
 * stopped without writing. With nothing new to record it still writes, so the console sees the sync land.
 */
const SYNC_RULES = [
  REV_RULE,
  TIME_RULE,
  '沒有新結果也要寫回：更新時間與 rev，並在歷程記一行「同步：沒有新結果」。',
]
const CONTINUE_RULES = [
  REV_RULE,
  TIME_RULE,
  '驗收綠、獨立審核還沒跑完：關卡留 無，下一步寫審核任務；審核跑完才設 review。',
  '審核任務的下一步以 .task/review-<name>.md 路徑開頭（才會開新 session）；修正工作以動詞開頭（例如「依 .task/review-x.md 的意見修正」）。',
  '到關卡或需要使用者決定時，把它寫進 CARD（等使用者／關卡）後結束這一輪，不要提問等待。',
]

export function dispatchPrompt(project: Project, kind: 'sync' | 'continue'): string {
  const instruction = kind === 'sync' ? SYNC_INSTRUCTION : CONTINUE_INSTRUCTION
  const rules = `\n${(kind === 'continue' ? CONTINUE_RULES : SYNC_RULES).join('\n')}`
  return `${instruction}\nSTATUS：${project.statusPath}\n只在此專案授權的本機範圍作業。不得執行正式環境變更或 release；需要上線時填入 release 關卡，交主控台整理後由使用者決定。${rules}`
}

/**
 * A sync in a new small session (`sync.session: fresh`, the default once a sync model is set) has no memory of
 * the work: it learns what finished from the files, git and the executor digest that follows, and writes only what they show.
 */
const FRESH_SYNC_RULES = [
  '這是新的 session，沒有先前的對話：先讀 STATUS.md、git log 與 git status，再看下面的執行者摘要，判斷最近完成了什麼。',
  '只寫檔案、git 與摘要看得到的事實；看不出結果的項目寫「待確認」，不要推測或補做工作。',
]

/** A sync dispatched to a new session: the usual sync prompt, how to find the work without memory, and the digest. */
export function freshSyncPrompt(project: Project, digest: string): string {
  return `${dispatchPrompt(project, 'sync')}\n${FRESH_SYNC_RULES.join('\n')}\n${digest}`
}

/** A reply to an executor that stopped to ask: the person's words first, then the same rules a continue carries. */
export function replyPrompt(project: Project, text: string): string {
  return `使用者在主控台回覆你上一輪的提問：\n${text.trim()}\n\n依這個回覆繼續；遵守任務骨架；結束時更新 STATUS CARD（含關卡欄）。\nSTATUS：${project.statusPath}\n只在此專案授權的本機範圍作業。不得執行正式環境變更或 release；需要上線時填入 release 關卡，交主控台整理後由使用者決定。\n${CONTINUE_RULES.join('\n')}`
}

export function gatePrompt(project: Project): string {
  const gate = parseGate(project.gate)
  if (!gate || gate.kind === 'unknown') throw new Error('關卡種類無法辨識；請先檢查 STATUS。')
  const base = `依 claude-console skill 審核「${project.name}」的 ${gate.kind} 關卡。`
  return gate.kind === 'release'
    ? `${base}整理成「可上線／不可上線＋理由＋要使用者確認的一句」；不得自行執行 release 或任何正式環境變更。`
    : `${base}依證據判斷，指出結果與理由，更新關卡結論；不得執行 release 或正式環境變更。`
}

/**
 * An independent review starts in a new session: it must not carry the work's context. A review's 下一步 starts
 * with its task path (`.task/review-x.md（…）`); work that follows a review starts with a verb
 * (`依 .task/review-x.md 的意見修正`) and resumes the project's session.
 */
export function freshSession(project: Project): boolean {
  return /^`?\.task[\\/]+review-[^\s）)`]*\.md/i.test(project.next.trim())
}

/** The session of the newest finished job that stopped to ask the user: the one its row's sync must resume. */
export function askingSession(project: Project): string | undefined {
  return project.jobs.filter(job => job.kind === 'newer' && job.asks && job.sessionId).pop()?.sessionId
}

export function workSignature(project: Project): string {
  return JSON.stringify([project.statusPath, project.updated, project.next, project.ask, project.gate ?? ''])
}

export function confirmationMatches(value: ContinueConfirmation | undefined, signature: string, now: number, windowMs = 3000): boolean {
  return !!value && value.signature === signature && now >= value.at && now - value.at < windowMs
}

/**
 * The CARD's 驗證 command is written by background executors, so a command the user has not
 * approved for this project (new, or changed since) needs a second press after it is shown in full.
 */
export const VERIFY_CONFIRM_MS = 10_000
/** Long enough to reach the button again on a phone over Remote Control. */
export const CONTINUE_CONFIRM_MS = 6_000
export const verifySignature = (command: string) => `verify\u0000${command}`
export const verifyTrusted = (trusted: Record<string, string>, statusPath: string, command: string) => trusted[statusPath] === command

/** CARD verification is a shell command, run in the project's directory, not the console's. */
export function verificationArgs(command: string, windows: boolean): string[] {
  if (!windows) return ['sh', '-lc', command]
  return ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference = 'Stop'; & { ${command}\n}; $consoleVerifyOK = $?; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $consoleVerifyOK) { exit 1 }`]
}

/** The API returns separate streams; append stderr, then keep only the final three nonblank lines. */
export function outputTail(stdout: string, stderr = ''): string[] {
  return terminalLines(`${stdout}\n${stderr}`).map(s => s.trimEnd()).filter(s => s.trim()).slice(-3).map(s => s.slice(0, 500))
}

export function verificationResult(command: string, at: number, result: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }): VerificationResult {
  return { command, at, ok: result.exitCode === 0, exitCode: result.exitCode, lines: outputTail(result.stdout, result.stderr), truncated: !!(result.isStdoutTruncated || result.isStderrTruncated) }
}

export function launchId(stdout: string): string | null {
  try {
    const data = JSON.parse(stdout.trim())
    return typeof data?.jobId === 'string' && data.jobId.trim() ? data.jobId : null
  } catch { return null }
}

/**
 * What the prompt box offers as its dim Tab suggestion: the way on for the project the next-step card points at
 * (a decision, a reply to an executor that asked, a review gate, a sync), else continuing the first idle project
 * with a next step. Each is a prompt or a `/console` command that does exactly that; null when nothing waits.
 */
export function suggestedPrompt(s: Snapshot, pending: Record<string, unknown> = {}): string | null {
  if (s.demo || s.error) return null
  const list = rows(s)
  const ready = (name: string) => {
    const p = s.projects.find(x => x.name === name)
    return p && !pending[p.statusPath] ? p : undefined
  }
  const urgent = list.find(r => r.state === 'ACTION' || r.state === 'GATE') ?? list.find(r => r.state === 'SYNC')
  if (urgent) {
    const p = ready(urgent.full)
    if (!p) return null
    const kinds = actionKinds(p, urgent.state)
    if (kinds.includes('decide')) return `「${p.name}」決策：`
    if (kinds.includes('reply')) return `/console reply ${p.name} `
    if (kinds.includes('gate')) return `/console gate ${p.name}`
    if (kinds.includes('sync')) return `/console sync ${p.name}`
    return null
  }
  for (const r of list) {
    if (r.state !== 'IDLE') continue
    const p = ready(r.full)
    if (p && actionKinds(p, 'IDLE').includes('continue')) return `/console continue ${p.name}`
  }
  return null
}

/**
 * The project a decision prompt names (`「<project>」決策：…`, as ✎ 做決定 and the Tab suggestion write it) when it
 * has a decision open, so a decision sent without selecting the row still carries that project's context.
 */
export function decisionProject<P extends Project>(projects: P[], text: string): P | undefined {
  const named = text.trimStart().match(/^「([^」]+)」決策：/)?.[1]
  return named ? projects.find(p => p.name === named && hasAsk(p)) : undefined
}

/** The actions a `/console <action> <project>` command can start; verify keeps its own second-press check. */
export const COMMAND_ACTIONS = ['verify', 'sync', 'continue', 'reply', 'gate'] as const

/**
 * The project a command names and the words after it: the longest project name the text starts with
 * (names may hold spaces), else the one whose name starts with the first word, ignoring case.
 */
export function commandTarget<P extends { name: string }>(projects: P[], rest: string): { project: P; text: string } | null {
  const text = rest.trim()
  const lower = text.toLowerCase()
  const exact = projects.filter(p => lower === p.name.toLowerCase() || lower.startsWith(p.name.toLowerCase() + ' '))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (exact) return { project: exact, text: text.slice(exact.name.length).trim() }
  const word = text.split(/\s+/)[0] ?? ''
  if (!word) return null
  const prefix = projects.filter(p => p.name.toLowerCase().startsWith(word.toLowerCase()))
  return prefix.length === 1 ? { project: prefix[0]!, text: text.slice(word.length).trim() } : null
}
