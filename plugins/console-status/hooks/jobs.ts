import type { Job } from './logic'

type StateFile = { updatedAt?: string; jobs?: unknown }
export type JobFiles = {
  list(path: string): Promise<{ name: string; kind: string }[]>
  read(path: string): Promise<string>
}

const slash = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')

function time(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * state.json files that parsed but whose shape this version does not recognise, keyed by path.
 * The companion is another plugin's internals; when it changes format the console would otherwise
 * show no Codex jobs without saying why. A file that fails to parse is skipped silently (the
 * companion may be mid-write); the next refresh reads it again.
 */
export const stateFormatIssues = new Map<string, string>()

export function stateShapeIssue(state: unknown): string | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return '頂層不是物件'
  const jobs = (state as StateFile).jobs
  if (!Array.isArray(jobs)) return '缺少 jobs 陣列'
  if (jobs.length && !jobs.some(job => !!job && typeof job === 'object' && typeof (job as { id?: unknown }).id === 'string')) return 'jobs 項目都沒有 id'
  return null
}

function stateJobs(text: string, stateDir: string): { job: Job; updatedAt: number | null }[] {
  let state: StateFile
  const path = `${stateDir}/state.json`
  try { state = JSON.parse(text) as StateFile } catch { return [] }
  const issue = stateShapeIssue(state)
  if (issue) stateFormatIssues.set(path, issue)
  else stateFormatIssues.delete(path)
  if (!Array.isArray(state?.jobs)) return []
  const stateUpdatedAt = time(state.updatedAt)
  const out: { job: Job; updatedAt: number | null }[] = []
  for (const value of state.jobs) {
    if (!value || typeof value !== 'object') continue
    const raw = value as Record<string, unknown>
    if (typeof raw.id !== 'string' || !raw.id.trim()) continue
    const job: Job = { id: raw.id }
    for (const key of ['jobClass', 'status', 'summary', 'createdAt', 'updatedAt', 'completedAt', 'startedAt', 'phase', 'logFile'] as const) {
      if (typeof raw[key] === 'string') job[key] = raw[key]
    }
    if (raw.request && typeof raw.request === 'object') {
      const source = raw.request as Record<string, unknown>
      const request: NonNullable<Job['request']> = {}
      for (const key of ['prompt', 'effort', 'model'] as const) if (typeof source[key] === 'string') request[key] = source[key]
      if (Object.keys(request).length) job.request = request
    }
    if (typeof job.logFile === 'string' && job.logFile && !/^(?:[a-z]:)?\//i.test(slash(job.logFile))) {
      job.logFile = `${slash(stateDir)}/${slash(job.logFile).replace(/^\/+/, '')}`
    } else if (typeof job.logFile === 'string') {
      job.logFile = slash(job.logFile)
    }
    out.push({ job, updatedAt: time(job.updatedAt) ?? stateUpdatedAt })
  }
  return out
}

/**
 * Read all companion state roots in priority order. A workspace directory is
 * `<project basename>-<hash>`. Duplicate job ids use the newest updatedAt;
 * equal or missing timestamps retain the earlier root's copy.
 */
export async function readJobs(files: JobFiles, roots: string[], projectRoot: string): Promise<Job[]> {
  const base = slash(projectRoot).split('/').pop() ?? ''
  if (!base) return []
  const selected = new Map<string, { job: Job; updatedAt: number | null }>()
  for (const rawRoot of roots) {
    const root = slash(rawRoot)
    if (!root) continue
    const entries = await files.list(root).catch(() => [])
    for (const entry of entries) {
      if (entry?.kind !== 'dir' || typeof entry.name !== 'string' || !entry.name.toLowerCase().startsWith(base.toLowerCase() + '-')) continue
      const stateDir = `${root}/${entry.name}`
      const text = await files.read(`${stateDir}/state.json`).catch(() => null)
      if (typeof text !== 'string' || !text.trim()) { stateFormatIssues.delete(`${stateDir}/state.json`); continue }
      for (const candidate of stateJobs(text, stateDir)) {
        const current = selected.get(candidate.job.id)
        if (!current || (candidate.updatedAt !== null && (current.updatedAt === null || candidate.updatedAt > current.updatedAt))) {
          selected.set(candidate.job.id, candidate)
        }
      }
    }
  }
  return [...selected.values()].map(value => value.job)
}

/** One line for the footer when any companion state file has an unrecognised shape, else ''. */
export function stateFormatWarning(): string {
  const [first] = stateFormatIssues
  if (!first) return ''
  const more = stateFormatIssues.size > 1 ? ` 等 ${stateFormatIssues.size} 個檔` : ''
  return `Codex 工作狀態格式無法辨識（${first[0]}：${first[1]}${more}）；Codex 工作可能顯示不全，請更新 console-status`
}
