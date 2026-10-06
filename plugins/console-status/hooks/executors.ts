import type { Job } from './logic'
import { isActiveJob } from './logic'
import { readJobs } from './jobs'

export type ExecutorKind = 'codex' | 'claude'
export type DispatchOptions = { model?: string; effort?: string; kind?: 'sync' | 'continue'; fallbackFrom?: 'codex'; fallbackReason?: string }
export type ExecutorJob = Job & { executor?: ExecutorKind; nativeId?: string; sessionId?: string }

type RunResult = { exitCode: number; stdout: string; stderr: string }
type RunInit = { cwd?: string; timeoutMs?: number }
export type ExecutorDeps = {
  run(argv: readonly string[], init?: RunInit): Promise<RunResult>
  files: {
    read(path: string): Promise<string>
    list(path: string): Promise<{ name: string; kind: string }[]>
    write(path: string, text: string): Promise<unknown>
    /** Size and mtime; lets lastLine skip re-reading an unchanged log. Optional for callers without it. */
    stat?(path: string): Promise<{ size: number; mtimeMs: number }>
  }
  now(): number | Promise<number>
  /**
   * Every background session (`claude agents --json --all`), shared by all projects in one refresh so
   * the CLI starts once instead of once per project. Absent: each query runs with `--cwd`.
   */
  agents?(): Promise<Agent[]>
}

/** `fs.read` refuses files over 4 MiB, so a longer log has no readable tail. */
const LOG_READ_LIMIT = 4 * 1024 * 1024
const tails = new Map<string, { key: string; line: string }>()
async function logTail(deps: ExecutorDeps, path: string): Promise<string> {
  const stat = deps.files.stat ? await deps.files.stat(path).catch(() => null) : null
  if (stat && stat.size > LOG_READ_LIMIT) return `（log 超過 4 MiB，請直接開啟：${path}）`
  const key = stat ? `${stat.size}|${stat.mtimeMs}` : ''
  const cached = tails.get(path)
  if (key && cached?.key === key) return cached.line
  const line = lastMeaningfulLine((await deps.files.read(path)).slice(-4000))
  if (key) {
    tails.delete(path)
    tails.set(path, { key, line })
    if (tails.size > 64) tails.delete(tails.keys().next().value!)
  }
  return line
}
export type ExecutorConfig = {
  companionScript: string
  companionStateRoots: string[]
  claudeSessionsPath: string
}
export type Executor = {
  listJobs(root: string): Promise<ExecutorJob[]>
  dispatch(root: string, prompt: string, opts: DispatchOptions): Promise<ExecutorJob>
  lastLine(job: Job): Promise<string>
}

type Agent = {
  id?: string
  name?: string
  sessionId?: string
  cwd?: string
  kind?: string
  startedAt?: number | string
  status?: string
  state?: string
  waitingFor?: string
}
type ClaudeJob = {
  id: string
  kind?: 'sync' | 'continue'
  /** Set when a Codex dispatch was sent to Claude by the quota/broker fallback. */
  fallbackFrom?: 'codex'
  fallbackReason?: string
  nativeId?: string
  launchName?: string
  sessionId?: string
  unmanagedSessionId?: string
  warning?: string
  root: string
  prompt: string
  model?: string
  effort?: string
  startedAt: string
  updatedAt?: string
  completedAt?: string
  status: string
  phase: string
}
type RootState = { root: string; sessionId?: string; jobs: ClaudeJob[] }
type ClaudeState = { version: 1; roots: Record<string, RootState> }

const MAX_HISTORY = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHORT_ID = /^[0-9a-f]{8}$/i
const locks = new Map<string, Promise<void>>()

const slash = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
const rootKey = (value: string) => {
  const normalized = slash(value)
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}
const iso = (value: number) => new Date(value).toISOString()
const cleanLine = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()

export function codexArgs(root: string, prompt: string, config: Pick<ExecutorConfig, 'companionScript'>, opts: DispatchOptions): string[] {
  if (!config.companionScript) throw new Error('Codex executor requires companionScript.')
  return [
    'node', config.companionScript, 'task', '--background', '--write', '--resume-last', '--cwd', slash(root), '--json',
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
    prompt,
  ]
}

export function claudeArgs(_root: string, prompt: string, opts: DispatchOptions, sessionId?: string, launchName?: string): string[] {
  return [
    'claude', '--bg',
    ...(launchName ? ['--name', launchName] : []),
    ...(sessionId ? ['--resume', sessionId] : []),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
    prompt,
  ]
}

function lastMeaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/).map(cleanLine).filter(line => line && !/^[-=─*`]+$/.test(line))
  return (lines.pop() ?? '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 80)
}

function parseCompanionId(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout.trim())
    return typeof value?.jobId === 'string' && value.jobId.trim() ? value.jobId.trim() : null
  } catch { return null }
}

function parseLaunchToken(stdout: string): string | null {
  const text = cleanLine(stdout)
  if (SHORT_ID.test(text) || UUID.test(text)) return text
  try {
    const value = JSON.parse(text)
    const candidate = typeof value?.id === 'string' ? value.id.trim() : typeof value?.sessionId === 'string' ? value.sessionId.trim() : ''
    return SHORT_ID.test(candidate) || UUID.test(candidate) ? candidate : null
  } catch { /* Plain native output follows. */ }
  const found = new Set<string>()
  for (const match of text.matchAll(/(?<![0-9a-f])(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{8})(?![0-9a-f])/gi)) found.add(match[0])
  return found.size === 1 ? [...found][0] : null
}

function emptyState(): ClaudeState { return { version: 1, roots: {} } }

async function readState(deps: ExecutorDeps, path: string): Promise<ClaudeState> {
  let text: string
  try { text = await deps.files.read(path) } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    const message = String(error)
    if (code === 'ENOENT' || /\bENOENT\b|no such file/i.test(message)) return emptyState()
    throw new Error(`Claude sessions file could not be read: ${message}`)
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (!value || value.version !== 1 || typeof value !== 'object' || !value.roots || typeof value.roots !== 'object' || Array.isArray(value.roots)) throw new Error('invalid shape')
    const roots: Record<string, RootState> = {}
    for (const [key, raw] of Object.entries(value.roots as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') throw new Error('invalid root')
      const source = raw as Record<string, unknown>
      if (typeof source.root !== 'string' || rootKey(source.root) !== rootKey(key) || !Array.isArray(source.jobs)) throw new Error('invalid root')
      if (source.sessionId !== undefined && (typeof source.sessionId !== 'string' || !UUID.test(source.sessionId))) throw new Error('invalid session id')
      const jobs: ClaudeJob[] = []
      for (const entry of source.jobs) {
        if (!entry || typeof entry !== 'object') throw new Error('invalid job')
        const job = entry as Record<string, unknown>
        if (typeof job.id !== 'string' || typeof job.root !== 'string' || rootKey(job.root) !== rootKey(key) || typeof job.prompt !== 'string' || typeof job.startedAt !== 'string') throw new Error('invalid job')
        jobs.push({
          id: job.id, root: job.root, prompt: job.prompt, startedAt: job.startedAt,
          ...(job.kind === 'sync' || job.kind === 'continue' ? { kind: job.kind } : {}),
          status: typeof job.status === 'string' ? job.status : 'running',
          phase: typeof job.phase === 'string' ? job.phase : 'unknown',
          ...(typeof job.sessionId === 'string' ? { sessionId: job.sessionId } : {}),
          ...(typeof job.unmanagedSessionId === 'string' ? { unmanagedSessionId: job.unmanagedSessionId } : {}),
          ...(typeof job.warning === 'string' ? { warning: job.warning } : {}),
          ...(typeof job.nativeId === 'string' ? { nativeId: job.nativeId } : {}),
          ...(typeof job.launchName === 'string' ? { launchName: job.launchName } : {}),
          ...(job.fallbackFrom === 'codex' ? { fallbackFrom: 'codex' as const } : {}),
          ...(typeof job.fallbackReason === 'string' ? { fallbackReason: job.fallbackReason } : {}),
          ...(typeof job.model === 'string' ? { model: job.model } : {}),
          ...(typeof job.effort === 'string' ? { effort: job.effort } : {}),
          ...(typeof job.updatedAt === 'string' ? { updatedAt: job.updatedAt } : {}),
          ...(typeof job.completedAt === 'string' ? { completedAt: job.completedAt } : {}),
        })
      }
      roots[rootKey(key)] = {
        root: slash(source.root), jobs: jobs.slice(-MAX_HISTORY),
        ...(typeof source.sessionId === 'string' && UUID.test(source.sessionId) ? { sessionId: source.sessionId } : {}),
      }
    }
    return { version: 1, roots }
  } catch { throw new Error('Claude sessions file is malformed; refusing to dispatch without its saved session id.') }
}

async function locked<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve()
  let release = () => {}
  const current = new Promise<void>(resolve => { release = resolve })
  locks.set(path, previous.then(() => current))
  await previous
  try { return await work() } finally { release() }
}

async function mutateState<T>(deps: ExecutorDeps, path: string, mutate: (state: ClaudeState) => { value: T; changed: boolean }): Promise<T> {
  return locked(path, async () => {
    const state = await readState(deps, path)
    const before = JSON.stringify(state)
    const { value, changed } = mutate(state)
    if (changed) {
      for (const root of Object.values(state.roots)) root.jobs = root.jobs.slice(-MAX_HISTORY)
      if (JSON.stringify(await readState(deps, path)) !== before) throw new Error('Claude sessions file changed during update; refresh before retrying.')
      const text = JSON.stringify(state, null, 2) + '\n'
      await deps.files.write(path, text)
      if (await deps.files.read(path) !== text) throw new Error('Claude sessions file verification failed after writing.')
    }
    return value
  })
}

/** One `claude agents --json --all` for every caller until the returned function is dropped. */
export function sharedAgents(run: ExecutorDeps['run']): () => Promise<Agent[]> {
  let pending: Promise<Agent[]> | null = null
  return () => pending ??= run(['claude', 'agents', '--json', '--all'], { timeoutMs: 60_000 }).then(result => {
    if (result.exitCode !== 0) throw new Error(lastMeaningfulLine(`${result.stdout}\n${result.stderr}`) || `Claude agents failed (exit ${result.exitCode}).`)
    return parseAgents(result.stdout)
  })
}

function parseAgents(stdout: string): Agent[] {
  let raw: unknown
  try { raw = JSON.parse(stdout.replace(/^\uFEFF/, '')) } catch { throw new Error('Claude agents returned invalid JSON.') }
  const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { agents?: unknown }).agents) ? (raw as { agents: unknown[] }).agents : null
  if (!values) throw new Error('Claude agents returned an unexpected shape.')
  return values.filter((value): value is Agent => !!value && typeof value === 'object')
}

async function queryAgents(deps: ExecutorDeps, root: string): Promise<Agent[]> {
  const normalized = slash(root)
  if (deps.agents) return (await deps.agents()).filter(agent => typeof agent.cwd === 'string' && belongsTo(agent.cwd, normalized))
  const result = await deps.run(['claude', 'agents', '--json', '--all', '--cwd', normalized], { cwd: normalized, timeoutMs: 60_000 })
  if (result.exitCode !== 0) throw new Error(lastMeaningfulLine(`${result.stdout}\n${result.stderr}`) || `Claude agents failed (exit ${result.exitCode}).`)
  return parseAgents(result.stdout).filter(agent => typeof agent.cwd === 'string' && belongsTo(agent.cwd, normalized))
}

/** The project root itself, or an isolated worktree Claude Code created inside it. */
function belongsTo(cwd: string, root: string): boolean {
  const dir = rootKey(cwd)
  const base = rootKey(root)
  return dir === base || dir.startsWith(`${base}/.claude/worktrees/`)
}

function phaseOf(agent: Agent): { status: string; phase: string; done: boolean; terminal: boolean } {
  const state = (agent.state ?? '').toLowerCase()
  const status = (agent.status ?? '').toLowerCase()
  if (['failed', 'error'].includes(state) || ['failed', 'error'].includes(status)) return { status: 'failed', phase: state || status, done: false, terminal: true }
  if (['stopped', 'cancelled', 'canceled', 'killed'].includes(state) || ['cancelled', 'canceled', 'killed'].includes(status)) return { status: 'cancelled', phase: state || status, done: false, terminal: true }
  if (state === 'done') return { status: 'completed', phase: 'done', done: true, terminal: true }
  if (state === 'blocked') return { status: 'running', phase: `blocked${agent.waitingFor ? `: ${agent.waitingFor}` : ''}`, done: false, terminal: false }
  if (status === 'waiting') return { status: 'running', phase: `waiting${agent.waitingFor ? `: ${agent.waitingFor}` : ''}`, done: false, terminal: false }
  if (status === 'exited') return { status: 'failed', phase: 'exited', done: false, terminal: true }
  return { status: 'running', phase: state || status || 'unknown', done: false, terminal: false }
}

const IDLE_GRACE_MS = 60_000

/**
 * An agent that finished its turn reports `status: idle` while `state` can still say `working`, or
 * `blocked` when its final message asks the user something. Past a short grace after launch either
 * is a finished job. A permission prompt mid-turn reports `status: waiting` and stays running.
 */
function settledPhase(agent: Agent, now: number): ReturnType<typeof phaseOf> {
  const next = phaseOf(agent)
  if (next.status !== 'running' || (agent.status ?? '').toLowerCase() !== 'idle') return next
  const started = typeof agent.startedAt === 'number' ? agent.startedAt : Date.parse(String(agent.startedAt ?? ''))
  if (Number.isFinite(started) && now - started < IDLE_GRACE_MS) return next
  const asks = (agent.state ?? '').toLowerCase() === 'blocked'
  return { status: 'completed', phase: asks ? 'idle: 等你回覆' : 'idle', done: true, terminal: true }
}

function matchAgent(job: ClaudeJob, agents: Agent[], latest: boolean): Agent | null {
  const exactName = job.launchName ? agents.filter(agent => agent.name === job.launchName) : []
  if (exactName.length === 1) return exactName[0]
  if (exactName.length > 1) return null
  // A copy's original session id belongs to a different turn, never to the copy.
  if (job.unmanagedSessionId) return null
  // Pending resumes may share both native and session ids with the previous turn.
  // Only the unique name assigned to this launch can resolve them.
  if (job.phase === 'starting' || job.phase === 'unknown') return null
  const exactLaunch = job.nativeId ? agents.filter(agent => agent.id === job.nativeId || agent.name === job.nativeId) : []
  if (exactLaunch.length === 1) return exactLaunch[0]
  if (exactLaunch.length > 1) return null
  if (!latest || job.status !== 'running' || !job.sessionId) return null
  const exactSession = agents.filter(agent => agent.sessionId === job.sessionId)
  return exactSession.length === 1 ? exactSession[0] : null
}

// A `--bg --resume` copy may already be running the prompt: it stays an active job (tracked by
// its unique launch name, so it keeps blocking dispatch) but never replaces the project's session.
function noteCopy(job: ClaudeJob, agent: Agent): string {
  job.unmanagedSessionId = agent.sessionId
  job.warning = `Claude resume created an unmanaged copy (${agent.sessionId}); original session ${job.sessionId} preserved. The copy blocks new dispatch until it finishes.`
  return job.warning
}

function reconcile(root: RootState, agents: Agent[], nowIso: string): boolean {
  let changed = false
  for (let index = 0; index < root.jobs.length; index++) {
    const job = root.jobs[index]
    // A new turn may reuse the native session id; completed launches are immutable history.
    if (['completed', 'failed', 'cancelled'].includes(job.status)) continue
    const agent = matchAgent(job, agents, index === root.jobs.length - 1)
    if (!agent) continue
    const sessionId = typeof agent.sessionId === 'string' && UUID.test(agent.sessionId) ? agent.sessionId : undefined
    // Known copies matched by their unique launch name can report status without repeating the UUID.
    if (!sessionId && !job.unmanagedSessionId) continue
    const isCopy = !!job.unmanagedSessionId || (!!job.sessionId && !!sessionId && job.sessionId.toLowerCase() !== sessionId.toLowerCase())
    if (isCopy && sessionId && job.unmanagedSessionId !== sessionId) { noteCopy(job, agent); changed = true }
    if (typeof agent.id === 'string' && agent.id && job.nativeId !== agent.id) { job.nativeId = agent.id; changed = true }
    if (!isCopy && sessionId) {
      if (job.sessionId !== sessionId) { job.sessionId = sessionId; changed = true }
      if (index === root.jobs.length - 1 && root.sessionId !== job.sessionId) { root.sessionId = job.sessionId; changed = true }
    }
    const next = settledPhase(agent, Date.parse(nowIso))
    if (job.status !== next.status) { job.status = next.status; changed = true }
    if (job.phase !== next.phase) { job.phase = next.phase; changed = true }
    if (job.updatedAt !== nowIso) { job.updatedAt = nowIso; changed = true }
    if (next.terminal && !job.completedAt) { job.completedAt = nowIso; changed = true }
  }
  return changed
}

function asJob(value: ClaudeJob): ExecutorJob {
  return {
    id: value.id, kind: value.kind, executor: 'claude', jobClass: 'task', status: value.status, summary: value.prompt,
    nativeId: value.nativeId, sessionId: value.sessionId,
    ...(value.fallbackFrom ? { fallbackFrom: value.fallbackFrom, fallbackReason: value.fallbackReason } : {}),
    unmanagedSessionId: value.unmanagedSessionId, warning: value.warning,
    createdAt: value.startedAt, startedAt: value.startedAt, updatedAt: value.updatedAt, completedAt: value.completedAt,
    phase: value.phase, request: { prompt: value.prompt, model: value.model, effort: value.effort },
  }
}

function createCodex(deps: ExecutorDeps, config: ExecutorConfig): Executor {
  return {
    async listJobs(root) {
      const jobs = await readJobs(deps.files, config.companionStateRoots, slash(root))
      return jobs.map(job => ({ ...job, executor: 'codex' as const }))
    },
    async dispatch(root, prompt, opts) {
      const normalized = slash(root)
      const result = await deps.run(codexArgs(normalized, prompt, config, opts), { cwd: normalized, timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(lastMeaningfulLine(`${result.stdout}\n${result.stderr}`) || `Codex dispatch failed (exit ${result.exitCode}).`)
      const id = parseCompanionId(result.stdout)
      if (!id) throw new Error('Codex dispatch did not return a job id.')
      const at = iso(await deps.now())
      return { id, executor: 'codex', jobClass: 'task', status: 'queued', summary: prompt, createdAt: at, startedAt: at, phase: 'queued', request: { prompt, model: opts.model, effort: opts.effort } }
    },
    async lastLine(job) {
      if (!job.logFile) return ''
      return logTail(deps, job.logFile)
    },
  }
}

function createClaude(deps: ExecutorDeps, config: ExecutorConfig): Executor {
  const path = config.claudeSessionsPath
  return {
    async listJobs(rawRoot) {
      const rootName = slash(rawRoot)
      const key = rootKey(rootName)
      if (!(await readState(deps, path)).roots[key]) return []
      const agents = await queryAgents(deps, rootName)
      const nowIso = iso(await deps.now())
      return mutateState(deps, path, state => {
        const root = state.roots[key]
        if (!root) return { value: [] as ExecutorJob[], changed: false }
        const changed = reconcile(root, agents.filter(agent => agent.kind === 'background'), nowIso)
        return { value: root.jobs.map(asJob), changed }
      })
    },
    async dispatch(rawRoot, prompt, opts) {
      const rootName = slash(rawRoot)
      const key = rootKey(rootName)
      const agents = await queryAgents(deps, rootName)
      const now = await deps.now()
      const nowIso = iso(now)
      const launch = await mutateState(deps, path, state => {
        const root = state.roots[key] ?? { root: rootName, jobs: [] }
        state.roots[key] = root
        reconcile(root, agents.filter(agent => agent.kind === 'background'), nowIso)
        const unresolved = root.jobs.some(job => job.phase === 'starting' || job.phase === 'unknown')
        if (unresolved) throw new Error('Claude dispatch has an unresolved launch; refresh it before retrying.')
        const ownedActive = !!root.sessionId && agents.some(agent => agent.sessionId === root.sessionId && settledPhase(agent, now).status === 'running')
        if (ownedActive) throw new Error('Claude session is already active; wait for it before dispatching again.')
        if (root.jobs.some(isActiveJob)) throw new Error('Claude workspace has an active job; wait for it before dispatching again.')
        const suffix = root.jobs.length.toString(36)
        const pendingId = `starting:${now}:${suffix}`
        const launchName = `console-${now.toString(36)}-${suffix}`
        root.jobs.push({
          id: pendingId, kind: opts.kind ?? 'continue', launchName, sessionId: root.sessionId, root: rootName, prompt, model: opts.model, effort: opts.effort, startedAt: nowIso, status: 'running', phase: 'starting',
          ...(opts.fallbackFrom ? { fallbackFrom: opts.fallbackFrom, ...(opts.fallbackReason ? { fallbackReason: opts.fallbackReason } : {}) } : {}),
        })
        return { value: { sessionId: root.sessionId, pendingId, launchName }, changed: true }
      })

      let result: RunResult
      try {
        result = await deps.run(claudeArgs(rootName, prompt, opts, launch.sessionId, launch.launchName), { cwd: rootName, timeoutMs: 60_000 })
      } catch (error) {
        await markUnknown(deps, path, key, launch.pendingId)
        throw error
      }
      if (result.exitCode !== 0) {
        try {
          const observed = await queryAgents(deps, rootName)
          const exists = observed.some(agent => agent.kind === 'background' && agent.name === launch.launchName)
          if (exists) await markUnknown(deps, path, key, launch.pendingId)
          else await markTerminal(deps, path, key, launch.pendingId, 'failed')
        } catch { await markUnknown(deps, path, key, launch.pendingId) }
        throw new Error(lastMeaningfulLine(`${result.stdout}\n${result.stderr}`) || `Claude dispatch failed (exit ${result.exitCode}).`)
      }
      const token = parseLaunchToken(result.stdout)
      if (!token) {
        await markUnknown(deps, path, key, launch.pendingId)
        throw new Error('Claude dispatch returned an unknown background id.')
      }
      const after = await queryAgents(deps, rootName)
      const beforeIds = new Set(agents.map(agent => `${agent.id ?? ''}|${agent.name ?? ''}|${agent.sessionId ?? ''}`))
      const matches = after.filter(agent => agent.kind === 'background' && agent.name === launch.launchName && (agent.id === token || agent.sessionId === token || agent.name === token) && !beforeIds.has(`${agent.id ?? ''}|${agent.name ?? ''}|${agent.sessionId ?? ''}`))
      const confirmed = matches.length === 1 && typeof matches[0].sessionId === 'string' && UUID.test(matches[0].sessionId) ? matches[0] : null
      if (!confirmed) {
        await markUnknown(deps, path, key, launch.pendingId)
        throw new Error('Claude launch could not uniquely confirm its full session id.')
      }
      if (launch.sessionId && launch.sessionId.toLowerCase() !== confirmed.sessionId!.toLowerCase()) {
        const warning = await mutateState(deps, path, state => {
          const job = state.roots[key]?.jobs.find(item => item.id === launch.pendingId)
          if (!job) throw new Error('Claude launch metadata was lost before confirmation.')
          job.id = `${launch.launchName}:${token}`
          job.nativeId = token
          const next = phaseOf(confirmed)
          job.status = next.status
          job.phase = next.phase
          job.updatedAt = nowIso
          if (next.terminal) job.completedAt = nowIso
          return { value: noteCopy(job, confirmed), changed: true }
        })
        throw new Error(warning)
      }
      return mutateState(deps, path, state => {
        const root = state.roots[key]
        const job = root?.jobs.find(item => item.id === launch.pendingId)
        if (!root || !job) throw new Error('Claude launch metadata was lost before confirmation.')
        job.id = `${launch.launchName}:${token}`
        job.nativeId = token
        job.sessionId = confirmed.sessionId
        root.sessionId = confirmed.sessionId
        const next = phaseOf(confirmed)
        job.status = next.status
        job.phase = next.phase
        job.updatedAt = nowIso
        if (next.terminal) job.completedAt = nowIso
        return { value: asJob(job), changed: true }
      })
    },
    async lastLine(job) {
      const nativeId = (job as ExecutorJob).nativeId
      if (!nativeId) return ''
      const result = await deps.run(['claude', 'logs', nativeId], { timeoutMs: 60_000 })
      if (result.exitCode !== 0) throw new Error(lastMeaningfulLine(`${result.stdout}\n${result.stderr}`) || `Claude logs failed (exit ${result.exitCode}).`)
      return lastMeaningfulLine(result.stdout)
    },
  }
}

async function markUnknown(deps: ExecutorDeps, path: string, key: string, pendingId: string): Promise<void> {
  await mutateState(deps, path, state => {
    const job = state.roots[key]?.jobs.find(item => item.id === pendingId)
    if (!job) return { value: undefined, changed: false }
    job.phase = 'unknown'
    job.status = 'running'
    return { value: undefined, changed: true }
  })
}

async function markTerminal(deps: ExecutorDeps, path: string, key: string, pendingId: string, phase: string): Promise<void> {
  const at = iso(await deps.now())
  await mutateState(deps, path, state => {
    const job = state.roots[key]?.jobs.find(item => item.id === pendingId)
    if (!job) return { value: undefined, changed: false }
    job.phase = phase
    job.status = 'failed'
    job.updatedAt = at
    job.completedAt = at
    return { value: undefined, changed: true }
  })
}

export function createExecutor(kind: ExecutorKind, deps: ExecutorDeps, config: ExecutorConfig): Executor {
  return kind === 'codex' ? createCodex(deps, config) : createClaude(deps, config)
}

/**
 * Read both executors and merge them: a project can hold jobs from either one (per-project executor
 * changes, Claude fallback for a Codex dispatch), and RUNNING detection must see all of them.
 */
export async function listWorkspaceJobs(kind: ExecutorKind, deps: ExecutorDeps, config: ExecutorConfig, root: string): Promise<ExecutorJob[]> {
  const other = kind === 'claude' ? 'codex' : 'claude'
  const [selected, background] = await Promise.all([
    createExecutor(kind, deps, config).listJobs(root),
    createExecutor(other, deps, config).listJobs(root),
  ])
  return [...selected, ...background]
}
