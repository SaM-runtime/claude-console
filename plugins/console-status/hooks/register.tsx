// console-status: the Claude console's live overview, with selectable background executors.
// Reads the registry, project STATUS cards and the selected executor's job state.
// Band above the prompt + `/console` pane; toasts on changes. Shows on phones via Remote Control.
import { atom, read, update } from 'claude-code'
import type { Register, PluginOptions } from 'claude-code'
import { resolveConfig, resolveFallbackOptions, legacyDispatchPath, activationMode } from './config'
import type { ConsoleConfig } from './config'
import { codexHealth, isActiveJob } from './logic'
import { parseModels, modelOptions, nextOption, effortOptions, readSettingsFiles, effectiveDispatch, setProjectOverride, executorSignature, projectOverride } from './dispatch'
import type { DispatchSettings, ProjectOverride } from './dispatch'
import { createExecutor, listWorkspaceJobs, sharedAgents } from './executors'
import type { ExecutorDeps, ExecutorJob, ExecutorKind, DispatchOptions } from './executors'
import { actionKinds, actionLabel, dispatchBlockReason, dispatchPrompt, gatePrompt, workSignature, confirmationMatches, verificationArgs, verificationResult, outputTail, isManual, CONTINUE_CONFIRM_MS, VERIFY_CONFIRM_MS, verifySignature, verifyTrusted } from './actions'
import { resolveCompanion } from './companion'
import type { CompanionResolution } from './companion'
import { decideCodexDispatch } from './fallback'
import { isWindowsOs, openFallbackArgs, preflightArgs, quotaArgs } from './platform'
import { stateFormatIssues, stateFormatWarning } from './jobs'
import { pipeline, projectForCwd, projectModeSection, progressContext, progressSignature } from './pipeline'
import type { Pipeline } from './pipeline'
import { pipelineLine, pipelineParts, pipelineText } from './pipeline-view'
import { gitBadge, gitLine, gitProbeMode, gitStatusArgs, parseGitStatus, parsePrView, prLine, prViewArgs } from './git'
import type { PrInfo, CacheClock, UpdateInfo } from '../types'
import { CACHE_WARN_MS, cacheChip, cacheTtlOption, cacheView, cacheWarning, leftText, learnTtl, priceOverride, tokensText, transcriptCache, transcriptPathFor, ttlLabel, usd } from './cache'
import type { TtlSource } from './cache'
import type { CacheTtl } from './cache'
import { commandPreview, dangerReason, guardMode } from './guard'
import { compareVersions, gitBranchArgs, gitPullArgs, gitTopArgs, hasUpdate, LATEST_MANIFEST_URL, localFolder, manifestVersion, marketplaceUpdateArgs, pluginListArgs, UPDATE_CHECK_MS, updateArgs, updateOutcome, versionLine } from './updater'

import type { Project, Snapshot, ActionKind, VerificationResult } from '../types'
import { parseGate, parseCodexQuota, taskMeta, runLine, hasAsk, parseAsk, askSummary, battery, resetText, nextProject, buildProject, counts, demoSnapshot, diffToasts, events, limitName, meter, next, parseRegistry, projectRoot, relevantBlocked, relevantCodex, rows, selectionContext, ROTATE_PERCENT } from './logic'
import type { Agent, State } from './logic'
import { projectColumnWidth, demoEvents } from './logic'
import { batteryBody, METER } from './battery'
import { feedBody } from './feed'
import { trackRowChanges } from './presentation'
import { layoutBand } from './band'
import { advanceSync, autoSyncJobs, autoSyncMode, bandSync, isSyncEnded, syncChip, syncStatus, syncStepsText } from './sync'
import type { SyncProgress } from '../types'

const dispatchRevision = atom({ plugin: 'console-status', key: 'dispatchRevision' } as const, 0)

const PANE = 'console-status'
// What the plugins beneath answered for the band draws nothing: no tree, or Boxes and Texts holding none.
const isEmptyTree = (node: any): boolean =>
  node === null || node === undefined || node === false || node === '' ||
  ((node.type === 'Box' || node.type === 'Text') && (node.children ?? []).every(isEmptyTree))
type GlobalField = 'executor' | 'model' | 'effort'
const SOURCE_LABEL: Record<string, string> = { pane: '面板覆寫', registry: '登錄表', global: '全域' }
const TICK_MS = 60_000
const SLOW_MS = 5 * 60_000
const snapshot = atom({ plugin: 'console-status', key: 'snapshot' } as const, null)
const isDemo = atom({ plugin: 'console-status', key: 'isDemo' } as const, false)
const isPaneOpen = atom({ plugin: 'console-status', key: 'isPaneOpen' } as const, false)
const isBandHidden = atom({ plugin: 'console-status', key: 'isBandHidden' } as const, false)
const isDetail = atom({ plugin: 'console-status', key: 'isDetail' } as const, false)
const isPlain = atom({ plugin: 'console-status', key: 'isPlain' } as const, false)
const selected = atom({ plugin: 'console-status', key: 'selected' } as const, null)
const cursor = atom({ plugin: 'console-status', key: 'cursor' } as const, -1)
const feedAtom = atom({ plugin: 'console-status', key: 'feed' } as const, [])
const isRefreshing = atom({ plugin: 'console-status', key: 'isRefreshing' } as const, false)
const hovered = atom({ plugin: 'console-status', key: 'hovered' } as const, null)
const menuFor = atom({ plugin: 'console-status', key: 'menuFor' } as const, null)
const pendingActions = atom({ plugin: 'console-status', key: 'pendingActions' } as const, {})
const continueConfirmations = atom({ plugin: 'console-status', key: 'continueConfirmations' } as const, {})
const verificationResults = atom({ plugin: 'console-status', key: 'verificationResults' } as const, {})
/** statusPath → the 驗證 command the user approved; mirrored from `$.store` so drawing can read it. */
const trustedVerify = atom({ plugin: 'console-status', key: 'trustedVerify' } as const, {})
const TRUST_KEY = 'trustedVerify'
/** `/console mode`: this session's choice over the `projectMode` option. */
const modeOverride = atom({ plugin: 'console-status', key: 'modeOverride' } as const, 'auto')
/** Where this Claude Code session runs; a registered project here turns on project mode. */
let sessionCwd: string | null = null
/** The progress last attached to a prompt in project mode, so an unchanged one is not repeated. */
let lastProgress = ''
const actionPulse = atom({ plugin: 'console-status', key: 'actionPulse' } as const, 0)
const reviewRequests = atom({ plugin: 'console-status', key: 'reviewRequests' } as const, {})
const fallbackOffers = atom({ plugin: 'console-status', key: 'fallbackOffers' } as const, {})
/** statusPath → where its 同步 STATUS dispatch is (派工 → 執行 → 寫回), advanced on each refresh. */
const syncProgress = atom({ plugin: 'console-status', key: 'syncProgress' } as const, {})
/** Finished jobs auto-sync already dispatched a sync for (in `$.store`, so once per job across sessions). */
const AUTO_SYNCED_KEY = 'autoSynced'
const AUTO_SYNCED_MAX = 200
/** The same, for this process: holds even when the store refuses a write. */
const autoSynced = new Set<string>()
/** While a job or a sync is under way the console looks every 20 s instead of every minute. */
const FAST_TICK_MS = 20_000
let fastTimer: { cancel(): void } | undefined
const cacheClock = atom({ plugin: 'console-status', key: 'cacheClock' } as const, null)
/** Bumped every 15 s while a cache clock runs, so the countdown redraws without a full refresh. */
const cacheTick = atom({ plugin: 'console-status', key: 'cacheTick' } as const, 0)
const isTurnRunning = atom({ plugin: 'console-status', key: 'isTurnRunning' } as const, false)
/** Installed vs. latest version and an update in progress; kept across a reload so the result shows after it. */
const updateInfo = atom({ plugin: 'console-status', key: 'updateInfo' } as const, null)
const CACHE_TTL_KEY = 'cacheTtl'
/** The cache clock (its `at`) the expiry warning already fired for. */
let cacheWarnedFor = -1
let cacheTimer: { cancel(): void } | undefined
/** When the countdown last redrew: every 15 s, every second in the last minute. */
let cacheDrawnAt = 0
/** This session's transcript, as a classic hook names it (or as Claude Code lays it out, until one does). */
let transcriptPath: string | null = null
let updateTimer: { cancel(): void } | undefined
let updateCheck: Promise<UpdateInfo | null> | null = null
/** The newest version already announced by a toast (kept in `$.store`, so once per version). */
const UPDATE_NOTIFIED_KEY = 'updateNotified'
const RELOAD_DELAY_MS = 1500
const RELOAD_WATCHDOG_MS = 20_000
const actionLocks = new Set<string>()
const earlyReviewStarts = new Map<string, string>()
let selectionClaim: string | null = null

// Slow probes (spawn processes) are cached between ticks; they reset on a reload, which is fine.
let codex = '…'
let agents: Agent[] = []
let codexQuotaText = ''
let companion: CompanionResolution | null = null
let lastSlow = 0
/** Last `gh pr view` per project root: re-asked on the slow interval, every tick while CI runs, or on a branch change. */
const prCache = new Map<string, { at: number; branch: string; pr: PrInfo | null }>()
let demoActive = false
let dataGeneration = 0
let refreshOwner: { generation: number; queued: boolean } | null = null
let refreshTimer: { cancel(): void } | undefined
/**
 * Whether this session runs the console (polling, band, project mode, cache hints, update check).
 * Under `activation: auto` a session stays light until `/console` is used in it; the command
 * guard runs either way.
 */
let consoleActive = false
let sessionStartCwd: string | null = null
const ACTIVE_SESSIONS_KEY = 'consoleSessions'
const ACTIVE_SESSIONS_MAX = 50
let displayWrites: Promise<void> = Promise.resolve()
let demoContext: { config: ConsoleConfig; dispatch: Awaited<ReturnType<typeof readDispatch>> } | null = null
const DISCARDED_REFRESH = Symbol('discarded refresh')
let settingsWrite: Promise<void> = Promise.resolve()
let launchGeneration = 0
const acceptedLaunches = new Set<string>()
const unpublishedLaunches = new Map<string, { root: string; job: ExecutorJob }>()
const jobKey = (job: { executor?: ExecutorKind; id: string }) => `${job.executor}:${job.id}`
const workspaceKey = (root: string) => /^[a-z]:\/|^\/\//i.test(root) ? root.toLowerCase() : root

// A mode transition waits for any older publication, then replaces every visible data channel.
async function publishDisplay(write: () => Promise<void>) {
  const previous = displayWrites
  let release = () => {}
  displayWrites = new Promise<void>(resolve => { release = resolve })
  await previous
  try { await write() } finally { release() }
}

async function demoEnabled($: any) {
  return demoActive || await read($, isDemo)
}

async function refreshDemo($: any, generation = dataGeneration, executor?: ExecutorKind) {
  const now = await $.clock.now()
  await publishDisplay(async () => {
    if (generation !== dataGeneration || !await demoEnabled($)) return
    const previous = await read($, snapshot)
    await update($, snapshot, () => ({ ...demoSnapshot(now), executor: executor ?? demoContext?.dispatch.settings.executor ?? previous?.executor ?? 'claude' }))
    await update($, feedAtom, () => demoEvents(now))
  })
}

async function workspaceJobs(kind: ExecutorKind, deps: ExecutorDeps, config: ConsoleConfig, root: string): Promise<ExecutorJob[]> {
  const jobs = await listWorkspaceJobs(kind, deps, config, root)
  const key = workspaceKey(root)
  for (const [id, pending] of unpublishedLaunches) {
    if (pending.root !== key) continue
    if (jobs.some(job => jobKey(job) === jobKey(pending.job))) unpublishedLaunches.delete(id)
    else jobs.push(pending.job)
  }
  // Every active job of either executor counts, so RUNNING never misses one. Finished jobs count
  // for the project's own executor and for Claude jobs that stood in for a Codex dispatch.
  return jobs.filter(job => job.executor === kind || isActiveJob(job) || !!job.fallbackFrom)
}

const REFRESH_CONCURRENCY = 4
/** `work` over `items` with at most `limit` running at once; results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const lane = async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]!, index) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

/** Config with the companion script actually in use (configured, or auto-resolved when stale). */
const withCompanion = (config: ConsoleConfig): ConsoleConfig => companion?.path ? { ...config, companionScript: companion.path } : config

async function paths($: any, options: PluginOptions) {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  const local = ((await $.env.get('LOCALAPPDATA')) ?? '').replace(/\\/g, '/')
  const temp = (await $.env.get('TMPDIR')) ?? (await $.env.get('TEMP')) ?? '/tmp'
  return { home, config: resolveConfig(options, home, local, temp) }
}

async function readDispatch($: any, config: ConsoleConfig) {
  const text = await $.fs.read(config.dispatchSettingsPath).catch(() => null)
  // Legacy codex-dispatch.json is read-only compatibility, consulted only when dispatch.json is missing.
  const legacy = text === null ? await $.fs.read(legacyDispatchPath(config.dispatchSettingsPath)).catch(() => null) : null
  const { settings, source } = readSettingsFiles(text, legacy, { executor: config.executor, model: config.defaultModel, effort: config.defaultEffort })
  const cache = settings.executor === 'codex' ? await $.fs.read(config.modelsCachePath).catch(() => null) : null
  return { settings, source, models: modelOptions(settings.executor, parseModels(cache)) }
}

let renderCache: { key: string; value: Promise<{ config: ConsoleConfig; dispatch: Awaited<ReturnType<typeof readDispatch>> }> } | null = null
/** Paths and dispatch settings for drawing, read once per settings revision and refresh. */
function renderDispatch($: any, options: PluginOptions, key: string) {
  if (renderCache?.key !== key) {
    const value = paths($, options).then(async ({ config }) => ({ config, dispatch: await readDispatch($, config) }))
    renderCache = { key, value }
    value.catch(() => { if (renderCache?.value === value) renderCache = null })
  }
  return renderCache.value
}

/** One project's override, serialized with the global settings writes. */
async function changeProjectDispatch($: any, config: ConsoleConfig, root: string, field: keyof ProjectOverride, value: string): Promise<DispatchSettings> {
  const previous = settingsWrite
  let release = () => {}
  settingsWrite = new Promise<void>(resolve => { release = resolve })
  await previous
  try {
    if (/[\r\n\x00]/.test(value)) throw new Error('設定值必須是單行文字。')
    const { settings } = await readDispatch($, config)
    const updated = setProjectOverride(settings, root, field, value)
    await $.fs.write(config.dispatchSettingsPath, JSON.stringify(updated, null, 2) + '\n')
    return updated
  } finally { release() }
}

/** Read at mutation time so changing one field preserves the other field on disk. */
async function changeDispatch($: any, config: ConsoleConfig, field: GlobalField, value?: string): Promise<DispatchSettings> {
  const previous = settingsWrite
  let release = () => {}
  settingsWrite = new Promise<void>(resolve => { release = resolve })
  await previous
  try { return await saveDispatch($, config, field, value) } finally { release() }
}

async function saveDispatch($: any, config: ConsoleConfig, field: GlobalField, value?: string): Promise<DispatchSettings> {
  const { settings, models } = await readDispatch($, config)
  const options = field === 'executor' ? ['claude', 'codex'] : field === 'model' ? models.map(m => m.model) : effortOptions(settings.executor, models, settings.model)
  if (field === 'model' && value === undefined && !models.length) throw new Error('模型快取無法讀取；請用 /console model <name> 或 /console effort <level> 設定。')
  const next = value === undefined ? nextOption(settings[field], options) : (/[\r\n\x00]/.test(value) ? null : value.trim())
  if (next === null) throw new Error('設定值必須是單行文字。')
  if (field === 'executor' && next !== 'claude' && next !== 'codex') throw new Error('executor 可選：claude, codex')
  if (field === 'effort' && next && !options.includes(next)) throw new Error(`effort 可選：${options.join(', ')}`)
  const updated = { ...settings, [field]: next } as DispatchSettings
  if (field === 'executor' && next !== settings.executor) { updated.model = ''; updated.effort = '' }
  // An explicit model change must not carry an unsupported effort into the next dispatch.
  if (field === 'model' && updated.effort && !effortOptions(updated.executor, models, updated.model).includes(updated.effort)) updated.effort = ''
  await $.fs.write(config.dispatchSettingsPath, JSON.stringify(updated, null, 2) + '\n')
  return updated
}

async function slowProbes($: any, config: ConsoleConfig, needCodex: boolean, home: string) {
  let probeCodex = ''
  let quotaText = ''
  let probeAgents: Agent[] = []
  let resolved: CompanionResolution | null = null
  if (needCodex) {
    const windows = isWindowsOs(await $.env.get('OS'))
    const preflight = async (script: string) => {
      const ps = await $.process
        .run(preflightArgs($.plugin.root, windows, script, config.companionStateDir, config.companionStateRoots), { timeoutMs: 30_000 })
        .catch(() => null)
      return ps ? (ps.stdout.trim().split('\n').pop() ?? '').trim() || 'unknown' : 'unknown'
    }
    // An empty companionScript is resolved from the installed Codex plugin before the preflight;
    // a configured one is trusted until the preflight reports it MISSING (a stale version folder).
    resolved = await resolveCompanion({ read: (path: string) => $.fs.read(path), list: (path: string) => $.fs.list(path) }, home, config.companionScript).catch(() => null)
    probeCodex = await preflight(resolved?.path || config.companionScript)
    if (config.companionScript && /\bcompanion=MISSING\b/.test(probeCodex)) {
      const retry = await resolveCompanion({ read: (path: string) => $.fs.read(path), list: (path: string) => $.fs.list(path) }, home, config.companionScript, true).catch(() => null)
      if (retry) resolved = retry
      if (retry && retry.source !== 'configured') probeCodex = await preflight(retry.path)
    }
    const q = await $.process
      .run(quotaArgs($.plugin.root, windows), { timeoutMs: 30_000 })
      .catch(() => null)
    quotaText = q ? q.stdout : ''
  }
  const ag = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 30_000 }).catch(() => null)
  try { probeAgents = ag ? JSON.parse(ag.stdout) : [] } catch { probeAgents = [] }
  return { codex: probeCodex, quotaText, agents: probeAgents, companion: resolved }
}

async function refresh($: any, options: PluginOptions, force = false) {
  const generation = dataGeneration
  if (await demoEnabled($)) { await refreshDemo($, generation); return }
  if (generation !== dataGeneration) return
  if (refreshOwner?.generation === generation) { if (force) refreshOwner.queued = true; return }
  const owner = { generation, queued: false }
  refreshOwner = owner
  const current = () => generation === dataGeneration && !demoActive
  const guarded = async <T,>(work: () => Promise<T>): Promise<T> => {
    if (!current()) throw DISCARDED_REFRESH
    const result = await work()
    if (!current()) throw DISCARDED_REFRESH
    return result
  }
  // Checks surround every external await, so a superseded read cannot start the next read/probe/write.
  const io = {
    plugin: { root: $.plugin.root },
    clock: { now: () => guarded(() => $.clock.now()) },
    env: { get: (name: string) => guarded(() => name === 'USERPROFILE' ? $.env.get('USERPROFILE')
      : name === 'HOME' ? $.env.get('HOME') : name === 'LOCALAPPDATA' ? $.env.get('LOCALAPPDATA')
      : name === 'TMPDIR' ? $.env.get('TMPDIR') : name === 'OS' ? $.env.get('OS') : $.env.get('TEMP')) },
    fs: { read: (path: string) => guarded(() => $.fs.read(path)), list: (path: string) => guarded(() => $.fs.list(path)), write: (path: string, text: string) => guarded(() => $.fs.write(path, text)) },
    process: { run: (argv: string[], init: any) => guarded(() => $.process.run(argv, init)) },
    session: { usage: () => guarded(() => $.session.usage()), id: () => guarded(() => $.session.id()) },
  }
  const startingGeneration = launchGeneration
  let refreshingExecutor: string | undefined
  let refreshConfig: ConsoleConfig | undefined
  try {
    const now = await io.clock.now() as number
    const { home, config } = await paths(io, options)
    const { settings } = await readDispatch(io, config)
    refreshingExecutor = executorSignature(settings)
    refreshConfig = config
    let error: string | null = null
    const registry = await io.fs.read(config.registryPath).catch(() => null) as string | null
    if (registry === null) error = `找不到登錄表 ${config.registryPath}；依 README 建立（範例 workflow/projects-scope.example.md），或 /console demo 先看示範`
    const registryRows = parseRegistry(registry ?? '', home).map(row => ({ row, root: projectRoot(row.statusPath) }))
    const effective = registryRows.map(({ row, root }) => effectiveDispatch(settings, root, row.executor))
    const codexInUse = settings.executor === 'codex' || effective.some(item => item.executor === 'codex')
    if (force || now - lastSlow > SLOW_MS) {
      const probes = await guarded(() => slowProbes(io, config, codexInUse, home))
      codex = probes.codex
      codexQuotaText = probes.quotaText
      agents = probes.agents
      if (probes.companion) companion = probes.companion
      lastSlow = now
    }
    const run: ExecutorDeps['run'] = (argv, init) => guarded(() => $.process.run(argv, init))
    const deps: ExecutorDeps = {
      run,
      files: {
        read: path => guarded(() => $.fs.read(path)), list: path => guarded(() => $.fs.list(path)), write: (path, text) => guarded(() => $.fs.write(path, text)),
        stat: path => guarded(() => $.fs.stat(path)),
      },
      now: () => guarded(() => $.clock.now()),
      agents: sharedAgents(run),
    }
    stateFormatIssues.clear()
    const gitMode = gitProbeMode((options as any).gitProbe)
    const pullRequest = async (root: string, branch: string, at: number, forced: boolean): Promise<PrInfo | null> => {
      const cached = prCache.get(root)
      const live = !!cached?.pr && cached.pr.state === 'OPEN' && cached.pr.checks.pending > 0
      if (cached && cached.branch === branch && !forced && at - cached.at < (live ? TICK_MS - 5_000 : SLOW_MS)) return cached.pr
      // gh missing or timed out: keep the last answer and ask again on the slow interval.
      const r: any = await io.process.run(prViewArgs(), { cwd: root, timeoutMs: 20_000 })
        .catch((error: unknown) => { if (error === DISCARDED_REFRESH) throw error; return undefined })
      const pr = r === undefined ? (cached?.branch === branch ? cached.pr : null) : r.exitCode === 0 ? parsePrView(String(r.stdout ?? '')) : null
      prCache.set(root, { at, branch, pr })
      return pr
    }
    const bases = registryRows.map(({ root }) => root.replace(/\/+$/, '').split('/').pop() ?? '')
    const roots = registryRows.map(({ root }) => root)
    // Projects are independent: read them a few at a time instead of one after another.
    const loaded = await mapLimit(registryRows, REFRESH_CONCURRENCY, async ({ row, root }, index) => {
      const eff = effective[index]!
      const listing: ExecutorKind = eff.executor === 'manual' ? settings.executor : eff.executor
      const [card, jobs, git] = await Promise.all([
        io.fs.read(row.statusPath).catch(() => null) as Promise<string | null>,
        guarded(() => workspaceJobs(listing, deps, withCompanion(config), root)),
        gitMode === 'off' ? null : io.process.run(gitStatusArgs(root), { timeoutMs: 10_000 })
          .then((r: any) => r.exitCode === 0 ? parseGitStatus(String(r.stdout ?? '')) : null)
          .catch((error: unknown) => { if (error === DISCARDED_REFRESH) throw error; return null }),
      ])
      const pr = git && gitMode === 'on' && git.branch ? await pullRequest(root, git.branch, now, force) : null
      const warnings = jobs.filter(job => job.warning).map(job => `${row.name}：${job.warning}`)
      const project: Project = {
        ...buildProject(row, card, jobs, now), executor: eff.executor, executorSource: eff.source,
        ...(row.executor ? { registryExecutor: row.executor } : {}),
        ...(git ? { git } : {}), ...(pr ? { pr } : {}),
      }
      await Promise.all(project.jobs.filter(j => j.kind === 'running').map(async j => {
        const job = jobs.find(item => item.id === j.id && item.executor === j.executor)
        if (job) j.last = await createExecutor(job.executor ?? listing, deps, withCompanion(config)).lastLine(job).catch(() => '')
      }))
      return { project, warnings }
    })
    const projects = loaded.map(item => item.project)
    const warnings = loaded.flatMap(item => item.warnings)
    const usage: any = await io.session.usage().catch(() => null)
    const formatWarning = stateFormatWarning()
    const companionWarning = [companion?.warning, formatWarning].filter(Boolean).join('；')
    const cur: Snapshot = {
      at: now, executor: settings.executor, projects, blocked: relevantBlocked(agents, await io.session.id().catch(() => null) as string | null, roots, home), codex: codexInUse ? relevantCodex(codex, bases) : '',
      ...(codexInUse ? { codexInUse: true } : {}),
      ...(codexInUse && (companion || formatWarning) ? { companion: { path: companion?.path ?? '', source: companion?.source ?? 'none', ...(companionWarning ? { warning: companionWarning } : {}) } } : {}),
      contextPercent: usage?.context?.percent ?? null, error,
      ...(typeof usage?.cost?.usd === 'number' ? { costUsd: usage.cost.usd } : {}),
      codexQuota: parseCodexQuota(codexQuotaText, now),
      limits: (usage?.rateLimits ?? []).map((l: any) => ({ kind: String(l.kind), percent: Number(l.percentUsed) || 0, ...(l.resetsAt ? { resetsAt: String(l.resetsAt) } : {}) })),
    }
    if (executorSignature((await readDispatch(io, config)).settings) !== refreshingExecutor) { owner.queued = true; return }
    await publishDisplay(async () => {
      if (!current()) return
      const prev = await guarded(() => read($, snapshot))
      const previousFeed = await guarded(() => read($, feedAtom))
      const sameExecutor = !prev?.demo && prev?.executor === cur.executor ? prev : null
      const newWarnings = warnings.filter(text => !previousFeed.some(event => event.text === text))
      const fresh = [...newWarnings.map(text => ({ at: now, text, tone: 'red' as const })), ...events(sameExecutor, cur)]
      if (fresh.length) await guarded(() => update($, feedAtom, list => current() ? [...fresh, ...list].slice(0, 20) : list))
      await guarded(() => update($, snapshot, latest => {
        if (!current()) return latest
        if (startingGeneration === launchGeneration || !latest) return trackRowChanges(latest, cur, now)
        // A refresh already in flight must not erase a dispatch accepted after it started.
        return trackRowChanges(latest, { ...cur, projects: cur.projects.map(project => {
          const recent = latest.projects.find(item => item.statusPath === project.statusPath)
          const missing = recent?.jobs.filter(job => acceptedLaunches.has(job.id) && !project.jobs.some(item => item.id === job.id && item.executor === job.executor)) ?? []
          const ids = new Set(missing.map(job => job.id))
          return missing.length ? { ...project, jobs: [...missing, ...project.jobs], tasks: [...(recent?.tasks ?? []).filter(task => ids.has(task.id)), ...(project.tasks ?? [])] } : project
        }) }, now)
      }))
      for (const text of [...newWarnings, ...diffToasts(sameExecutor, cur)]) {
        if (!current()) return
        $.ui.toast(text, { timeoutMs: 8000 })
      }
    })
    if (current()) {
      await advanceSyncs($, options)
      await autoSync($, options)
    }
  } catch (error) {
    if (!current() || error === DISCARDED_REFRESH) return
    if (refreshConfig && executorSignature((await readDispatch(io, refreshConfig)).settings) !== refreshingExecutor) { owner.queued = true; return }
    if (!current()) return
    const message = `執行者狀態讀取失敗：${error instanceof Error ? error.message : String(error)}`
    await publishDisplay(async () => {
      if (!current()) return
      await update($, snapshot, previous => !current() ? previous : previous ? { ...previous, error: message } : { at: 0, projects: [], blocked: [], codex: '', contextPercent: null, error: message })
      if (current()) $.ui.toast(message, { timeoutMs: 8000 })
    })
  } finally {
    if (refreshOwner === owner) {
      refreshOwner = null
      if (owner.queued && current()) void refresh($, options, true)
    }
  }
}

async function openPane($: any) {
  await $.ui.open({ id: PANE, title: '主控台' })
  await update($, isPaneOpen, () => true)
}

async function actionNotice($: any, text: string, ok: boolean) {
  const generation = dataGeneration
  if (await demoEnabled($)) return
  const at = await $.clock.now()
  await publishDisplay(async () => {
    if (generation !== dataGeneration || await demoEnabled($)) return
    await update($, feedAtom, list => [{ at, text, tone: ok ? 'green' : 'red' } as const, ...list].slice(0, 20))
    if (generation === dataGeneration && !demoActive) $.ui.toast(text, { timeoutMs: 8000 })
  })
}

/** All entry points share this lock and re-check the latest state, including stale rendered buttons. */
type ModeChoice = 'auto' | 'console' | 'project'
async function projectModeOn($: any, options: PluginOptions): Promise<boolean> {
  const choice = await read($, modeOverride) as ModeChoice
  if (choice === 'console') return false
  if (choice === 'project') return true
  return String((options as any).projectMode ?? 'auto') !== 'off'
}

/** Project mode's project and its pipeline, or null (mode off, demo, no match). */
async function focused($: any, options: PluginOptions, s: Snapshot | null): Promise<{ project: Project; pipeline: Pipeline } | null> {
  if (!s || s.demo || !(await projectModeOn($, options))) return null
  const project = projectForCwd(s.projects, sessionCwd, projectRoot)
  if (!project) return null
  return { project, pipeline: pipeline(project, (await read($, verificationResults))[project.statusPath]) }
}

async function loadTrust($: any): Promise<Record<string, string>> {
  const value = await Promise.resolve().then(() => $.store.get(TRUST_KEY)).catch(() => undefined)
  if (value === undefined) return read($, trustedVerify)
  const trusted = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
  await update($, trustedVerify, () => trusted)
  return trusted
}

/** First press arms a confirmation for `signature`; returns true only for a matching press inside the window. */
async function confirmed($: any, statusPath: string, signature: string, now: number, windowMs: number, message: string): Promise<boolean> {
  const confirmations = await read($, continueConfirmations)
  if (confirmationMatches(confirmations[statusPath], signature, now, windowMs)) return true
  await update($, continueConfirmations, values => ({ ...values, [statusPath]: { at: now, signature } }))
  $.ui.toast(message, { timeoutMs: windowMs })
  $.clock.after(windowMs, () => void update($, continueConfirmations, values => {
    if (values[statusPath]?.at !== now) return values
    const next = { ...values }; delete next[statusPath]; return next
  }))
  return false
}

async function triggerAction($: any, options: PluginOptions, statusPath: string, kind: ActionKind, request: { useClaude?: boolean; auto?: boolean } = {}) {
  if (await demoEnabled($)) {
    $.ui.toast('示範資料：不執行專案操作；/console refresh 回到實際資料。')
    return
  }
  if (actionLocks.has(statusPath)) return
  actionLocks.add(statusPath)
  let timer: { cancel(): void } | undefined
  let project: Project | undefined
  let ownsPending = false
  let keepPending = false
  try {
    if ((await read($, pendingActions))[statusPath]) return
    const current = await read($, snapshot)
    project = current?.projects.find(p => p.statusPath === statusPath)
    if (project && (kind === 'sync' || kind === 'continue') && dispatchBlockReason(project)) throw new Error(dispatchBlockReason(project))
    const state = current && project ? rows(current).find(r => r.full === project?.name)?.state : undefined
    if (!project || !state || !actionKinds(project, state).includes(kind)) {
      await actionNotice($, '狀態已變更，請依面板目前的動作操作。', false)
      return
    }
    const p = project
    if ((kind === 'sync' || kind === 'continue') && current?.error) throw new Error('請先成功更新執行者狀態，再派工。')
    const name = p.name.replace(/\s.*$/, '')
    const now = await $.clock.now()
    if (kind === 'continue' && !request.useClaude) {
      if (!await confirmed($, statusPath, workSignature(p), now, CONTINUE_CONFIRM_MS,
        `${name}：${CONTINUE_CONFIRM_MS / 1000} 秒內再按一次派工：${p.next}`)) return
    }
    if (kind === 'verify') {
      const trusted = await loadTrust($)
      if (!verifyTrusted(trusted, statusPath, p.verify)) {
        const why = trusted[statusPath] === undefined ? '首次執行此驗證指令' : '驗證指令已變更'
        if (!await confirmed($, statusPath, verifySignature(p.verify), now, VERIFY_CONFIRM_MS,
          `${name}：${why}，確認後 ${VERIFY_CONFIRM_MS / 1000} 秒內再按一次執行：${p.verify}`)) return
        const approved = { ...trusted, [statusPath]: p.verify }
        await update($, trustedVerify, () => approved)
        // Not remembered across sessions when the store refuses; the confirmed run still goes ahead.
        await Promise.resolve().then(() => $.store.set(TRUST_KEY, approved)).catch(() => {})
      }
    }
    await update($, continueConfirmations, values => { const next = { ...values }; delete next[statusPath]; return next })
    $.ui.toast(`${name}：${actionLabel(kind, p)}…`, { timeoutMs: 3000 })
    await update($, pendingActions, values => ({ ...values, [statusPath]: { kind, at: now } }))
    ownsPending = true
    if (kind === 'sync') await setSync($, statusPath, { stage: 'dispatch', at: now, cardAt: p.updated, ...(request.auto ? { auto: true } : {}) })
    // Once a second: the label shows elapsed seconds; terminal/desktop animate a client spinner beside it,
    // so the whole pane is not redrawn several times a second (or sent to a phone that often).
    timer = $.clock.every(1000, async () => {
      if (!(await read($, pendingActions))[statusPath]) { timer?.cancel(); return }
      await update($, actionPulse, value => value + 1)
    })
    const { home, config } = await paths($, options)
    const root = projectRoot(p.statusPath)
    if (kind === 'verify') {
      let result: VerificationResult
      try {
        const windows = /^[a-z]:\//i.test(root) || root.startsWith('//') || (await $.env.get('OS')) === 'Windows_NT'
        const run = await $.process.run(verificationArgs(p.verify, windows), { cwd: root, timeoutMs: 300_000 })
        result = verificationResult(p.verify, await $.clock.now(), run)
      } catch (error) {
        result = { command: p.verify, at: await $.clock.now(), ok: false, exitCode: null, lines: outputTail(String(error)), truncated: false }
      }
      await update($, verificationResults, values => ({ ...values, [statusPath]: result }))
      await actionNotice($, `${name}：${result.ok ? '✓ 驗證通過' : '✕ 驗證失敗'}${result.exitCode === null ? '（逾時或無法執行）' : `（exit ${result.exitCode}）`}`, result.ok)
    } else if (kind === 'sync' || kind === 'continue') {
      const { settings } = await readDispatch($, config)
      const eff = effectiveDispatch(settings, root, p.registryExecutor)
      if ((p.executor ?? current?.executor) && (p.executor ?? current?.executor) !== eff.executor) throw new Error('執行者已變更，請更新面板後再操作。')
      if (eff.executor === 'manual') throw new Error('此專案設為 manual：面板不派工，請手動交接。')
      const deps: ExecutorDeps = {
        run: (argv, init) => $.process.run(argv, init),
        files: { read: path => $.fs.read(path), list: path => $.fs.list(path), write: (path, text) => $.fs.write(path, text) },
        now: () => $.clock.now(),
      }
      if (eff.executor === 'codex' && !companion?.path && !config.companionScript) companion = await resolveCompanion({ read: (path: string) => $.fs.read(path), list: (path: string) => $.fs.list(path) }, home, config.companionScript).catch(() => null)
      const execConfig = withCompanion(config)
      // Claude stand-in for Codex uses the global model/effort only when they are Claude's own.
      const claudeOpts = { model: settings.executor === 'claude' ? settings.model : '', effort: settings.executor === 'claude' ? settings.effort : '' }
      let chosen: ExecutorKind = eff.executor
      let dispatchOpts: DispatchOptions = { model: eff.model, effort: eff.effort, kind }
      const offer = (await read($, fallbackOffers))[statusPath]
      if (eff.executor === 'codex' && request.useClaude) {
        chosen = 'claude'
        dispatchOpts = { ...claudeOpts, kind, fallbackFrom: 'codex', fallbackReason: offer?.reason ?? '使用者選擇改用 Claude' }
      } else if (eff.executor === 'codex') {
        const fallback = resolveFallbackOptions(options)
        const base = root.replace(/\/+$/, '').split('/').pop() ?? ''
        const decision = decideCodexDispatch({
          mode: fallback.codexFallback, minPercent: fallback.codexMinQuotaPercent, quota: current?.codexQuota,
          preflight: relevantCodex(codex, [base]), companionPath: execConfig.companionScript, now,
        })
        if (decision.action === 'ask') {
          await update($, fallbackOffers, values => ({ ...values, [statusPath]: { kind, reason: decision.reason, at: now } }))
          throw new Error(`Codex 未派工：${decision.reason}。可按「改用 Claude 派工」。`)
        }
        if (decision.action === 'claude') {
          chosen = 'claude'
          dispatchOpts = { ...claudeOpts, kind, fallbackFrom: 'codex', fallbackReason: decision.reason }
        }
      }
      const jobs = await workspaceJobs(chosen, deps, execConfig, root)
      const protection = buildProject({ name: p.name, statusPath }, null, jobs, now)
      const reason = dispatchBlockReason(protection)
      if (reason) {
        await refresh($, options, true)
        throw new Error(reason)
      }
      const executor = createExecutor(chosen, deps, execConfig)
      const job = await executor.dispatch(root, dispatchPrompt(p, kind), dispatchOpts)
      await update($, fallbackOffers, values => { if (!values[statusPath]) return values; const next = { ...values }; delete next[statusPath]; return next })
      if (isActiveJob(job)) unpublishedLaunches.set(`${workspaceKey(root)}:${jobKey(job)}`, { root: workspaceKey(root), job })
      const acceptedAt = await $.clock.now()
      const id = job.id
      const startedAt = new Date(acceptedAt).toISOString()
      acceptedLaunches.add(id)
      launchGeneration++
      await update($, snapshot, value => value ? trackRowChanges(value, { ...value, projects: value.projects.map(item => item.statusPath === statusPath ? {
        ...item,
        jobs: [{ kind: 'running' as const, id, executor: chosen, status: 'queued', summary: actionLabel(kind, p), startedAt, phase: '等待任務狀態' }, ...item.jobs.filter(j => j.id !== id || j.executor !== chosen)],
        tasks: [{ id, executor: chosen, ...(dispatchOpts.fallbackFrom ? { fallbackFrom: dispatchOpts.fallbackFrom } : {}), status: 'queued', title: actionLabel(kind, p), model: dispatchOpts.model ?? '', effort: dispatchOpts.effort ?? '', startedAt }, ...(item.tasks ?? []).filter(t => t.id !== id)],
      } : item) }, acceptedAt) : value)
      if (kind === 'sync') {
        await update($, syncProgress, values => values[statusPath]?.stage !== 'dispatch' ? values
          : { ...values, [statusPath]: { ...values[statusPath]!, stage: 'running', executor: chosen, jobId: id, phase: 'queued' } })
        void scheduleFastTick($, options)
      }
      const fallbackNote = dispatchOpts.fallbackFrom ? `（Codex 改由 Claude：${dispatchOpts.fallbackReason}）` : ''
      await actionNotice($, `${name}：${chosen} 已接受${kind === 'sync' ? '同步 STATUS' : '繼續下一步'}${fallbackNote}，等待執行結果`, true)
    } else if (kind === 'decide') {
      const filled = await $.prompt.fill({ text: `「${p.name}」決策：`, mode: 'replace' })
      if (!filled.isFilled) throw new Error(filled.refusal === 'no_composer' ? '此介面沒有可預填的輸入框；請在主控台輸入決策。' : '輸入框目前無法預填，請關閉對話框後重試。')
      await update($, selected, () => p.name)
      // Removing the focused pane returns keyboard input to the filled composer.
      await $.ui.close({ id: PANE }).catch(() => {})
      await update($, isPaneOpen, () => false)
      await actionNotice($, `${name}：決策草稿已預填，請補完後送出`, true)
    } else if (kind === 'gate') {
      const context = selectionContext(current, p.name)
      // PromptSubmitArgs has no context field, and calls from this plugin skip its own hook.
      // Carry the same selection block in the submitted text without consuming a user's draft selection.
      const text = `${gatePrompt(p)}\n\n${context ?? ''}`
      await update($, reviewRequests, values => ({ ...values, [statusPath]: { text, projectName: p.name, at: now } }))
      try {
        const result = await $.prompt.submit({ text })
        if (result.drop) throw new Error(result.drop)
        let turnId: string | undefined
        for (const [id, startedText] of earlyReviewStarts) {
          if (startedText === result.text) { turnId = id; break }
        }
        await update($, reviewRequests, values => {
          const request = values[statusPath]
          if (!request) return values
          turnId = request.turnId ?? turnId
          return { ...values, [statusPath]: { ...request, text: result.text, ...(turnId ? { turnId } : {}) } }
        })
        if (turnId) earlyReviewStarts.delete(turnId)
        keepPending = true
      } catch (error) {
        await update($, reviewRequests, values => { const next = { ...values }; delete next[statusPath]; return next })
        throw error
      }
      await actionNotice($, `${name}：關卡已送交主控台審核${parseGate(p.gate)?.kind === 'release' ? '，正式執行仍待你決定' : ''}`, true)
    } else {
      const opened = await $.process.run(['code', p.statusPath], { timeoutMs: 15_000 }).catch(() => null)
      if (!opened || opened.exitCode !== 0) {
        const fallback = await $.process.run(openFallbackArgs(p.statusPath, isWindowsOs(await $.env.get('OS'))), { timeoutMs: 15_000 })
        if (fallback.exitCode !== 0) throw new Error(`無法開啟 STATUS.md（exit ${fallback.exitCode}）`)
      }
      await actionNotice($, `${name}：已請求開啟 STATUS.md`, true)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (kind === 'sync') {
      const endedAt = await $.clock.now()
      await update($, syncProgress, values => values[statusPath]?.stage !== 'dispatch' ? values
        : { ...values, [statusPath]: { ...values[statusPath]!, stage: 'dispatch-failed', endedAt, detail: message } })
    }
    await actionNotice($, `${project?.name ?? statusPath}：✕ ${message}`, false)
  } finally {
    if (!keepPending) timer?.cancel()
    try {
      if (ownsPending && !keepPending) await update($, pendingActions, values => { const next = { ...values }; delete next[statusPath]; return next })
    } finally { actionLocks.delete(statusPath) }
  }
}

async function setSync($: any, statusPath: string, track: SyncProgress) {
  await update($, syncProgress, values => ({ ...values, [statusPath]: track }))
}

/** After a refresh: move each sync along, say when one ends, and keep the fast tick while anything runs. */
async function advanceSyncs($: any, options: PluginOptions) {
  const s = await read($, snapshot)
  if (!s || s.demo) return
  const ended: { name: string; track: SyncProgress }[] = []
  await update($, syncProgress, values => {
    const next: Record<string, SyncProgress> = {}
    for (const [path, track] of Object.entries(values)) {
      const project = s.projects.find(p => p.statusPath === path)
      const moved = advanceSync(track, project, s.at)
      if (!moved) continue
      if (project && !isSyncEnded(track.stage) && isSyncEnded(moved.stage)) ended.push({ name: project.name.replace(/\s.*$/, ''), track: moved })
      next[path] = moved
    }
    return next
  })
  for (const { name, track } of ended) await actionNotice($, `${name}：${syncStatus(track, s.at)}`, track.stage === 'done')
  await scheduleFastTick($, options)
}

/** Refresh every 20 s while a job or a sync is under way; back to the minute tick once all are done. */
async function scheduleFastTick($: any, options: PluginOptions) {
  const s = await read($, snapshot)
  const syncing = Object.values(await read($, syncProgress)).some(track => !isSyncEnded(track.stage))
  const busy = consoleActive && !s?.demo && (syncing || !!s?.projects.some(p => p.jobs.some(j => j.kind === 'running')))
  if (busy && !fastTimer) fastTimer = $.clock.every(FAST_TICK_MS, () => void refresh($, options))
  if (!busy && fastTimer) { fastTimer.cancel(); fastTimer = undefined }
}

/**
 * `autoSync: on`: a project in 待同步 whose finished work left the CARD behind gets one sync
 * dispatched by itself, once per job. Nothing is retried: a sync that fails or writes nothing waits for a person.
 */
async function autoSync($: any, options: PluginOptions) {
  if (autoSyncMode((options as any).autoSync) === 'off' || !consoleActive || await demoEnabled($)) return
  const s = await read($, snapshot)
  if (!s || s.demo || s.error) return
  const pending = await read($, pendingActions)
  const tracks = await read($, syncProgress)
  const stored: unknown = await Promise.resolve().then(() => $.store.get(AUTO_SYNCED_KEY)).catch(() => null)
  const done = new Set([...(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []), ...autoSynced])
  for (const row of rows(s)) {
    if (row.state !== 'SYNC') continue
    const p = s.projects.find(item => item.name === row.full)
    if (!p || pending[p.statusPath] || actionLocks.has(p.statusPath)) continue
    const track = tracks[p.statusPath]
    if (track && !isSyncEnded(track.stage)) continue
    const jobs = autoSyncJobs(p)
    if (!jobs.some(job => !done.has(job))) continue
    for (const job of jobs) { done.add(job); autoSynced.add(job) }
    while (autoSynced.size > AUTO_SYNCED_MAX) autoSynced.delete(autoSynced.values().next().value as string)
    const kept = [...done].slice(-AUTO_SYNCED_MAX)
    // Remembered before dispatching, so another console session (or the next refresh) does not send it twice.
    await Promise.resolve().then(() => $.store.set(AUTO_SYNCED_KEY, kept)).catch(() => {})
    await triggerAction($, options, p.statusPath, 'sync', { auto: true })
  }
}

/** The TTL in force and where it came from: the option, else what usage showed or an idle gap proved (remembered across sessions), else 5m. */
async function cacheTtlFor($: any, options: PluginOptions, learned: CacheTtl | null): Promise<{ ttl: CacheTtl; source: TtlSource }> {
  const option = cacheTtlOption((options as any).cacheTtl)
  if (option !== 'auto') return { ttl: option, source: 'option' }
  const stored: any = await Promise.resolve().then(() => $.store.get(CACHE_TTL_KEY)).catch(() => null)
  // What usage reported outranks a guess from an idle gap.
  if (stored && typeof stored === 'object' && stored.source === 'usage' && (stored.ttl === '5m' || stored.ttl === '1h')) return { ttl: stored.ttl, source: 'usage' }
  if (learned) {
    await Promise.resolve().then(() => $.store.set(CACHE_TTL_KEY, learned)).catch(() => {})
    return { ttl: learned, source: 'learned' }
  }
  return stored === '1h' || stored === '5m' ? { ttl: stored, source: 'learned' } : { ttl: '5m', source: 'default' }
}

/** The transcript's tail: whole when it fits a read, else its last lines through the shell. */
async function transcriptTail($: any, path: string): Promise<string | null> {
  const text = await Promise.resolve().then(() => $.fs.read(path)).catch(() => null)
  if (typeof text === 'string') return text
  const stat: any = await Promise.resolve().then(() => $.fs.stat(path)).catch(() => null)
  if (!stat) return null
  const args = isWindowsOs(await $.env.get('OS'))
    ? ['powershell', '-NoProfile', '-Command', `Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Tail 400 -Encoding UTF8`]
    : ['tail', '-n', '400', path]
  const r: any = await $.process.run(args, { timeoutMs: 10_000 }).catch(() => null)
  return r && r.exitCode === 0 ? String(r.stdout ?? '') : null
}

/**
 * Reads the TTL actually in force from the transcript's usage (`cache_creation` by TTL) and remembers it;
 * with `seed`, a console that has no clock yet (just installed or reloaded) starts from the last response.
 */
async function syncCacheFromTranscript($: any, options: PluginOptions, seed: boolean) {
  if (!transcriptPath || demoActive) return
  const text = await transcriptTail($, transcriptPath)
  const found = text ? transcriptCache(text) : null
  if (!found) return
  const auto = cacheTtlOption((options as any).cacheTtl) === 'auto'
  if (found.ttl && auto) await Promise.resolve().then(() => $.store.set(CACHE_TTL_KEY, { ttl: found.ttl, source: 'usage' })).catch(() => {})
  const clock = await read($, cacheClock)
  if (!clock) {
    if (!seed || await read($, isTurnRunning)) return
    const { ttl, source } = found.ttl && auto ? { ttl: found.ttl, source: 'usage' as const } : await cacheTtlFor($, options, null)
    await update($, cacheClock, value => value ?? ({ at: found.at, tokens: found.tokens, model: found.model, ttl, source }) as CacheClock)
  } else if (found.ttl && auto && (clock.ttl !== found.ttl || clock.source !== 'usage')) {
    await update($, cacheClock, value => value ? ({ ...value, ttl: found.ttl!, source: 'usage' }) as CacheClock : value)
  }
}

/** Redraws the countdown and warns once, shortly before the cache goes cold. */
async function cacheTickOnce($: any, options: PluginOptions) {
  const clock = await read($, cacheClock)
  if (!clock) return
  const now = await $.clock.now()
  const view = cacheView(clock, now, await read($, isTurnRunning), priceOverride((options as any).cacheWritePrice))
  if (!view) return
  // Keep redrawing while warm and for an hour after, then stop touching state; seconds in the last minute.
  const lastMinute = view.warm && view.leftMs <= CACHE_WARN_MS + 1000
  if (view.coldForMs < 60 * 60_000 && (lastMinute || now - cacheDrawnAt >= 15_000 || now < cacheDrawnAt)) {
    cacheDrawnAt = now
    await update($, cacheTick, v => v + 1)
  }
  if (view.warm && view.leftMs <= CACHE_WARN_MS && cacheWarnedFor !== clock.at && cacheMode(options) !== 'off') {
    cacheWarnedFor = clock.at
    $.ui.toast(cacheWarning(clock, view), { timeoutMs: 10_000 })
  }
}

/** `cacheHint`: `on` (chip, pane line, toasts) or `off`. */
const cacheMode = (options: PluginOptions) => String((options as any).cacheHint ?? 'on').trim().toLowerCase() === 'off' ? 'off' : 'on'

/** Opens a project's pull request in the browser: `gh pr view --web`, else the OS URL handler. */
async function openPullRequest($: any, p: Project) {
  if (!p.pr) return
  const name = p.name.replace(/\s.*$/, '')
  const opened = await $.process.run(['gh', 'pr', 'view', String(p.pr.number), '--web'], { cwd: projectRoot(p.statusPath), timeoutMs: 15_000 }).catch(() => null)
  if (!opened || opened.exitCode !== 0) {
    const fallback = p.pr.url ? await $.process.run(openFallbackArgs(p.pr.url, isWindowsOs(await $.env.get('OS'))), { timeoutMs: 15_000 }).catch(() => null) : null
    if (!fallback || fallback.exitCode !== 0) { $.ui.toast(`${name}：無法開啟 PR #${p.pr.number}${p.pr.url ? `（${p.pr.url}）` : ''}`, { timeoutMs: 8000 }); return }
  }
  $.ui.toast(`${name}：已開啟 PR #${p.pr.number}`, { timeoutMs: 3000 })
}

/** Reads the installed manifest and the marketplace's latest one; toasts once per new version. */
function checkUpdate($: any, force = false): Promise<UpdateInfo | null> {
  if (updateCheck) return updateCheck
  updateCheck = (async () => {
    const prev = await read($, updateInfo)
    if (prev?.phase === 'updating') return prev
    const now = await $.clock.now()
    if (!force && prev && prev.phase === 'idle' && !prev.error && now - prev.checkedAt < UPDATE_CHECK_MS - 60_000) return prev
    await update($, updateInfo, value => ({ current: value?.current ?? null, latest: value?.latest ?? null, checkedAt: value?.checkedAt ?? 0, phase: 'checking' }) as UpdateInfo)
    const current = manifestVersion(await Promise.resolve().then(() => $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)).catch(() => null))
    let latest: string | null = null
    let error: string | undefined
    try {
      const response = await $.http.fetch(LATEST_MANIFEST_URL, { headers: { 'cache-control': 'no-cache' } })
      latest = response.ok ? manifestVersion(response.text) : null
      if (!latest) error = response.ok ? '回應不是 plugin.json' : `HTTP ${response.status}`
    } catch { error = '連不上 GitHub' }
    const info: UpdateInfo = { current, latest, checkedAt: now, phase: 'idle', ...(error ? { error } : {}) }
    await update($, updateInfo, () => info)
    if (hasUpdate(info)) {
      const notified = await Promise.resolve().then(() => $.store.get(UPDATE_NOTIFIED_KEY)).catch(() => null)
      if (notified !== info.latest) {
        $.ui.toast(`console-status 有新版 v${info.latest}（目前 v${info.current}）：/console 面板按「⬆ 更新」或輸入 /console update`, { timeoutMs: 10_000 })
        await Promise.resolve().then(() => $.store.set(UPDATE_NOTIFIED_KEY, info.latest)).catch(() => {})
      }
    }
    return info
  })().finally(() => { updateCheck = null })
  return updateCheck
}

type RunResult = { exitCode: number; stdout: string; stderr: string }
const runQuiet = ($: any, argv: string[], timeoutMs: number): Promise<RunResult> => Promise.resolve()
  .then(() => $.process.run(argv, { timeoutMs }))
  .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
const lastLine = (r: RunResult) => outputTail(r.stdout, r.stderr).at(-1)?.slice(0, 160) || `結束碼 ${r.exitCode}`

/**
 * Brings the new version to where console-status is loaded from. A plugin read from a local folder
 * (a directory marketplace or `--plugin-dir`, e.g. a git clone) is updated by `git pull --ff-only`
 * there: `claude plugin update` only re-reads that folder. Otherwise the marketplace is refreshed
 * and the plugin updated. Resolves to an error message, or null when a newer version is in place.
 */
async function installUpdate($: any, latest: string | null): Promise<string | null> {
  const list = await runQuiet($, pluginListArgs(), 60_000)
  const folder = localFolder(list.exitCode === 0 ? list.stdout : null, $.plugin.root)
  if (folder) {
    const top = await runQuiet($, gitTopArgs(folder), 15_000)
    const repo = top.exitCode === 0 ? top.stdout.trim().replace(/\\/g, '/') : ''
    if (!repo) return `外掛從本機資料夾 ${folder} 載入，但它不是 git 儲存庫；請手動更新該資料夾`
    const pull = await runQuiet($, gitPullArgs(repo), 120_000)
    if (pull.exitCode !== 0) return `在 ${repo} 執行 git pull 失敗：${lastLine(pull)}`
    const now = manifestVersion(await Promise.resolve().then(() => $.fs.read(`${folder}/.claude-plugin/plugin.json`)).catch(() => null))
    if (latest && (!now || compareVersions(now, latest) < 0)) {
      const branch = (await runQuiet($, gitBranchArgs(repo), 15_000)).stdout.trim()
      return `已在 ${repo} 執行 git pull，但資料夾仍是 v${now ?? '?'}${branch ? `（目前分支 ${branch}，新版在 main）` : ''}`
    }
    // Records the folder's new version for `claude plugin list`; the folder is what loads either way.
    await runQuiet($, updateArgs(), 120_000)
    return null
  }
  // Best effort: a marketplace added under another name is still refreshed by the update itself.
  await runQuiet($, marketplaceUpdateArgs(), 120_000)
  const result = await runQuiet($, updateArgs(), 180_000)
  if (result.exitCode !== 0) return lastLine(result)
  const outcome = updateOutcome(result.stdout)
  if (outcome && !outcome.updated) return `沒有安裝新版：${outcome.message.slice(0, 160) || '已是 marketplace 上的最新版'}`
  return null
}

/** Installs the new version, then `/reload-plugins` so it runs in this session. */
async function runUpdate($: any): Promise<string> {
  const before = await read($, updateInfo)
  if (before?.phase === 'updating') return '更新進行中。'
  const target = before?.latest ? `v${before.latest}` : '最新版'
  await update($, updateInfo, value => ({ current: value?.current ?? null, latest: value?.latest ?? null, checkedAt: value?.checkedAt ?? 0, phase: 'updating' }) as UpdateInfo)
  const failure = await installUpdate($, before?.latest ?? null).catch((error: unknown) => error instanceof Error ? error.message : String(error))
  if (failure) {
    await update($, updateInfo, value => value && ({ ...value, phase: 'failed', message: failure }) as UpdateInfo)
    $.ui.toast(`console-status 更新失敗：${failure}`, { timeoutMs: 12_000 })
    return `更新失敗：${failure}`
  }
  await update($, updateInfo, value => value && ({ ...value, phase: 'updated' }) as UpdateInfo)
  $.ui.toast(`console-status 已更新到 ${target}，正在重新載入外掛…`, { timeoutMs: 6000 })
  const notReloaded = async (message: string) => {
    try {
      await update($, updateInfo, value => value && ({ ...value, phase: 'failed', message }) as UpdateInfo)
      $.ui.toast(`console-status ${target} ${message}`, { timeoutMs: 12_000 })
    } catch { /* unloaded meanwhile */ }
  }
  // Out of the calling hook (a slash command's turn waits on it, and a run inside it is refused).
  // `--force`: the interactive reload otherwise holds when it would cost the prompt cache.
  $.clock.after(RELOAD_DELAY_MS, async () => {
    try { await $.command.run({ command: 'reload-plugins', args: '--force' }) } catch { await notReloaded('已安裝，請輸入 /reload-plugins 套用') }
  })
  // A reload replaces this module and cancels its timers, so this fires only when none happened.
  $.clock.after(RELOAD_WATCHDOG_MS, () => void notReloaded('已安裝但尚未重新載入：請輸入 /reload-plugins，或開新 session'))
  return `已更新到 ${target}，正在重新載入外掛；若沒有自動套用，請輸入 /reload-plugins。`
}

/** Action-menu hotkeys: one letter per action, shown in the menu; only actions on offer respond. */
const HOTKEYS: Record<string, ActionKind> = { v: 'verify', s: 'sync', c: 'continue', d: 'decide', g: 'gate', o: 'open' }
const HOTKEY_OF: Partial<Record<ActionKind, string>> = Object.fromEntries(Object.entries(HOTKEYS).map(([k, kind]) => [kind, k]))

async function activeSessions($: any): Promise<string[]> {
  const value = await Promise.resolve().then(() => $.store.get(ACTIVE_SESSIONS_KEY)).catch(() => null)
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

async function rememberSession($: any, keep: boolean) {
  const id = await Promise.resolve().then(() => $.session.id()).catch(() => null)
  if (typeof id !== 'string' || !id) return
  const rest = (await activeSessions($)).filter(other => other !== id)
  const next = keep ? [...rest, id].slice(-ACTIVE_SESSIONS_MAX) : rest
  await Promise.resolve().then(() => $.store.set(ACTIVE_SESSIONS_KEY, next)).catch(() => {})
}

/** Starts the console in this session: the refresh and cache timers, the transcript read and the update check. */
async function startConsole($: any, options: PluginOptions, remember: boolean, refreshNow = true) {
  if (consoleActive) return
  consoleActive = true
  refreshTimer?.cancel()
  refreshTimer = $.clock.every(TICK_MS, () => void refresh($, options))
  cacheTimer?.cancel()
  cacheTimer = $.clock.every(1000, () => void cacheTickOnce($, options).catch(() => {}))
  // Until a classic hook names the transcript, find it where Claude Code keeps it.
  if (!transcriptPath) {
    const configDir = await $.env.get('CLAUDE_CONFIG_DIR') || `${await $.env.get('HOME') || await $.env.get('USERPROFILE') || ''}/.claude`
    const sessionId = await $.session.id().catch(() => null)
    if (sessionId && sessionStartCwd && !configDir.startsWith('/.claude')) transcriptPath = transcriptPathFor(configDir, sessionStartCwd, sessionId)
  }
  void syncCacheFromTranscript($, options, true).catch(() => {})
  if (refreshNow) void refresh($, options, true)
  updateTimer?.cancel()
  updateTimer = $.clock.every(UPDATE_CHECK_MS, () => void checkUpdate($).catch(() => {}))
  void checkUpdate($, true).catch(() => {})
  if (remember) await rememberSession($, true)
}

/** `/console off`: back to a light session; the guard stays. */
async function stopConsole($: any) {
  consoleActive = false
  dataGeneration++
  refreshTimer?.cancel(); refreshTimer = undefined
  fastTimer?.cancel(); fastTimer = undefined
  cacheTimer?.cancel(); cacheTimer = undefined
  updateTimer?.cancel(); updateTimer = undefined
  await rememberSession($, false)
  if (await read($, isPaneOpen)) {
    await $.ui.close({ id: PANE }).catch(() => {})
    await update($, isPaneOpen, () => false)
  }
  await update($, snapshot, () => null)
  await update($, selected, () => null)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    sessionCwd = typeof e.cwd === 'string' ? e.cwd.replace(/\\/g, '/') : null
    sessionStartCwd = typeof e.cwd === 'string' ? e.cwd : null
    lastProgress = ''
    dataGeneration++
    consoleActive = false
    refreshTimer?.cancel()
    fastTimer?.cancel(); fastTimer = undefined
    cacheTimer?.cancel()
    updateTimer?.cancel()
    if (actionLocks.size === 0) earlyReviewStarts.clear()
    selectionClaim = null
    await update($, reviewRequests, values => Object.fromEntries(Object.entries(values).filter(([path]) => actionLocks.has(path))))
    await update($, pendingActions, values => Object.fromEntries(Object.entries(values).filter(([path]) => actionLocks.has(path))))
    await update($, continueConfirmations, () => ({}))
    await update($, fallbackOffers, () => ({}))
    await loadTrust($)
    await $.command.register({ name: 'console', description: '主控台總覽：/console 開關面板；model / effort 派工設定；refresh 更新；band 橫帶；demo 示範；version 版本；update 更新外掛；off 此 session 不跑主控台' })
    transcriptPath = null
    // A reload after an update starts a fresh check, which reads the newly installed manifest.
    await update($, updateInfo, value => value && value.phase !== 'idle' ? { ...value, phase: 'idle', checkedAt: 0 } as UpdateInfo : value)
    // A light session (a quick side task, `claude -p`) gets the guard only: no polling, band or prompt additions.
    const id = await Promise.resolve().then(() => $.session.id()).catch(() => null)
    const resumed = typeof id === 'string' && (await activeSessions($)).includes(id)
    if (activationMode((options as any).activation) === 'always' || (resumed && e.isInteractive !== false)) await startConsole($, options, false)
    else await update($, snapshot, () => null)
    return next(e)
  })

  // Project mode: the CARD contract in the system prompt, stable for the session (cache-friendly).
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const here = await focused($, options, await read($, snapshot)).catch(() => null)
    if (!here) return result
    return { ...result, sections: [...result.sections, { id: 'console-status:project', text: projectModeSection(here.project), scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin' || !consoleActive) return next(e)
    if (cacheMode(options) === 'on') {
      // A prompt on a cold cache re-writes the whole context: say so, never hold the prompt.
      const clock = await read($, cacheClock).catch(() => null)
      const view = clock ? cacheView(clock, await $.clock.now(), false, priceOverride((options as any).cacheWritePrice)) : null
      if (clock && view && !view.warm) $.ui.toast(cacheWarning(clock, view), { timeoutMs: 8000 })
    }
    // Project mode: the pipeline position rides along with a prompt only when it changed.
    // A failure here must never hold the person's prompt back.
    const here = await focused($, options, await read($, snapshot)).catch(() => null)
    if (here) {
      const signature = progressSignature(here.project, here.pipeline)
      if (signature !== lastProgress) {
        lastProgress = signature
        e = { ...e, context: [...(e.context ?? []), progressContext(here.project, here.pipeline)] }
      }
    }
    const selectedProject = await read($, selected)
    if (!selectedProject || selectionClaim !== null) return next(e)
    const ctx = selectionContext(await read($, snapshot), selectedProject)
    if (!ctx) return next(e)
    selectionClaim = selectedProject
    try {
      const result = await next({ ...e, context: [...(e.context ?? []), ctx] })
      if (!result.drop) await update($, selected, value => value === selectedProject ? null : value)
      return result
    } finally {
      if (selectionClaim === selectedProject) selectionClaim = null
    }
  })

  on('turn.start', async ($, e, next) => {
    let matched = false
    let hadUnbound = false
    await update($, reviewRequests, requests => Object.fromEntries(Object.entries(requests).map(([path, request]) => {
      if (!request.turnId) hadUnbound = true
      if (!matched && !request.turnId && request.text === e.text) {
        matched = true
        return [path, { ...request, turnId: e.turnId }]
      }
      return [path, request]
    })))
    if (!matched && hadUnbound) {
      earlyReviewStarts.set(e.turnId, e.text)
      while (earlyReviewStarts.size > 8) earlyReviewStarts.delete(earlyReviewStarts.keys().next().value as string)
    }
    return next(e)
  })

  // The console session's own requests set the cache clock; a subagent's run on its own cache.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const startedAt = await $.clock.now()
    await update($, isTurnRunning, () => true)
    const result = yield* next(e)
    const u = result?.usage
    if (u) {
      const tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
      const prev = await read($, cacheClock)
      const { ttl, source } = await cacheTtlFor($, options, learnTtl(prev, startedAt, u.model, u.cache_read_input_tokens))
      await update($, cacheClock, () => ({ at: startedAt, tokens, model: u.model, ttl, source }) as CacheClock)
    }
    return result
  })

  // The main thread's turn ended: its transcript now records the TTL the API actually used.
  on('classic.Stop', async ($, e, next) => {
    if (typeof (e as any).transcript_path === 'string' && (e as any).transcript_path) transcriptPath = (e as any).transcript_path
    const result = await next(e)
    if (consoleActive) void syncCacheFromTranscript($, options, false).catch(() => {})
    return result
  })

  // Command guard: an irreversible shell command asks first, whatever the permission mode allows.
  on('tool.call', async ($, e, next) => {
    // PowerShell is the Windows shell tool where a build offers it.
    const tool: string = e.tool
    if (tool !== 'Bash' && tool !== 'PowerShell') return next(e)
    const mode = guardMode((options as any).commandGuard)
    const command = String((e as any).command ?? '')
    const reason = mode === 'off' ? null : dangerReason(command)
    if (!reason) return next(e)
    const preview = commandPreview(command)
    let allowed = false
    if (mode === 'ask') {
      const answer = await $.ui.ask(`指令護欄：${reason}。\n${preview}\n要執行這個指令嗎？`, { header: '指令護欄', options: ['執行一次', '拒絕'] }).catch(() => '')
      allowed = answer === '執行一次'
    }
    const at = await $.clock.now()
    await update($, feedAtom, list => [{ at, text: `指令護欄${allowed ? '放行' : '攔下'}：${reason}`, tone: allowed ? 'amber' : 'red' } as const, ...list].slice(0, 20))
    if (allowed) return next(e)
    $.ui.toast(`指令護欄攔下：${reason}`, { timeoutMs: 6000 })
    return { deny: `console-status 指令護欄攔下這個指令（${reason}）${mode === 'deny' ? '：commandGuard 設為 deny' : '：使用者沒有同意'}。不要換個寫法重試同樣的效果；改用可復原的做法，或請使用者自己執行。` }
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await update($, isTurnRunning, () => false)
    if (!e.agentId) {
      const requests = await read($, reviewRequests)
      for (const [path, request] of Object.entries(requests)) {
        if (request.turnId !== e.turnId) continue
        earlyReviewStarts.delete(e.turnId)
        await update($, reviewRequests, values => { const rest = { ...values }; delete rest[path]; return rest })
        await update($, pendingActions, values => { const rest = { ...values }; delete rest[path]; return rest })
        const answer = e.answer.trim().split(/\r?\n/).find(line => line.trim())?.slice(0, 120) ?? '請查看主控台回覆'
        await actionNotice($, `${request.projectName}：${e.reason === 'answer' ? `審核已回覆：${answer}` : `審核未完成（${e.reason}）`}`, e.reason === 'answer')
      }
    }
    earlyReviewStarts.delete(e.turnId)
    if (consoleActive) void refresh($, options)
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== 'console') return next(e)
    const arg = e.args.trim()
    if (arg === 'off') {
      if (!consoleActive) return { text: '這個 session 沒有啟動主控台（指令護欄照常運作）。' }
      await stopConsole($)
      return { text: '這個 session 已關閉主控台：不再輪詢、不顯示橫帶、不加專案內容；指令護欄照常運作。/console 再開啟。' }
    }
    if (arg !== 'version' && arg !== 'update' && !consoleActive) {
      // The first /console in a light session: `refresh` and `demo` load their own data, the pane
      // fills as the first refresh lands, and the rest read the snapshot, so they wait for it.
      await startConsole($, options, true, false)
      if (!arg) void refresh($, options, true)
      else if (arg !== 'refresh' && arg !== 'demo') await refresh($, options, true)
    }
    const modeArg = arg.match(/^mode(?:\s+(auto|console|project))?$/)
    if (modeArg) {
      if (modeArg[1]) await update($, modeOverride, () => modeArg[1] as ModeChoice)
      const choice = await read($, modeOverride) as ModeChoice
      const here = await focused($, options, await read($, snapshot))
      const text = `模式：${choice === 'auto' ? '自動' : choice === 'console' ? '主控台' : '專案'}（${here ? `專案模式：${here.project.name}` : '主控台模式'}）。可用 /console mode auto|console|project`
      if (modeArg[1]) $.ui.toast(text)
      return { text }
    }
    const projectSetting = arg.match(/^project(?:\s+(executor|model|effort)\s+(\S+)\s+([\s\S]+))?$/)
    if (projectSetting) {
      const { config } = await paths($, options)
      const snap = await read($, snapshot)
      const projects = snap && !snap.demo ? snap.projects : []
      if (!projectSetting[1]) {
        const { settings } = await readDispatch($, config)
        const lines = projects.map(p => {
          const eff = effectiveDispatch(settings, projectRoot(p.statusPath), p.registryExecutor)
          return `${p.name}：${eff.executor}（${SOURCE_LABEL[eff.source]}）· ${eff.model || '預設'} · ${eff.effort || '預設'}`
        })
        return { text: [...(lines.length ? lines : ['（尚無專案資料；先 /console refresh）']), '設定：/console project executor|model|effort <值|inherit> <專案名稱>'].join('\n') }
      }
      const name = projectSetting[3]!.trim()
      const target = projects.find(p => p.name === name) ?? projects.find(p => p.name.toLowerCase().startsWith(name.toLowerCase()))
      if (!target) return { text: `找不到專案「${name}」。` }
      const field = projectSetting[1] as keyof ProjectOverride
      const raw = projectSetting[2]!
      const value = raw === '""' || raw.toLowerCase() === 'inherit' ? '' : raw
      try {
        const saved = await changeProjectDispatch($, config, projectRoot(target.statusPath), field, value)
        if (field === 'executor') await update($, fallbackOffers, values => { const rest = { ...values }; delete rest[target.statusPath]; return rest })
        await update($, dispatchRevision, v => v + 1)
        await refresh($, options, true)
        const eff = effectiveDispatch(saved, projectRoot(target.statusPath), target.registryExecutor)
        const text = `${target.name} 派工設定：${eff.executor}（${SOURCE_LABEL[eff.source]}）· ${eff.model || '預設'} · ${eff.effort || '預設'}`
        $.ui.toast(text)
        return { text }
      } catch (error) { return { text: `設定未儲存：${error instanceof Error ? error.message : String(error)}` } }
    }
    const setting = arg.match(/^(executor|model|effort)(?:\s+([\s\S]*))?$/)
    if (setting) {
      const field = setting[1] as GlobalField
      const { config } = await paths($, options)
      try {
        if (setting[2] !== undefined) {
          const value = setting[2] === '""' ? '' : setting[2]
          const saved = await changeDispatch($, config, field, value)
          if (await demoEnabled($)) demoContext = { config, dispatch: await readDispatch($, config) }
          await update($, dispatchRevision, v => v + 1) // Invalidate pane after a settings write.
          if (field === 'executor') await refresh($, options, true)
          const text = `派工設定：${saved.executor} · ${saved.model || '預設'} · ${saved.effort || '預設'}`
          $.ui.toast(text)
          return { text }
        }
        const { settings, models } = await readDispatch($, config)
        return { text: `目前：${settings.executor} · ${settings.model || '預設'} · ${settings.effort || '預設'}\nexecutor：claude, codex\nmodel：${models.length ? models.map(m => m.model).join(', ') : '快取不可用；使用 /console model <name>'}\neffort：${effortOptions(settings.executor, models, settings.model).join(', ')}\n以 /console model "" 或 /console effort "" 恢復執行者預設。` }
      } catch (error) { return { text: `設定未儲存：${error instanceof Error ? error.message : String(error)}` } }
    }
    if (arg === 'refresh') {
      if (await demoEnabled($)) {
        dataGeneration++
        demoActive = false
        await publishDisplay(async () => {
          await update($, isDemo, () => false)
          await update($, snapshot, () => null)
          await update($, feedAtom, () => [])
          await update($, selected, () => null)
          await update($, hovered, () => null)
          await update($, menuFor, () => null)
        })
      }
      await refresh($, options, true)
      return { text: '主控台總覽已更新。' }
    }
    if (arg === 'demo') {
      demoActive = true
      const generation = ++dataGeneration
      await publishDisplay(async () => {
        await update($, isDemo, () => true)
        await update($, feedAtom, () => [])
        await update($, selected, () => null)
        await update($, hovered, () => null)
        await update($, menuFor, () => null)
        await update($, cursor, () => -1)
      })
      const { config } = await paths($, options)
      const dispatch = await readDispatch($, config)
      if (generation !== dataGeneration) return { text: '示範資料載入已被較新的模式切換取代。' }
      demoContext = { config, dispatch }
      await refreshDemo($, generation, dispatch.settings.executor)
      await $.ui.open({ id: PANE, title: '主控台（示範資料）' })
      await update($, isPaneOpen, () => true)
      return { text: '已載入示範資料；/console refresh 換回實際狀態。' }
    }
    if (arg === 'version') {
      const info = await checkUpdate($, true).catch(() => null)
      return { text: `console-status ${versionLine(info)}${hasUpdate(info) ? '\n輸入 /console update 或在面板按「⬆ 更新」。' : ''}` }
    }
    if (arg === 'update') {
      const info = await checkUpdate($, true).catch(() => null)
      if (info?.error && !info.latest) return { text: `無法檢查最新版（${info.error}）；仍可在終端機執行 claude plugin update console-status。` }
      if (info?.current && !hasUpdate(info)) return { text: `console-status ${versionLine(info)}，不需要更新。` }
      return { text: await runUpdate($) }
    }
    if (arg === 'plain') {
      const plain = await update($, isPlain, v => !v)
      return { text: plain ? '表格改用純文字列（/console plain 切回互動列）。' : '表格改用互動列。' }
    }
    if (arg === 'band') {
      const hidden = await update($, isBandHidden, v => !v)
      return { text: hidden ? '橫帶已隱藏（/console band 再顯示）。' : '橫帶已顯示。' }
    }
    if (await read($, isPaneOpen)) {
      await $.ui.close({ id: PANE }).catch(() => {})
      await update($, isPaneOpen, () => false)
      return { text: '面板已關閉。' }
    }
    await $.ui.open({ id: PANE, title: '主控台總覽' })
    await update($, isPaneOpen, () => true)
    return { text: '面板已開啟。' }
  })

  // Palette: quiet ground, colour only where it carries state (amber decide, teal running, blue sync).
  // What each label means, revealed under it while the pointer is over it.
  const HELP: Record<string, string> = {
    dispatch_executor: '執行者：claude 使用原生背景 session；codex 使用 Companion。切換時清空模型與 effort，已派出的工作繼續使用原執行者。',
    dispatch_model: '派工模型：點一下輪換並存入 dispatch.json；影響後續觸發的派工。也可用 /console model <name> 自由輸入。',
    project_executor: '專案執行者：點一下輪換此專案的覆寫（沿用 → claude → codex → manual），存入 dispatch.json 的 projects。優先序：面板覆寫 > 登錄表 Executor 欄 > 全域。manual 代表面板不派工，只做 CARD、驗證與關卡。',
    fallback: 'Codex 不可用（額度低於門檻、broker 過期或找不到 companion）時，codexFallback=ask 不會派工；按此改由 Claude 執行同一個提示，任務會標記 codex→claude。',
    dispatch_effort: '派工 effort：點一下輪換模型支援的推理強度並儲存；也可用 /console effort <level>。切換模型時不支援的 effort 會清空。',
    ACTION: '需決策：專案 STATUS 卡片的「等使用者」欄有內容，代表該專案有業務決策需由使用者拍板。',
    GATE: '待審核：STATUS 的 spec／review 關卡送交主控台判斷；release 只整理可否上線與理由，最後由你決定，不會自動上線。',
    action_verify: '執行 CARD 驗證指令，工作目錄是專案根目錄，最長 5 分鐘；不花模型額度。新的或被修改過的指令會先完整顯示，10 秒內再按一次才執行。只應填入本機驗證，不可填正式環境操作。',
    action_sync: '直接請所選執行者將最近結果同步回 STATUS CARD 與歷程，使用派工模型設定與該執行者額度。',
    git: 'Git：✕衝突 合併衝突　CI✕ PR 的檢查失敗　●n 未提交／未追蹤檔案　↑n 未推送　↓n 落後上游　CI… 檢查進行中　✓ 乾淨。git 每次更新讀取（不鎖 index），PR 與 CI 透過 gh 每 5 分鐘讀取，CI 進行中時每分鐘。gitProbe 選項可改為 git 或 off。',
    cache: '主控台的 prompt 快取：最後一次請求後 5 分鐘（或 1 小時）內送出會讀快取；過期後下一則提示要把整段 context 重寫進快取，費用約為 input 價格的 1.25 倍（1 小時 TTL 為 2 倍）。TTL 由 cacheTtl 設定，auto 讀取 session 記錄裡 API 回報的實際 TTL（cache_creation 的 5m／1h 分項）。',
    pipeline: '流程：規格 → 實作 → 同步 → 驗證 → 審核 → 上線。● 完成　◉ 執行中　◆ 等待（主控台、使用者或同步）　✕ 驗證失敗　○ 未到。由 CARD、執行者工作與最近一次驗證推得。',
    action_continue: '6 秒內再按一次，請所選執行者依下一步繼續；只在無待決與關卡時可用，使用該執行者額度。',
    action_decide: '預填決策草稿並選取專案，補完後送出才使用 Claude 額度。',
    action_gate: '把關卡與專案 context 送給主控台審核，使用 Claude 額度；不會執行 release。',
    action_open: '用編輯器開啟專案 STATUS.md，不使用模型額度。',
    RUNNING: '執行中：該專案有 Claude 或 Codex 工作尚未結束；切換執行者仍不得重複派工。',
    SYNC: '待同步：執行者任務已結束，但 STATUS 卡片在它開始後沒有更新過。autoSync 開啟時主控台會自動派一次同步。',
    sync_progress: '同步進度：派工（送給執行者）→ 執行（執行者寫回中）→ 寫回 STATUS（CARD 的「更新」有變才算完成）。● 完成　◉ 進行中　○ 未到　✕ 停在這一步。',
    IDLE: '閒置：沒有任務、也沒有待決事項。',
    codex: 'Codex：companion broker 與已安裝的 Codex app 版本一致才算正常；過期時派工會失敗。',
    sessions: '其他工作階段：屬於主控台或已登記專案的其他 Claude Code session，正停在等批准或等輸入，要切到該 session 處理。與「需決策」不同：這是操作層面的卡住，不是專案決策。',
    ctx: '上下文：本主控台 session 還剩多少上下文。用掉一半以上建議換新主控台。',
    five_hour: '5 小時：Claude 帳號 5 小時滾動額度的剩餘量，到重置時間回滿。',
    seven_day: '本週：Claude 帳號每週額度的剩餘量。',
    version: '版本：目前安裝的 console-status 與 GitHub main 上的最新版，每 30 分鐘與每次載入時檢查。「⬆ 更新」從 marketplace 安裝新版（從本機 git 資料夾載入時改在該資料夾 git pull），完成後自動 /reload-plugins；也可輸入 /console update。',
    codex_quota: 'Codex：Codex 帳號額度的剩餘量，取自最近一次 Codex 工作紀錄（每 5 分鐘讀一次）；很久沒用 Codex 時數字可能是舊的。',
  }
  const C = {
    text: '#CAD3E0', strong: '#E5EAF0', dim: '#6E7787', faint: '#4A5260', bar: '#1C222B',
    sel: '#22304A', hover: '#1A2029',
    amber: '#F0C674', amberBg: '#3A3120', teal: '#8BD5CA', tealBg: '#1D3734',
    blue: '#8AADF4', blueBg: '#212D45', purple: '#CA9EE6', purpleBg: '#33283F', grey: '#8A93A0', green: '#A6D189', red: '#E78284', orange: '#EF9F76',
  }
  const SHIMMER = ['#4E8F87', '#6FB3AA', '#9EE0D6', '#E6FFFB']
  const PIPE = { green: C.green, teal: C.teal, amber: C.amber, purple: C.purple, blue: C.blue, red: C.red, faint: C.faint, dim: C.dim, text: C.text }
  const LABEL: Record<State, string> = { ACTION: '需決策', GATE: '待審核', RUNNING: '執行中', SYNC: '待同步', IDLE: '閒置', NOCARD: '無狀態' }
  // The same glyphs as the band, so a state reads the same everywhere.
  const GLYPH: Record<State, string> = { ACTION: '●', GATE: '◆', RUNNING: '▶', SYNC: '↻', IDLE: '○', NOCARD: '✕' }
  const chipText = (state: State) => ` ${GLYPH[state]} ${LABEL[state]} `
  const FG: Record<State, string> = { ACTION: C.amber, GATE: C.purple, RUNNING: C.teal, SYNC: C.blue, IDLE: C.grey, NOCARD: C.red }
  // Only the states that wait on the person get a filled chip; the rest are coloured text.
  const BG: Record<State, string | undefined> = { ACTION: C.amberBg, GATE: C.purpleBg, RUNNING: undefined, SYNC: undefined, IDLE: undefined, NOCARD: undefined }
  const SHOWN: State[] = ['ACTION', 'GATE', 'RUNNING', 'SYNC', 'IDLE']
  const TONE: Record<string, string> = { amber: C.amber, teal: C.teal, blue: C.blue, red: C.red, green: C.green }

  // The band shares its row with other plugins' bands (paste-preview's thumbnails, say):
  // what the plugins beneath draw stacks under ours instead of being hidden by it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, nextHook) => {
    const generation = dataGeneration
    const demo = await demoEnabled($)
    const stored = await read($, snapshot)
    const s = demo && !stored?.demo ? demoSnapshot(await $.clock.now()) : stored
    if (e.props.hasSurvey || s === null || (await read($, isBandHidden))) return nextHook(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const paneOpen = await read($, isPaneOpen)
    const columns = Math.max(0, Math.floor(e.props.bodyColumns ?? 80))
    const here = await focused($, options, s)
    let mine: any
    if (here && generation === dataGeneration) {
      const button = paneOpen ? '主控台 ▾' : '主控台 ▸'
      const buttonWidth = button.length + 1
      const others = s.projects.filter(p => p !== here.project && (hasAsk(p) || parseGate(p.gate))).length
      const hereSync = demo ? undefined : (await read($, syncProgress))[here.project.statusPath]
      const hereTag = hereSync ? syncChip(hereSync, await $.clock.now(), false) : null
      mine = (
        <Box flexDirection="row" flexWrap="nowrap" width={columns} height={1} overflow="hidden">
          <Box flexShrink={0} height={1}><Text bold color={C.strong}>{here.project.name} </Text></Box>
          <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
            <Text wrap="truncate-end">
              {pipelineParts(here.pipeline, PIPE).map((part, index) => <Text key={'bp-' + index} color={part.c}>{part.t}</Text>)}
              <Text color={C.text}> {pipelineText(here.pipeline).replace(/^\S+\s?/, '')}</Text>
              {hereTag && <Text color={TONE[hereTag.tone]}>{`　${hereTag.text}`}</Text>}
              {others > 0 && <Text color={C.amber}>{`　其他 ${others} 個專案待處理`}</Text>}
            </Text>
          </Box>
          <Box width={buttonWidth} flexShrink={0} height={1} overflow="hidden">
            <Button key="pane" plain dimColor label={button} onPress={() => void openPane($)} />
          </Box>
        </Box>
      )
    } else {
      await read($, cacheTick)
      const cv = demo || cacheMode(options) === 'off' ? null : cacheView(await read($, cacheClock), await $.clock.now(), await read($, isTurnRunning), priceOverride((options as any).cacheWritePrice))
      const chip = cv ? cacheChip(cv, columns < 40) : null
      const syncing = demo ? null : bandSync(await read($, syncProgress))
      const syncTag = syncing ? syncChip(syncing, await $.clock.now(), columns < 40) : null
      const band = layoutBand(s, { columns, demo, paneOpen, ...(chip ? { cache: chip.text } : {}), ...(syncTag ? { sync: syncTag.text } : {}) })
      if (generation !== dataGeneration) mine = <Box height={1} width={columns} overflow="hidden"><Text color={C.dim} wrap="truncate-end">{demoActive ? ' 示範資料 ' : '讀取中…'}</Text></Box>
      else mine = (
        <Box flexDirection="row" flexWrap="nowrap" width={columns} height={1} overflow="hidden">
          <Box gap={1} flexShrink={0} height={1}>
            {band.items.map(item => <Box key={'band-' + item.id} width={item.width} flexShrink={0} height={1} overflow="hidden">
              <Text wrap="truncate-end" color={item.zero ? C.faint : item.id === 'demo' ? C.dim : item.id === 'next' ? C.amber : item.id === 'context' || item.id === 'ci' ? C.red : item.id === 'cache' ? (chip?.tone === 'red' ? C.red : chip?.tone === 'amber' ? C.amber : C.green) : item.id === 'sync' ? TONE[syncTag?.tone ?? 'blue'] : FG[item.id as State] ?? C.text}
                bold={item.id === 'cache' && chip?.tone === 'amber'}
                backgroundColor={item.id === 'demo' ? C.bar : item.id === 'cache' && chip?.tone === 'amber' ? C.amberBg : undefined}>
                {item.id === 'next' && item.text.startsWith('▸ 下一步') ? [<Text key="nl" bold>▸ 下一步</Text>, <Text key="nt" color={C.text}>{item.text.slice(5)}</Text>] : item.text}</Text>
            </Box>)}
          </Box>
          <Box flexGrow={1} minWidth={band.items.length ? 1 : 0} />
          <Box width={band.buttonWidth} flexShrink={0} height={1} overflow="hidden">
            <Button key="pane" plain dimColor label={band.button} onPress={() => void openPane($)} />
          </Box>
        </Box>
      )
    }
    const below = await nextHook(e).catch(() => null)
    return isEmptyTree(below) ? mine : <Box flexDirection="column" width={columns}>{mine}{below}</Box>
  })

  // Rows drawn by the Client module report presses, right-clicks and keys here.
  on('ui.message', async ($, e, nextHook) => {
    if (e.requestId !== PANE || e.element !== 'rows' || !e.data || typeof e.data !== 'object') return nextHook(e)
    const data = e.data as { press?: unknown; menu?: unknown; key?: unknown; hover?: unknown }
    const s = await read($, snapshot)
    const list = s ? rows(s) : []
    if (typeof data.press === 'string') {
      const id = data.press
      await update($, selected, v => (v === id ? null : id))
      await update($, cursor, () => list.findIndex(r => r.full === id))
    } else if ('hover' in data) {
      const id = typeof data.hover === 'string' ? data.hover : null
      await update($, hovered, () => id)
    } else if (typeof data.menu === 'string') {
      const id = data.menu
      await update($, menuFor, v => (v === id ? null : id))
    } else if (typeof data.key === 'string' && list.length) {
      const k = data.key.toLowerCase()
      if (k === 'up' || k === 'k') await update($, cursor, v => Math.max(0, (v < 0 ? 0 : v) - 1))
      if (k === 'down' || k === 'j') await update($, cursor, v => Math.min(list.length - 1, v + 1))
      if (k === 'return' || k === 'enter' || k === 'space') {
        const at = await read($, cursor)
        const id = list[Math.max(0, at)]?.full
        if (id) await update($, selected, v => (v === id ? null : id))
      }
      if (k === 'm' || k === '.') {
        const id = list[Math.max(0, await read($, cursor))]?.full
        if (id) await update($, menuFor, v => (v === id ? null : id))
      }
      const menuName = await read($, menuFor)
      const menuProject = menuName === null ? null : s?.projects.find(p => p.name === menuName)
      if (menuProject && !(await demoEnabled($))) {
        const kind = HOTKEYS[k]
        const state = list.find(r => r.full === menuProject.name)?.state
        if (kind && state && actionKinds(menuProject, state).includes(kind) && !(await read($, pendingActions))[menuProject.statusPath]) {
          void triggerAction($, options, menuProject.statusPath, kind)
          return {}
        }
        if (k === 'p' && menuProject.pr) { void openPullRequest($, menuProject); return {} }
      }
      if (k === 'escape') {
        if (await read($, menuFor)) await update($, menuFor, () => null)
        else await update($, selected, () => null)
      }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const generation = dataGeneration
    const ui = $.ui.resolve(e) as any
    const { Box, Text, Button } = ui
    const demo = await demoEnabled($)
    const stored = await read($, snapshot)
    const s = demo && !stored?.demo ? demoSnapshot(await $.clock.now()) : stored
    // A pane left open across a reload into a light session gets no refresh, so say how to start one.
    if (s === null && !consoleActive) return <Text color={C.dim}>這個 session 沒有啟動主控台；輸入 /console refresh 開啟。</Text>
    if (s === null) return <Text color={C.dim}>讀取各專案狀態中…</Text>
    const detail = await read($, isDetail)
    const selectedName = await read($, selected)
    const sel = demo && !s.projects.some(project => project.name === selectedName) ? null : selectedName
    const cur = await read($, cursor)
    const feed = demo ? demoEvents(s.at) : await read($, feedAtom)
    const hov = await read($, hovered)
    const menu = await read($, menuFor)
    const refreshing = await read($, isRefreshing)
    const pending = await read($, pendingActions)
    const confirmations = await read($, continueConfirmations)
    const verified = await read($, verificationResults)
    const trusted = await read($, trustedVerify)
    await read($, actionPulse) // redraws running action labels once a second
    const offers = demo ? {} : await read($, fallbackOffers)
    const syncs = demo ? {} : await read($, syncProgress)
    const version = await read($, updateInfo)
    const renderedAt = Object.keys(pending).length || Object.values(syncs).some(track => !isSyncEnded(track.stage)) ? await $.clock.now() : s.at
    const revision = await read($, dispatchRevision)
    // Drawing never touches the disk on its own: settings are re-read after a write (revision) or a refresh (s.at).
    const { config, dispatch } = demo
      ? { config: demoContext?.config ?? resolveConfig(options, '', '', '/tmp'), dispatch: demoContext?.dispatch ?? { settings: { executor: s.executor ?? 'claude', model: '', effort: '' }, models: [] } }
      : await renderDispatch($, options, `${revision}|${s.at}`)
    const cycle = async (field: GlobalField) => {
      try {
        const saved = await changeDispatch($, config, field)
        if (await demoEnabled($)) demoContext = { config, dispatch: await readDispatch($, config) }
        await update($, dispatchRevision, v => v + 1)
        if (field === 'executor') await refresh($, options, true)
        $.ui.toast(`派工設定已儲存：${saved.executor} · ${saved.model || '預設'} · ${saved.effort || '預設'}`)
      } catch (error) { $.ui.toast(`設定未儲存：${error instanceof Error ? error.message : String(error)}`) }
    }
    /**
     * Pick one project's executor ('' = inherit). The snapshot is patched at once so the label,
     * the actions and the dispatch guard all agree before the (slow) refresh comes back.
     */
    const chooseProjectExecutor = async (p: Project, value: '' | 'claude' | 'codex' | 'manual') => {
      if (await demoEnabled($)) { $.ui.toast('示範資料：不變更專案設定。'); return }
      try {
        const root = projectRoot(p.statusPath)
        const saved = await changeProjectDispatch($, config, root, 'executor', value)
        const eff = effectiveDispatch(saved, root, p.registryExecutor)
        await update($, snapshot, current => current && {
          ...current,
          projects: current.projects.map(item => item.statusPath === p.statusPath ? { ...item, executor: eff.executor, executorSource: eff.source } : item),
        })
        await update($, fallbackOffers, values => { const rest = { ...values }; delete rest[p.statusPath]; return rest })
        await update($, dispatchRevision, v => v + 1)
        $.ui.toast(`${p.name} 執行者：${eff.executor}（${SOURCE_LABEL[eff.source]}）`)
        void refresh($, options, true)
      } catch (error) { $.ui.toast(`設定未儲存：${error instanceof Error ? error.message : String(error)}`) }
    }
    const codexShown = dispatch.settings.executor === 'codex' || !!s.codexInUse
    const n = next(s)
    const c = counts(s)
    const ctx = s.contextPercent
    const time = new Date(s.at).toTimeString().slice(0, 5)
    const health = codexHealth(s.codex)
    const width: number = Math.max(40, (e.props.bodyColumns ?? 80) - 1)
    const list = rows(s)
    const now = await $.clock.now()
    const showGit = s.projects.some(p => p.git)
    const W = { state: 10, project: projectColumnWidth(list.map(row => row.project)), age: 4, flow: width >= 64 ? 6 : 0, git: showGit && width >= 80 ? 7 : 0 }
    const badges = new Map(s.projects.map(p => [p.name, gitBadge(p.git, p.pr)]))
    const GIT_TONE: Record<string, string> = { red: C.red, amber: C.amber, blue: C.blue, teal: C.teal, green: C.green, dim: C.dim }
    const pipes = new Map(s.projects.map(p => [p.name, pipeline(p, verified[p.statusPath])]))
    const here = demo ? null : await focused($, options, s)

    const specs = list.map(r => ({
      id: r.full,
      shimmer: r.state === 'RUNNING',
      breathe: r.state === 'ACTION' ? [C.amberBg, '#443925', '#4D412B'] : r.state === 'GATE' ? [C.purpleBg, '#3D304B', '#463755'] : undefined,
      changedAt: s.projects.find(project => project.name === r.full)?.changedAt,
      cells: [
        { t: chipText(r.state), c: FG[r.state], bg: BG[r.state], b: r.state !== 'IDLE', w: W.state },
        { t: r.project, c: r.state === 'IDLE' ? C.dim : C.strong, w: W.project },
        { t: r.item, c: r.state === 'IDLE' ? C.dim : C.text },
        ...(W.flow ? [{ t: '', w: W.flow, parts: pipes.get(r.full) ? pipelineParts(pipes.get(r.full)!, PIPE) : [] }] : []),
        ...(W.git ? [{ t: badges.get(r.full)?.text ?? '', c: GIT_TONE[badges.get(r.full)?.tone ?? 'dim'], w: W.git }] : []),
        { t: r.age, c: C.dim, w: W.age, right: true },
      ],
    }))

    const rich = (e.surface === 'terminal' || e.surface === 'desktop') && Boolean(ui.Client) && !(await read($, isPlain))
    const table = rich
      ? (
        <ui.Client key="rows" module="./rows.tsx" width="100%"
          props={JSON.parse(JSON.stringify({ rows: specs, now, changed: ['#2C3B4B', '#24303D', '#1C252F'], selected: sel, cursor: cur, selectedBg: C.sel, hoverBg: C.hover, shimmer: SHIMMER }))} />
      )
      : (
        <Box flexDirection="column">
          {list.map(r => (
            <Box key={'row-' + r.project} gap={1} backgroundColor={sel === r.full ? C.sel : undefined}>
              <Box width={W.state}><Text bold color={FG[r.state]} backgroundColor={BG[r.state]}>{chipText(r.state)}</Text></Box>
              <Box width={W.project}>
                <Button key={'sel-' + r.project} plain label={r.project}
                  onPress={() => void update($, selected, v => (v === r.full ? null : r.full))} />
              </Box>
              <Box flexGrow={1} flexShrink={1}><Text color={C.text} wrap={detail ? 'wrap' : 'truncate-end'}>{r.item}</Text></Box>
              {W.flow > 0 && <Box width={W.flow} flexShrink={0}><Text>{(pipes.get(r.full) ? pipelineParts(pipes.get(r.full)!, PIPE) : []).map((part, index) => <Text key={'fp-' + index} color={part.c}>{part.t}</Text>)}</Text></Box>}
              {W.git > 0 && <Box width={W.git} flexShrink={0} overflow="hidden"><Text color={GIT_TONE[badges.get(r.full)?.tone ?? 'dim']} wrap="truncate-end">{badges.get(r.full)?.text ?? ''}</Text></Box>}
              <Box width={W.age} justifyContent="flex-end"><Text color={C.dim}>{r.age}</Text></Box>
            </Box>
          ))}
        </Box>
      )

    // Hidden line that appears while anything in the same hover scope is under the pointer.
    // Full, untruncated text of a row (the table cell is cut to fit).
    const fullItem = (full: string) => {
      const p = s.projects.find(x => x.name === full)
      if (!p) return ''
      if (!p.hasCard) return 'STATUS 卡不存在'
      if (hasAsk(p)) return askSummary(p.ask)
      if (parseGate(p.gate)) return `關卡：${p.gate}`
      const run = p.jobs.find(j => j.kind === 'running')
      if (run) return runLine(run, s.at)
      if (p.jobs.some(j => j.kind === 'newer')) return '結果未同步至 STATUS'
      return p.state || '—'
    }
    const hovRow = hov === null ? null : list.find(x => x.full === hov) ?? null
    // One-line help strip; labels replace its contents without adding a blank row above the controls.
    const helpStrip = (
      <Box key="help" height={1} backgroundColor={C.bar} paddingX={1}>
        {hovRow !== null
          ? <Text color={C.text} wrap="truncate-end"><Text bold color={FG[hovRow.state]}>{hovRow.project}　</Text>{fullItem(hovRow.full)}</Text>
          : <Text color={C.faint} wrap="truncate-end">{rich ? 'ⓘ 點選或 ↑↓ Enter 選取專案・右鍵或 m 開啟動作選單・游標停在標籤上看說明' : 'ⓘ 點專案名稱即可選取'}</Text>}
        {Object.keys(HELP).map(id => (
          <Box key={'tip-' + id} position="absolute" top={0} left={0} width="100%" height={1} paddingX={1}
            backgroundColor={C.bar} display="none" hover={{ scope: 'help-' + id, display: 'flex' }}>
            <Text color={C.blue} wrap="truncate-end">ⓘ {HELP[id]}</Text>
          </Box>
        ))}
      </Box>
    )
    // One usage row: tool name (first row of its group only), label, then the content.
    const USAGE_TOOL = 7
    const USAGE_LABEL = 6
    const usageRow = (key: string, tool: string, label: string, help: string | null, body: any) => (
      <Box key={key} gap={1} {...(help ? { hover: { scope: 'help-' + help } } : {})}>
        <Box width={USAGE_TOOL} flexShrink={0}><Text bold color={C.strong}>{tool}</Text></Box>
        <Box width={USAGE_LABEL} flexShrink={0}><Text color={C.dim}>{label}</Text></Box>
        {body}
      </Box>
    )
    // A remaining-amount meter that fills from the left; amber when low, red when nearly out.
    const meterRow = (key: string, tool: string, { id, label, used, hint, note }: { id: string; label: string; used: number; hint: string; note?: string }) => {
      // Context goes low where rotation is advised (half used), red at 30% left.
      const b = id === 'ctx' ? battery(used, 10, 100 - ROTATE_PERCENT, 30) : battery(used, 10)
      const tone = b.tone === 'red' ? C.red : b.tone === 'low' ? C.orange : C.green
      return usageRow(key, tool, label, id, [
        <Box key={key + '-meter'} flexShrink={0}>{rich ? <ui.Client key={'battery-' + id + '-' + label} module="./battery.tsx" width={METER + 5} height={1} props={{ percent: b.left, tone }} /> : batteryBody(b.left, tone, ui)}</Box>,
        hint !== '' ? <Box key={key + '-hint'} flexShrink={0}><Text color={C.red}>{hint}</Text></Box> : null,
        note ? <Box key={key + '-note'} flexShrink={1}><Text color={C.dim} wrap="truncate-end">{note}</Text></Box> : null,
      ])
    }
    const target = nextProject(s)
    const targetProject = s.projects.find(p => p.name === target)
    const targetState = list.find(r => r.full === target)?.state
    const primaryAction: ActionKind | null = targetState === 'ACTION' ? 'decide' : targetState === 'GATE' && parseGate(targetProject?.gate)?.kind !== 'unknown' ? 'gate' : targetState === 'SYNC' && targetProject && !isManual(targetProject) ? 'sync' : null
    const focus = sel ?? list[Math.max(0, cur)]?.full ?? null
    const menuProject = menu === null ? null : s.projects.find(x => x.name === menu) ?? null
    const actionButton = (p: Project, kind: ActionKind, key: string) => {
      const active = pending[p.statusPath]
      const blocked = kind === 'continue' || kind === 'sync' ? dispatchBlockReason(p) : ''
      const confirming = confirmations[p.statusPath]?.signature === (kind === 'continue' ? workSignature(p) : kind === 'verify' ? verifySignature(p.verify) : null)
      const running = active?.kind === kind
      const elapsed = running ? Math.max(0, Math.floor((renderedAt - active.at) / 1000)) : 0
      const label = blocked ? `⇢ 無法派工：${blocked}` : running ? `${rich ? '' : '⋯ '}${actionLabel(kind, p)}… ${elapsed}s`
        : confirming ? '再按一次確認' : actionLabel(kind, p)
      return <Box key={'help-' + key} hover={{ scope: 'help-action_' + kind }} gap={running && rich ? 1 : 0}>
        {running && rich && <ui.Client key={'spin-' + key} module="./spinner.tsx" width={1} height={1} props={{ color: C.dim }} />}
        <Button key={key} plain dimColor={!!active || !!blocked} label={label} onPress={async () => {
          if (!active && !blocked) await triggerAction($, options, p.statusPath, kind)
        }} />
      </Box>
    }
    const projectActions = (p: Project, prefix: string) => {
      const state = list.find(r => r.full === p.name)?.state ?? 'NOCARD'
      const kinds = actionKinds(p, state)
      const blockedReason = !isManual(p) ? dispatchBlockReason(p) : ''
      const active = pending[p.statusPath]?.kind
      if (active && !kinds.includes(active)) kinds.unshift(active)
      const offer = p.executor === 'codex' ? offers[p.statusPath] : undefined
      // While a second press is armed, say exactly what it will do: the toast alone disappears.
      const armed = confirmations[p.statusPath]?.signature
      const pendingConfirm = armed === workSignature(p) ? `再按一次將派工：${p.next}` : armed === verifySignature(p.verify) ? `再按一次將執行：${p.verify}` : ''
      return <Box flexDirection="column">
        <Box gap={2} flexWrap="wrap">
          {kinds.map(kind => actionButton(p, kind, prefix + kind))}
          {blockedReason && <Text key={prefix + 'blocked'} color={C.dim}>派工鎖定：{blockedReason}</Text>}
          {offer && <Box key={'help-' + prefix + 'fallback'} hover={{ scope: 'help-fallback' }}>
            <Button key={prefix + 'fallback'} plain dimColor={!!pending[p.statusPath]} label={`⇢ 改用 Claude 派工（${actionLabel(offer.kind, p).replace(/^⇢\s*/, '')}）`} onPress={async () => {
              if (!pending[p.statusPath]) await triggerAction($, options, p.statusPath, offer.kind, { useClaude: true })
            }} />
          </Box>}
        </Box>
        {pendingConfirm && <Text key={prefix + 'confirm'} color={C.amber} wrap="wrap">{pendingConfirm}</Text>}
        <Box gap={1} flexWrap="wrap">
          <Text color={C.dim}>執行者</Text>
          <Box hover={{ scope: 'help-project_executor' }} gap={1}>
            {(['', 'claude', 'codex', 'manual'] as const).map(value => {
              const override = projectOverride(dispatch.settings, projectRoot(p.statusPath))?.executor ?? ''
              const chosen = override === value
              const inherited = effectiveDispatch({ ...dispatch.settings, projects: {} }, projectRoot(p.statusPath), p.registryExecutor)
              const label = value === '' ? `沿用（${inherited.executor}・${SOURCE_LABEL[inherited.source]}）` : value
              return <Button key={prefix + 'executor-' + (value || 'inherit')} plain dimColor={!chosen}
                label={chosen ? `[${label}]` : label} onPress={() => { if (!chosen) void chooseProjectExecutor(p, value) }} />
            })}
          </Box>
          {isManual(p) && <Text color={C.dim}>手動交接：面板不派工（CARD、驗證、關卡照常）</Text>}
          {offer && <Text color={C.amber} wrap="truncate-end">Codex 未派工：{offer.reason}</Text>}
        </Box>
      </Box>
    }
    // Each decision on its own line, its options one per line underneath, nothing truncated.
    const decisionView = (p: Project, prefix: string) => {
      if (!hasAsk(p)) return null
      const decisions = parseAsk(p.ask)
      const numbered = decisions.length > 1
      return (
        <Box key={prefix + 'ask'} flexDirection="column">
          {decisions.map((d, i) => (
            <Box key={prefix + 'ask-' + i} flexDirection="column" marginTop={i ? 1 : 0}>
              {d.title !== '' && (
                <Box gap={1}>
                  {numbered && <Box width={3} flexShrink={0}><Text bold color={C.amber}>{`${i + 1}.`}</Text></Box>}
                  <Box flexGrow={1} flexShrink={1}><Text color={C.amber} wrap="wrap">{d.title}</Text></Box>
                </Box>
              )}
              {d.options.map(o => (
                <Box key={prefix + 'ask-' + i + '-' + o.key} gap={1} paddingLeft={numbered ? 4 : 2}>
                  <Box width={3} flexShrink={0}><Text bold color={C.strong}>{/^[①-⑨]$/.test(o.key) ? o.key : o.key + ')'}</Text></Box>
                  <Box flexGrow={1} flexShrink={1}><Text color={C.text} wrap="wrap">{o.text}</Text></Box>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )
    }
    /** What a person needs to decide the next move: what is running (and its last output), then the CARD. */
    const projectInfo = (p: Project, prefix: string, opts: { state?: boolean } = {}) => {
      const field = (label: string, value: string, color: string) => value ? (
        <Box key={prefix + label} gap={2}>
          <Box width={6} flexShrink={0}><Text color={C.dim}>{label}</Text></Box>
          <Box flexGrow={1} flexShrink={1}><Text color={color} wrap="wrap">{value}</Text></Box>
        </Box>
      ) : null
      const running = p.jobs.filter(j => j.kind === 'running')
      return <Box flexDirection="column" marginTop={1}>
        {running.map(j => {
          const task = (p.tasks ?? []).find(t => t.id === j.id && (!t.executor || !j.executor || t.executor === j.executor))
          // The latest output has its own line below, so the meta never repeats it.
          const meta = task ? taskMeta(task, s.at).meta : runLine({ ...j, last: '' }, s.at)
          return <Box key={prefix + 'run-' + j.id} flexDirection="column">
            <Box gap={1}>
              <Box width={2} flexShrink={0}><Text color={C.teal}>◉</Text></Box>
              <Box flexGrow={1} flexShrink={1}><Text color={C.strong} wrap="truncate-end">{task?.title ?? (j.summary || j.id)}</Text></Box>
              <Box flexShrink={0}><Text color={C.dim}>{meta}</Text></Box>
            </Box>
            {j.last && <Text color={C.dim} wrap="truncate-end">{'   › '}{j.last}</Text>}
          </Box>
        })}
        {opts.state && field('狀態', p.state, C.text)}
        {hasAsk(p) && (
          <Box key={prefix + '待決'} gap={2}>
            <Box width={6} flexShrink={0}><Text color={C.dim}>待決</Text></Box>
            <Box flexGrow={1} flexShrink={1}>{decisionView(p, prefix)}</Box>
          </Box>
        )}
        {field('關卡', parseGate(p.gate) ? p.gate ?? '' : '', C.purple)}
        {field('下一步', p.next, C.text)}
        {syncs[p.statusPath] ? (() => {
          const track = syncs[p.statusPath]!
          const tone = track.stage === 'done' ? C.green : isSyncEnded(track.stage) ? C.red : C.blue
          return <Box key={prefix + 'sync'} gap={2} hover={{ scope: 'help-sync_progress' }}>
            <Box width={6} flexShrink={0}><Text color={C.dim}>同步</Text></Box>
            <Box flexGrow={1} flexShrink={1} flexDirection="column">
              <Text color={tone} wrap="truncate-end">{syncStepsText(track)}</Text>
              <Text color={C.text} wrap="wrap">{syncStatus(track, renderedAt)}</Text>
            </Box>
          </Box>
        })() : field('同步', !running.length && p.jobs.some(j => j.kind === 'newer') ? '執行者已結束，結果未寫回 STATUS' : '', C.blue)}
        {p.git && field('Git', gitLine(p.git), p.git.conflicts ? C.red : p.git.changed || p.git.untracked ? C.amber : p.git.ahead || p.git.behind ? C.blue : C.dim)}
        {p.pr && (
          <Box key={prefix + 'pr'} gap={2}>
            <Box width={6} flexShrink={0}><Text color={C.dim}>PR</Text></Box>
            <Box flexGrow={1} flexShrink={1}><Text color={p.pr.state === 'OPEN' && p.pr.checks.fail ? C.red : p.pr.state === 'OPEN' && p.pr.checks.pending ? C.teal : C.text} wrap="wrap">{prLine(p.pr)}</Text></Box>
            <Box flexShrink={0}><Button key={prefix + 'pr-open'} plain dimColor label="↗ 開啟" onPress={() => void openPullRequest($, p)} /></Box>
          </Box>
        )}
      </Box>
    }
    const verificationView = (p: Project) => {
      const result = verified[p.statusPath]
      const command = p.verify.trim() ? <Text color={verifyTrusted(trusted, p.statusPath, p.verify) ? C.dim : C.amber} wrap="wrap">
        驗證指令{verifyTrusted(trusted, p.statusPath, p.verify) ? '' : (trusted[p.statusPath] === undefined ? '（未確認）' : '（已變更，未確認）')}：{p.verify}</Text> : null
      if (!result) return command && <Box flexDirection="column" marginTop={1}>{command}</Box>
      return <Box flexDirection="column" marginTop={1}>
        {command}
        <Text color={result.ok ? C.green : C.red}>{result.ok ? '✓' : '✕'} 最後驗證 {new Date(result.at).toLocaleString()}（{result.exitCode === null ? '未正常結束' : `exit ${result.exitCode}`}）</Text>
        {result.truncated && <Text color={C.amber}>輸出已被執行器截斷，以下是擷取內容</Text>}
        {(result.lines.length ? result.lines : ['（無輸出）']).map((line, index) => <Text key={'output-' + index} color={C.dim} wrap="truncate-end">{line}</Text>)}
      </Box>
    }
    const rule = <Text color={C.faint} wrap="truncate-end">{'─'.repeat(width)}</Text>
    const limits = (s.limits ?? []).slice(0, 2)
    await read($, cacheTick)
    const paneClock = demo || cacheMode(options) === 'off' ? null : await read($, cacheClock)
    const paneView = paneClock ? cacheView(paneClock, now, await read($, isTurnRunning), priceOverride((options as any).cacheWritePrice)) : null
    const paneCache = paneClock && paneView ? { clock: paneClock, view: paneView } : null
    // No countdown yet: say when it starts, so the row is findable right after an install or reload.
    const paneCacheNote = demo || cacheMode(options) === 'off' || paneCache ? ''
      : !paneClock ? '下一則回應後開始倒數'
      : await read($, isTurnRunning) ? '回應中，結束後重新倒數' : ''

    if (generation !== dataGeneration) return <Text color={C.dim}>{demoActive ? ' 示範資料 ' : '讀取中…'}</Text>
    return (
      <Box flexDirection="column" gap={1}>
        <Box key="head" flexDirection="column">
          <Box justifyContent="space-between" gap={1}>
            <Text bold color={C.strong} wrap="truncate-end">主控台{demo && <Text color={C.dim} backgroundColor={C.bar}> 示範資料 </Text>}<Text color={C.dim}>{`　${s.projects.length} 個專案`}</Text></Text>
            <Box flexShrink={0}><Text color={C.faint}>{`更新於 ${time}`}</Text></Box>
          </Box>
          <Box gap={1} flexWrap="wrap">
            <Text color={C.dim}>派工</Text>
            <Box hover={{ scope: 'help-dispatch_executor' }}>
              <Button key="dispatch-executor" plain label={dispatch.settings.executor} onPress={() => cycle('executor')} />
            </Box>
            <Text color={C.faint}>·</Text>
            <Text color={C.dim}>模型</Text>
            <Box hover={{ scope: 'help-dispatch_model' }}>
              <Button key="dispatch-model" plain label={dispatch.settings.model || '預設'} onPress={() => cycle('model')} />
            </Box>
            <Text color={C.faint}>·</Text>
            <Text color={C.dim}>強度</Text>
            <Box hover={{ scope: 'help-dispatch_effort' }}>
              <Button key="dispatch-effort" plain label={dispatch.settings.effort || '預設'} onPress={() => cycle('effort')} />
            </Box>
          </Box>
        </Box>

        {here && (
          <Box key="project-mode" flexDirection="column" borderStyle="round" borderColor={C.teal} paddingX={1}>
            <Box justifyContent="space-between" gap={1}>
              <Text bold color={C.teal} wrap="truncate-end">專案模式　<Text color={C.strong}>{here.project.name}</Text></Text>
              <Text color={C.dim}>/console mode console 切回主控台</Text>
            </Box>
            {pipelineLine(here.pipeline, PIPE, ui, 'pm-pipeline')}
            {here.project.next.trim() && !here.pipeline.note.includes(here.project.next.trim()) && <Text color={C.text} wrap="wrap"><Text color={C.dim}>下一步　</Text>{here.project.next}</Text>}
            {projectActions(here.project, 'pm-')}
            {verificationView(here.project)}
          </Box>
        )}

        <Box flexDirection="column" backgroundColor={C.bar} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={n ? C.amber : C.green}>{n ? '▸ 下一步' : '✓ 就緒'}</Text>
            {targetProject && primaryAction && actionButton(targetProject, primaryAction, 'next-action')}
          </Box>
          <Text color={C.strong} wrap={detail ? 'wrap' : 'truncate-end'}>{n ?? '目前沒有需要處理的項目'}</Text>
        </Box>

        <Box flexDirection="column">
          <Box justifyContent="space-between" gap={2} flexWrap="wrap">
            <Text bold color={C.dim}>專案</Text>
            <Box gap={2} flexWrap="wrap">
              {s.projects.length > 1 && SHOWN.map(k => (
                <Box key={'k' + k} hover={{ scope: 'help-' + k }}>
                  <Text color={c[k] ? FG[k] : C.faint}>{GLYPH[k]} {LABEL[k]} <Text bold>{c[k]}</Text></Text>
                </Box>
              ))}
            </Box>
          </Box>
          <Box gap={1} paddingRight={1}>
            <Box width={W.state}><Text color={C.faint}> 狀態</Text></Box>
            <Box width={W.project}><Text color={C.faint}>名稱</Text></Box>
            <Box flexGrow={1}><Text color={C.faint}>項目</Text></Box>
            {W.flow > 0 && <Box width={W.flow} flexShrink={0} hover={{ scope: 'help-pipeline' }}><Text color={C.faint}>流程</Text></Box>}
            {W.git > 0 && <Box width={W.git} flexShrink={0} hover={{ scope: 'help-git' }}><Text color={C.faint}>Git</Text></Box>}
            <Box width={W.age} justifyContent="flex-end"><Text color={C.faint}>更新</Text></Box>
          </Box>
          {rule}
          {table}
          {menuProject && (
            <Box key="menu" flexDirection="column" borderStyle="round" borderColor={C.blue} paddingX={1} marginTop={1}>
              <Box justifyContent="space-between" gap={1}>
                <Box gap={1} flexShrink={1}>
                  {(() => { const st = list.find(r => r.full === menuProject.name)?.state ?? 'NOCARD'; return <Text bold color={FG[st]} backgroundColor={BG[st]}>{chipText(st)}</Text> })()}
                  <Text bold color={C.strong} wrap="truncate-end">{menuProject.name}</Text>
                </Box>
                <Button key="m-close" plain dimColor label="✕ 關閉" onPress={() => void update($, menuFor, () => null)} />
              </Box>
              {pipes.get(menuProject.name) && <Box marginTop={1}>{pipelineLine(pipes.get(menuProject.name)!, PIPE, ui, 'm-pipeline', { noteless: menuProject.jobs.some(j => j.kind === 'running') })}</Box>}
              {projectInfo(menuProject, 'm-info-')}
              <Box marginTop={1}>{projectActions(menuProject, 'm-')}</Box>
              {verificationView(menuProject)}
              {rich && (() => {
                const st = list.find(r => r.full === menuProject.name)?.state ?? 'NOCARD'
                const keys = actionKinds(menuProject, st).filter(kind => HOTKEY_OF[kind]).map(kind => `${HOTKEY_OF[kind]} ${actionLabel(kind, menuProject).replace(/^\S+\s*/, '')}`)
                if (menuProject.pr) keys.push('p 開啟 PR')
                return <Text key="m-keys" color={C.faint} wrap="wrap">{`快捷鍵　${[...keys, 'Esc 關閉'].join('・')}`}</Text>
              })()}
            </Box>
          )}
          {sel !== null
            ? (
              <Box justifyContent="space-between">
                <Text color={C.blue} wrap="truncate-end">◆ 已選取 {sel.replace(/\s.*$/, '')}<Text color={C.dim}>　下一則提示會附上此專案</Text></Text>
                <Button key="unselect" plain dimColor label="✕ 取消" onPress={() => void update($, selected, () => null)} />
              </Box>
            )
            : null}
          {sel !== null && !detail && menuProject?.name !== sel && (() => {
            const p = s.projects.find(x => x.name === sel)
            return p && hasAsk(p) ? (
              <Box key="sel-ask" flexDirection="column" borderStyle="round" borderColor={C.amber} paddingX={1}>
                <Text color={C.dim}>需要你決定</Text>
                {decisionView(p, 'sel-')}
              </Box>
            ) : null
          })()}
        </Box>

        {detail && (
          <Box flexDirection="column">
            {list.map((row, idx) => {
              const p = s.projects.find(x => x.name === row.full)
              if (!p) return null
              if (row.full !== focus) {
                // Compact line: press to focus this project.
                return (
                  <Box key={'d-' + p.name} gap={1}>
                    <Box width={W.state}><Text color={FG[row.state]}>{chipText(row.state)}</Text></Box>
                    <Button key={'df-' + p.name} plain dimColor label={'▸ ' + row.project} onPress={() => void update($, cursor, () => idx)} />
                  </Box>
                )
              }
              return (
                <Box key={'d-' + p.name} flexDirection="column" borderStyle="round" borderColor={row.state === 'IDLE' ? C.faint : FG[row.state]} paddingX={1} marginY={1}>
                  <Box justifyContent="space-between" gap={1}>
                    <Box gap={1} flexShrink={1}>
                      <Text bold color={FG[row.state]} backgroundColor={BG[row.state]}>{chipText(row.state)}</Text>
                      <Text bold color={C.strong} wrap="truncate-end">{p.name}</Text>
                    </Box>
                    <Text color={C.dim}>{row.age && row.age !== '—' ? `${row.age}前更新` : '無卡片'}</Text>
                  </Box>
                  {pipes.get(p.name) && <Box marginTop={1}>{pipelineLine(pipes.get(p.name)!, PIPE, ui, 'd-pipeline-' + p.name, { noteless: true })}</Box>}
                  {projectInfo(p, 'd-info-' + p.name + '-', { state: true })}
                  {projectActions(p, 'detail-' + p.name + '-')}
                  {verificationView(p)}
                  {(p.tasks ?? []).length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text color={C.dim}>執行者任務</Text>
                      {(p.tasks ?? []).map(t => {
                        const m = taskMeta(t, s.at)
                        const tone = m.tone === 'teal' ? C.teal : m.tone === 'green' ? C.green : m.tone === 'red' ? C.red : C.dim
                        return (
                          <Box key={'t-' + t.id} gap={1}>
                            <Box width={2} flexShrink={0}><Text color={tone}>{m.icon}</Text></Box>
                            <Box flexGrow={1} flexShrink={1}><Text color={m.tone === 'teal' ? C.strong : C.text} wrap="truncate-end">{t.title}</Text></Box>
                            <Box flexShrink={0}><Text color={C.dim}>{m.meta}</Text></Box>
                          </Box>
                        )
                      })}
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        )}

        {feed.length > 0 && (
          <Box flexDirection="column">
            <Text bold color={C.dim}>動態</Text>
            {(() => {
              const props = { events: feed.slice(0, 5).map(ev => ({ at: ev.at, text: ev.text, color: TONE[ev.tone] ?? C.text })), now, normal: C.text, bright: C.strong, dim: C.dim }
              return rich ? <ui.Client key="feed" module="./feed.tsx" width="100%" props={props} /> : feedBody(props, now, ui, false)
            })()}
          </Box>
        )}

        <Box key="usage" flexDirection="column">
          <Box justifyContent="space-between" gap={2} flexWrap="wrap">
            <Text bold color={C.dim}>用量</Text>
            <Box gap={2} flexWrap="wrap">
              {codexShown && <Box key="h-codex" hover={{ scope: 'help-codex' }}>
                <Text color={C.dim}>Codex <Text color={health === 'stale' ? C.red : health === 'ok' ? C.green : C.dim}>● {health === 'stale' ? '需處理' : health === 'ok' ? '正常' : '未檢查'}</Text></Text>
              </Box>}
              <Box key="h-sessions" hover={{ scope: 'help-sessions' }}>
                <Text color={C.dim}>其他工作階段 <Text color={s.blocked.length ? C.amber : C.green}>● {s.blocked.length ? `${s.blocked.length} 個停住` : '無'}</Text></Text>
              </Box>
            </Box>
          </Box>
          {rule}
          {/* One table for every tool: the tool's name on its first row, the meters lined up under each other. */}
          <Box key="q-claude" flexDirection="column">
            {(() => {
              let first = true
              const tool = () => { const t = first ? 'Claude' : ''; first = false; return t }
              const out: any[] = []
              if (ctx !== null) out.push(meterRow('ctx', tool(), { id: 'ctx', label: '上下文', used: ctx, hint: ctx >= ROTATE_PERCENT ? '建議換新主控台' : '' }))
              for (const l of limits) out.push(meterRow('lim' + l.kind, tool(), { id: /five/.test(l.kind) ? 'five_hour' : 'seven_day', label: limitName(l.kind), used: l.percent, hint: '', note: resetText(l.resetsAt, now) }))
              if (paneCache) {
                const warn = paneCache.view.warm && paneCache.view.leftMs <= CACHE_WARN_MS
                out.push(usageRow('cache', tool(), '快取', 'cache', <Box flexShrink={1}>
                  <Text color={paneCache.view.warm ? (warn ? C.amber : C.green) : C.red} wrap="truncate-end" bold={warn} backgroundColor={warn ? C.amberBg : undefined}>
                    {paneCache.view.warm ? `${leftText(paneCache.view.leftMs)} 後過期（${ttlLabel(paneCache.view.ttl, paneCache.clock.source)}）` : `已冷 ${leftText(paneCache.view.coldForMs)}`}
                    <Text color={C.dim}>{`　${tokensText(paneCache.clock.tokens)} tokens${paneCache.view.cost === null ? '' : `・${paneCache.view.warm ? '冷了' : '下則'}重寫約 ${usd(paneCache.view.cost)}`}`}</Text>
                  </Text>
                </Box>))
              }
              if (paneCacheNote) out.push(usageRow('cache-note', tool(), '快取', 'cache', <Box flexShrink={1}><Text color={C.dim} wrap="truncate-end">{paneCacheNote}</Text></Box>))
              if (typeof s.costUsd === 'number' && s.costUsd > 0 && !s.demo) {
                out.push(usageRow('cost', tool(), '花費', null, <Text color={C.text} wrap="truncate-end">{usd(s.costUsd)}<Text color={C.dim}>　依 API 牌價估算</Text></Text>))
              }
              if (first) out.push(usageRow('none', tool(), '', null, <Text color={C.dim}>下一則回應後顯示</Text>))
              return out
            })()}
          </Box>
          {(s.demo || codexShown) && ((s.codexQuota?.limits.length ?? 0) > 0 || s.codexQuota?.credits) && (
            <Box key="q-codex" flexDirection="column" marginTop={1}>
              {(() => {
                let first = true
                const tool = () => { const t = first ? 'Codex' : ''; first = false; return t }
                const out: any[] = []
                for (const l of s.codexQuota?.limits ?? []) {
                  out.push(meterRow('cq' + l.label, tool(), { id: 'codex_quota', label: l.label === 'Codex 週' ? '本週' : l.label.replace('Codex ', ''), used: l.percent, hint: '', note: resetText(l.resetsAt, now) }))
                }
                if (s.codexQuota?.credits) out.push(usageRow('cq-credits', tool(), '餘額', 'codex_quota', <Text color={C.text}>{`${s.codexQuota.credits} credits`}</Text>))
                return out
              })()}
            </Box>
          )}
          {s.blocked.map((b, i) => <Text key={'b' + i + '-' + b.name} color={C.amber} wrap="truncate-end">{`  ・${b.name}：${b.why}`}</Text>)}
          {codexShown && health !== 'ok' && s.codex.trim() && <Text color={health === 'stale' ? C.red : C.dim} wrap="truncate-end">{`  ・${s.codex}`}</Text>}
          {codexShown && s.companion && (s.companion.source !== 'configured' || s.companion.warning) && (
            <Text key="companion" color={s.companion.warning ? C.amber : C.dim} wrap="truncate-end">{`  ・companion：${s.companion.path || '（無）'}${s.companion.source === 'installed' || s.companion.source === 'cache' ? '（自動選用）' : ''}${s.companion.warning ? `　⚠ ${s.companion.warning}` : ''}`}</Text>
          )}
        </Box>

        <Box key="footer" flexDirection="column">
          {helpStrip}
          <Box justifyContent="space-between" columnGap={2} flexWrap="wrap">
            <Box gap={2} flexShrink={0}>
              <Button key="detail" plain dimColor label={detail ? '↥ 精簡' : '↧ 各專案詳細'} onPress={() => void update($, isDetail, v => !v)} />
              <Box gap={1}>
                {refreshing && rich && <ui.Client key="refresh-spin" module="./spinner.tsx" width={1} height={1} props={{ color: C.dim }} />}
                <Button key="refresh" plain dimColor label={refreshing ? '⟳ 更新中…' : '↻ 重新整理'} onPress={async () => {
                  if (await read($, isRefreshing)) return
                  await update($, isRefreshing, () => true)
                  try { await refresh($, options, true) } finally { await update($, isRefreshing, () => false) }
                  $.ui.toast('主控台已更新', { timeoutMs: 3000 })
                }} />
              </Box>
              <Button key="close" plain dimColor label="✕ 關閉" onPress={async () => {
                await $.ui.close({ id: PANE }).catch(() => {})
                await update($, isPaneOpen, () => false)
              }} />
            </Box>
            <Box key="version" gap={2} flexShrink={1} hover={{ scope: 'help-version' }}>
              <Box flexShrink={1}>
                <Text color={version?.phase === 'failed' ? C.red : hasUpdate(version) ? C.amber : C.faint} wrap="truncate-end">{versionLine(version)}</Text>
              </Box>
              {hasUpdate(version) && (version?.phase === 'idle' || version?.phase === 'failed') && (
                <Box flexShrink={0}><Button key="update" plain label={`⬆ 更新到 v${version!.latest}`} onPress={() => void runUpdate($)} /></Box>
              )}
              {(!version || ((version.phase === 'idle' || version.phase === 'failed') && !hasUpdate(version))) && (
                <Box flexShrink={0}><Button key="update-check" plain dimColor label="檢查更新" onPress={() => void checkUpdate($, true).catch(() => {})} /></Box>
              )}
            </Box>
          </Box>
        </Box>
      </Box>
    )
  })
}
