// Sync progress: what a 同步 STATUS dispatch is doing now, and which finished work auto-sync takes.
// Pure logic, no I/O; register.tsx keeps one SyncProgress per STATUS path and advances it on refresh.
import type { Project, SyncProgress, SyncStage } from '../types'
import { dispatchBlockReason, isManual } from './actions'

/** A finished sync stays on screen this long, so its outcome is seen after the fact. */
export const SYNC_KEEP_MS = 5 * 60_000
/** A dispatch that never reached the executor (the session reloaded mid-dispatch) is dropped after this. */
const DISPATCH_STALE_MS = 3 * 60_000

export const SYNC_STEPS = ['派工', '執行', '寫回 STATUS'] as const
export type SyncMark = 'done' | 'current' | 'todo' | 'fail'

export const isSyncEnded = (stage: SyncStage) => stage !== 'dispatch' && stage !== 'running'

/** `autoSync` option: `on` (default) syncs finished work that left the CARD behind, once per job; `off` never. */
export function autoSyncMode(value: unknown): 'on' | 'off' {
  return String(value ?? '').trim().toLowerCase() === 'off' ? 'off' : 'on'
}

/**
 * Move a sync along from what the latest refresh saw: its job running, finished, or gone, and
 * whether the CARD's 更新 moved since the dispatch. Null when it should no longer show.
 */
export function advanceSync(track: SyncProgress, project: Project | undefined, now: number): SyncProgress | null {
  if (!project) return null
  if (isSyncEnded(track.stage)) return now - (track.endedAt ?? track.at) > SYNC_KEEP_MS ? null : track
  if (track.stage === 'dispatch') return now - track.at > DISPATCH_STALE_MS ? null : track
  const cardChanged = project.updated !== track.cardAt
  const running = project.jobs.find(job => job.kind === 'running' && job.id === track.jobId)
  if (running) return { ...track, phase: running.phase || running.status }
  const task = (project.tasks ?? []).find(item => item.id === track.jobId)
  const ended = (stage: SyncStage, detail?: string): SyncProgress => {
    const next: SyncProgress = { ...track, stage, endedAt: now }
    delete next.phase
    if (detail) next.detail = detail
    return next
  }
  if (task?.status === 'failed' || task?.status === 'cancelled') return ended('run-failed', task.status === 'failed' ? '同步工作失敗' : '同步工作已取消')
  if (cardChanged) return ended('done')
  if (task && !['running', 'queued'].includes(task.status)) return ended('unchanged')
  // Not listed yet (Codex writes its state file a little after accepting the job): keep waiting.
  return track
}

/** Each step's mark: done, the one under way, not reached, or where it stopped. */
export function syncSteps(track: SyncProgress): { label: string; mark: SyncMark }[] {
  const marks: Record<SyncStage, SyncMark[]> = {
    dispatch: ['current', 'todo', 'todo'],
    running: ['done', 'current', 'todo'],
    done: ['done', 'done', 'done'],
    unchanged: ['done', 'done', 'fail'],
    'dispatch-failed': ['fail', 'todo', 'todo'],
    'run-failed': ['done', 'fail', 'todo'],
  }
  return SYNC_STEPS.map((label, index) => ({ label, mark: marks[track.stage][index]! }))
}

const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

/** What the sync is doing, in words, after the step marks. */
export function syncStatus(track: SyncProgress, now: number): string {
  const who = track.executor ?? '執行者'
  const auto = track.auto ? '自動同步・' : ''
  switch (track.stage) {
    case 'dispatch': return `${auto}正在派工給 ${who}…（${elapsed(now - track.at)}）`
    case 'running': return `${auto}${who} 寫回中${track.phase ? `（${track.phase}）` : ''}・${elapsed(now - track.at)}`
    case 'done': return `${auto}已寫回 STATUS，用時 ${elapsed((track.endedAt ?? now) - track.at)}`
    case 'unchanged': return `${auto}${who} 已結束，但 CARD 的「更新」沒有變：結果可能沒寫回，請開啟 STATUS 檢查或再同步一次`
    case 'dispatch-failed': return `${auto}派工失敗：${track.detail ?? '原因不明'}`
    case 'run-failed': return `${auto}${track.detail ?? '同步工作失敗'}，請檢查任務`
  }
}

const MARK: Record<SyncMark, string> = { done: '●', current: '◉', todo: '○', fail: '✕' }

/** `● 派工 ─ ◉ 執行 ─ ○ 寫回 STATUS`, for the pane's 同步 line. */
export function syncStepsText(track: SyncProgress): string {
  return syncSteps(track).map(step => `${MARK[step.mark]} ${step.label}`).join(' ─ ')
}

/** The band's chip: short, and the tone of how it is going. */
export function syncChip(track: SyncProgress, now: number, compact: boolean): { text: string; tone: 'blue' | 'green' | 'red' } {
  switch (track.stage) {
    case 'dispatch': return { text: compact ? '↻派工' : '↻ 同步：派工中', tone: 'blue' }
    case 'running': return { text: compact ? '↻執行' : `↻ 同步：執行中 ${elapsed(now - track.at)}`, tone: 'blue' }
    case 'done': return { text: compact ? '↻✓' : '↻ 同步完成', tone: 'green' }
    case 'unchanged': return { text: compact ? '↻?' : '↻ 同步未寫回', tone: 'red' }
    default: return { text: compact ? '↻✕' : '↻ 同步失敗', tone: 'red' }
  }
}

/** The one sync the band shows: one under way first, else the most recently ended. */
export function bandSync(tracks: Record<string, SyncProgress>): SyncProgress | null {
  const all = Object.values(tracks)
  return all.find(track => !isSyncEnded(track.stage))
    ?? all.sort((a, b) => (b.endedAt ?? b.at) - (a.endedAt ?? a.at))[0] ?? null
}

/**
 * The finished jobs auto-sync would write back for a project in 待同步: completed work the CARD
 * does not reflect. A failed or cancelled job needs a person, and a sync job is never synced again,
 * so a sync that leaves the CARD unchanged cannot start another.
 */
export function autoSyncJobs(project: Project): string[] {
  if (isManual(project) || dispatchBlockReason(project)) return []
  return project.jobs
    .filter(job => job.kind === 'newer' && job.status === 'completed' && job.task !== 'sync')
    .map(job => `${project.statusPath}\u0000${job.executor ?? ''}:${job.id}`)
}
