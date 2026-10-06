// console-status: the Claude console's live overview, with selectable background executors.
// Reads the registry, project STATUS cards and the selected executor's job state.
// Band above the prompt + `/console` pane; toasts on changes. Shows on phones via Remote Control.
import { atom, read, update } from 'claude-code'
import type { Register, PluginOptions } from 'claude-code'
import { resolveConfig, resolveFallbackOptions, legacyDispatchPath } from './config'
import type { ConsoleConfig } from './config'
import { codexHealth, isActiveJob } from './logic'
import { parseModels, modelOptions, nextOption, effortOptions, readSettingsFiles, effectiveDispatch, setProjectOverride, nextProjectExecutor, executorSignature, projectOverride } from './dispatch'
import type { DispatchSettings, ProjectOverride } from './dispatch'
import { createExecutor, listWorkspaceJobs } from './executors'
import type { ExecutorDeps, ExecutorJob, ExecutorKind, DispatchOptions } from './executors'
import { actionKinds, actionLabel, dispatchBlockReason, dispatchPrompt, gatePrompt, workSignature, confirmationMatches, verificationArgs, verificationResult, outputTail, isManual, VERIFY_CONFIRM_MS, verifySignature, verifyTrusted } from './actions'
import { resolveCompanion } from './companion'
import type { CompanionResolution } from './companion'
import { decideCodexDispatch } from './fallback'
import { stateFormatIssues, stateFormatWarning } from './jobs'

import type { Project, Snapshot, ActionKind, VerificationResult } from '../types'
import { parseGate, parseCodexQuota, taskMeta, runLine, hasAsk, battery, resetText, nextProject, buildProject, counts, demoSnapshot, diffToasts, events, limitName, meter, next, parseRegistry, projectRoot, relevantBlocked, relevantCodex, rows, selectionContext, ROTATE_PERCENT } from './logic'
import type { Agent, State } from './logic'
import { projectColumnWidth, demoEvents } from './logic'
import { batteryBody } from './battery'
import { feedBody } from './feed'
import { trackRowChanges } from './presentation'
import { layoutBand } from './band'

const dispatchRevision = atom({ plugin: 'console-status', key: 'dispatchRevision' } as const, 0)

const PANE = 'console-status'
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
const actionPulse = atom({ plugin: 'console-status', key: 'actionPulse' } as const, 0)
const reviewRequests = atom({ plugin: 'console-status', key: 'reviewRequests' } as const, {})
const fallbackOffers = atom({ plugin: 'console-status', key: 'fallbackOffers' } as const, {})
const actionLocks = new Set<string>()
const earlyReviewStarts = new Map<string, string>()
let selectionClaim: string | null = null
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Slow probes (spawn processes) are cached between ticks; they reset on a reload, which is fine.
let codex = '…'
let agents: Agent[] = []
let codexQuotaText = ''
let companion: CompanionResolution | null = null
let lastSlow = 0
let demoActive = false
let dataGeneration = 0
let refreshOwner: { generation: number; queued: boolean } | null = null
let refreshTimer: { cancel(): void } | undefined
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
    const preflight = async (script: string) => {
      const ps = await $.process
        .run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${$.plugin.root}/scripts/codex-preflight.ps1`, ...(script ? ['-CompanionScript', script] : []), '-CompanionStateDir', config.companionStateDir], { timeoutMs: 30_000 })
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
      .run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${$.plugin.root}/scripts/codex-quota.ps1`], { timeoutMs: 30_000 })
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
      : name === 'TMPDIR' ? $.env.get('TMPDIR') : $.env.get('TEMP')) },
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
    if (registry === null) error = '找不到登錄表'
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
    const deps: ExecutorDeps = {
      run: (argv, init) => guarded(() => $.process.run(argv, init)),
      files: { read: path => guarded(() => $.fs.read(path)), list: path => guarded(() => $.fs.list(path)), write: (path, text) => guarded(() => $.fs.write(path, text)) },
      now: () => guarded(() => $.clock.now()),
    }
    const projects: Project[] = []
    stateFormatIssues.clear()
    const bases: string[] = []
    const roots: string[] = []
    const warnings: string[] = []
    for (const [index, { row, root }] of registryRows.entries()) {
      const card = await io.fs.read(row.statusPath).catch(() => null) as string | null
      const eff = effective[index]!
      bases.push(root.replace(/\/+$/, '').split('/').pop() ?? '')
      roots.push(root)
      const listing: ExecutorKind = eff.executor === 'manual' ? settings.executor : eff.executor
      const jobs = await guarded(() => workspaceJobs(listing, deps, withCompanion(config), root))
      for (const job of jobs) {
        if (!job.warning) continue
        const text = `${row.name}：${job.warning}`
        warnings.push(text)
      }
      const project: Project = {
        ...buildProject(row, card, jobs, now), executor: eff.executor, executorSource: eff.source,
        ...(row.executor ? { registryExecutor: row.executor } : {}),
      }
      for (const j of project.jobs) {
        if (j.kind !== 'running') continue
        const job = jobs.find(item => item.id === j.id && item.executor === j.executor)
        if (job) j.last = await createExecutor(job.executor ?? listing, deps, withCompanion(config)).lastLine(job).catch(() => '')
      }
      projects.push(project)
    }
    const usage: any = await io.session.usage().catch(() => null)
    const formatWarning = stateFormatWarning()
    const companionWarning = [companion?.warning, formatWarning].filter(Boolean).join('；')
    const cur: Snapshot = {
      at: now, executor: settings.executor, projects, blocked: relevantBlocked(agents, await io.session.id().catch(() => null) as string | null, roots, home), codex: codexInUse ? relevantCodex(codex, bases) : '',
      ...(codexInUse ? { codexInUse: true } : {}),
      ...(codexInUse && (companion || formatWarning) ? { companion: { path: companion?.path ?? '', source: companion?.source ?? 'none', ...(companionWarning ? { warning: companionWarning } : {}) } } : {}),
      contextPercent: usage?.context?.percent ?? null, error,
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

async function triggerAction($: any, options: PluginOptions, statusPath: string, kind: ActionKind, request: { useClaude?: boolean } = {}) {
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
      if (!await confirmed($, statusPath, workSignature(p), now, 3000, `${name}：再按一次確認（3 秒內）`)) return
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
    timer = $.clock.every(150, async () => {
      if (!(await read($, pendingActions))[statusPath]) { timer?.cancel(); return }
      await update($, actionPulse, value => (value + 1) % SPINNER.length)
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
        const fallback = await $.process.run(['cmd', '/c', 'start', '', p.statusPath.replace(/\//g, '\\')], { timeoutMs: 15_000 })
        if (fallback.exitCode !== 0) throw new Error(`無法開啟 STATUS.md（exit ${fallback.exitCode}）`)
      }
      await actionNotice($, `${name}：已請求開啟 STATUS.md`, true)
    }
  } catch (error) {
    await actionNotice($, `${project?.name ?? statusPath}：✕ ${error instanceof Error ? error.message : String(error)}`, false)
  } finally {
    if (!keepPending) timer?.cancel()
    try {
      if (ownsPending && !keepPending) await update($, pendingActions, values => { const next = { ...values }; delete next[statusPath]; return next })
    } finally { actionLocks.delete(statusPath) }
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    dataGeneration++
    refreshTimer?.cancel()
    if (actionLocks.size === 0) earlyReviewStarts.clear()
    selectionClaim = null
    await update($, reviewRequests, values => Object.fromEntries(Object.entries(values).filter(([path]) => actionLocks.has(path))))
    await update($, pendingActions, values => Object.fromEntries(Object.entries(values).filter(([path]) => actionLocks.has(path))))
    await update($, continueConfirmations, () => ({}))
    await update($, fallbackOffers, () => ({}))
    await loadTrust($)
    await $.command.register({ name: 'console', description: '主控台總覽：/console 開關面板；model / effort 派工設定；refresh 更新；band 橫帶；demo 示範' })
    refreshTimer = $.clock.every(TICK_MS, () => void refresh($, options))
    void refresh($, options, true)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin') return next(e)
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

  on('turn.complete', async ($, e, next) => {
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
    void refresh($, options)
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== 'console') return next(e)
    const arg = e.args.trim()
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
    action_continue: '3 秒內再按一次，請所選執行者依下一步繼續；只在無待決與關卡時可用，使用該執行者額度。',
    action_decide: '預填決策草稿並選取專案，補完後送出才使用 Claude 額度。',
    action_gate: '把關卡與專案 context 送給主控台審核，使用 Claude 額度；不會執行 release。',
    action_open: '用編輯器開啟專案 STATUS.md，不使用模型額度。',
    RUNNING: '執行中：該專案有 Claude 或 Codex 工作尚未結束；切換執行者仍不得重複派工。',
    SYNC: '待同步：執行者任務已結束，但結果還沒寫回 STATUS 卡片。',
    IDLE: '閒置：沒有任務、也沒有待決事項。',
    codex: 'Codex：companion broker 與已安裝的 Codex app 版本一致才算正常；過期時派工會失敗。',
    sessions: '其他工作階段：屬於主控台或已登記專案的其他 Claude Code session，正停在等批准或等輸入，要切到該 session 處理。與「需決策」不同：這是操作層面的卡住，不是專案決策。',
    ctx: '上下文：本主控台 session 還剩多少上下文。用掉一半以上建議換新主控台。',
    five_hour: '5 小時：Claude 帳號 5 小時滾動額度的剩餘量，到重置時間回滿。',
    seven_day: '本週：Claude 帳號每週額度的剩餘量。',
    codex_quota: 'Codex：Codex 帳號額度的剩餘量，取自最近一次 Codex 工作紀錄（每 5 分鐘讀一次）；很久沒用 Codex 時數字可能是舊的。',
  }
  const C = {
    text: '#CAD3E0', strong: '#E5EAF0', dim: '#6E7787', faint: '#4A5260', bar: '#1C222B',
    sel: '#22304A', hover: '#1A2029',
    amber: '#F0C674', amberBg: '#3A3120', teal: '#8BD5CA', tealBg: '#1D3734',
    blue: '#8AADF4', blueBg: '#212D45', purple: '#CA9EE6', purpleBg: '#33283F', grey: '#8A93A0', green: '#A6D189', red: '#E78284', orange: '#EF9F76',
  }
  const SHIMMER = ['#4E8F87', '#6FB3AA', '#9EE0D6', '#E6FFFB']
  const LABEL: Record<State, string> = { ACTION: '需決策', GATE: '待審核', RUNNING: '執行中', SYNC: '待同步', IDLE: '閒　置', NOCARD: '無狀態' }
  const FG: Record<State, string> = { ACTION: C.amber, GATE: C.purple, RUNNING: C.teal, SYNC: C.blue, IDLE: C.grey, NOCARD: C.red }
  const BG: Record<State, string | undefined> = { ACTION: C.amberBg, GATE: C.purpleBg, RUNNING: C.tealBg, SYNC: C.blueBg, IDLE: undefined, NOCARD: undefined }
  const SHOWN: State[] = ['ACTION', 'GATE', 'RUNNING', 'SYNC', 'IDLE']
  const EXECUTOR_TAG: Record<string, string> = { pane: '・面板', registry: '・登錄表', global: '' }
  const TONE: Record<string, string> = { amber: C.amber, teal: C.teal, blue: C.blue, red: C.red, green: C.green }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, nextHook) => {
    const generation = dataGeneration
    const demo = await demoEnabled($)
    const stored = await read($, snapshot)
    const s = demo && !stored?.demo ? demoSnapshot(await $.clock.now()) : stored
    if (e.props.hasSurvey || s === null || (await read($, isBandHidden))) return nextHook(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const paneOpen = await read($, isPaneOpen)
    const columns = Math.max(0, Math.floor(e.props.bodyColumns ?? 80))
    const band = layoutBand(s, { columns, demo, paneOpen })
    if (generation !== dataGeneration) return <Box height={1} width={columns} overflow="hidden"><Text color={C.dim} wrap="truncate-end">{demoActive ? ' 示範資料 ' : '讀取中…'}</Text></Box>
    return (
      <Box flexDirection="row" flexWrap="nowrap" width={columns} height={1} overflow="hidden">
        <Box gap={1} flexShrink={0} height={1}>
          {band.items.map(item => <Box key={'band-' + item.id} width={item.width} flexShrink={0} height={1} overflow="hidden">
            <Text wrap="truncate-end" color={item.id === 'demo' ? C.dim : item.id === 'next' ? C.amber : item.id === 'context' ? C.red : FG[item.id as State] ?? C.text}
              backgroundColor={item.id === 'demo' ? C.bar : undefined}>{item.text}</Text>
          </Box>)}
        </Box>
        <Box flexGrow={1} minWidth={band.items.length ? 1 : 0} />
        <Box width={band.buttonWidth} flexShrink={0} height={1} overflow="hidden">
          <Button key="pane" plain dimColor label={band.button} onPress={() => void openPane($)} />
        </Box>
      </Box>
    )
  })

  // Rows drawn by the Client module report presses, right-clicks and keys here.
  on('ui.message', async ($, e, nextHook) => {
    if (e.requestId !== PANE || e.element !== 'rows' || !e.data || typeof e.data !== 'object') return nextHook(e)
    const data = e.data as { press?: unknown; copy?: unknown; key?: unknown; hover?: unknown }
    const s = await read($, snapshot)
    const list = s ? rows(s) : []
    if (typeof data.press === 'string') {
      const id = data.press
      await update($, selected, v => (v === id ? null : id))
      await update($, cursor, () => list.findIndex(r => r.full === id))
    } else if ('hover' in data) {
      const id = typeof data.hover === 'string' ? data.hover : null
      await update($, hovered, () => id)
    } else if (typeof data.copy === 'string') {
      const id = data.copy
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
      if (k === 'escape') await update($, selected, () => null)
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
    const pulse = await read($, actionPulse)
    const offers = demo ? {} : await read($, fallbackOffers)
    const { config } = demo ? demoContext ?? { config: resolveConfig(options, '', '', '/tmp') } : await paths($, options)
    await read($, dispatchRevision)
    const dispatch = demo ? demoContext?.dispatch ?? { settings: { executor: s.executor ?? 'claude', model: '', effort: '' }, models: [] } : await readDispatch($, config)
    const cycle = async (field: GlobalField) => {
      try {
        const saved = await changeDispatch($, config, field)
        if (await demoEnabled($)) demoContext = { config, dispatch: await readDispatch($, config) }
        await update($, dispatchRevision, v => v + 1)
        if (field === 'executor') await refresh($, options, true)
        $.ui.toast(`派工設定已儲存：${saved.executor} · ${saved.model || '預設'} · ${saved.effort || '預設'}`)
      } catch (error) { $.ui.toast(`設定未儲存：${error instanceof Error ? error.message : String(error)}`) }
    }
    const cycleProject = async (p: Project) => {
      if (await demoEnabled($)) { $.ui.toast('示範資料：不變更專案設定。'); return }
      try {
        const root = projectRoot(p.statusPath)
        const nextExecutor = nextProjectExecutor(projectOverride(dispatch.settings, root)?.executor)
        const saved = await changeProjectDispatch($, config, root, 'executor', nextExecutor)
        await update($, fallbackOffers, values => { const rest = { ...values }; delete rest[p.statusPath]; return rest })
        await update($, dispatchRevision, v => v + 1)
        await refresh($, options, true)
        const eff = effectiveDispatch(saved, root, p.registryExecutor)
        $.ui.toast(`${p.name.replace(/\s.*$/, '')} 執行者：${eff.executor}（${SOURCE_LABEL[eff.source]}）`)
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
    const W = { state: 8, project: projectColumnWidth(list.map(row => row.project)), age: 4 }

    const specs = list.map(r => ({
      id: r.full,
      shimmer: r.state === 'RUNNING',
      breathe: r.state === 'ACTION' ? [C.amberBg, '#443925', '#4D412B'] : r.state === 'GATE' ? [C.purpleBg, '#3D304B', '#463755'] : undefined,
      changedAt: s.projects.find(project => project.name === r.full)?.changedAt,
      cells: [
        { t: ` ${LABEL[r.state]} `, c: FG[r.state], bg: BG[r.state], b: r.state !== 'IDLE', w: W.state },
        { t: r.project, c: r.state === 'IDLE' ? C.dim : C.strong, w: W.project },
        { t: r.item, c: r.state === 'IDLE' ? C.dim : C.text },
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
              <Box width={W.state}><Text bold color={FG[r.state]} backgroundColor={BG[r.state]}>{` ${LABEL[r.state]} `}</Text></Box>
              <Box width={W.project}>
                <Button key={'sel-' + r.project} plain label={r.project}
                  onPress={() => void update($, selected, v => (v === r.full ? null : r.full))} />
              </Box>
              <Box flexGrow={1} flexShrink={1}><Text color={C.text} wrap={detail ? 'wrap' : 'truncate-end'}>{r.item}</Text></Box>
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
      if (hasAsk(p)) return p.ask
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
          : <Text color={C.faint}>ⓘ 滑鼠移到標籤或專案列上，這裡會顯示說明或完整內容</Text>}
        {Object.keys(HELP).map(id => (
          <Box key={'tip-' + id} position="absolute" top={0} left={0} width="100%" height={1} paddingX={1}
            backgroundColor={C.bar} display="none" hover={{ scope: 'help-' + id, display: 'flex' }}>
            <Text color={C.blue} wrap="truncate-end">ⓘ {HELP[id]}</Text>
          </Box>
        ))}
      </Box>
    )
    // iPhone-style battery: body shows what is left, turns amber then red as it runs out; the nub follows.
    const Battery = ({ id, label, used, hint, note }: { id: string; label: string; used: number; hint: string; note?: string }) => {
      // Context goes low where rotation is advised (half used), red at 30% left.
      const b = id === 'ctx' ? battery(used, 10, 100 - ROTATE_PERCENT, 30) : battery(used, 10)
      const tone = b.tone === 'red' ? C.red : b.tone === 'low' ? C.orange : C.green
      return (
        <Box flexDirection="column">
        <Box gap={1} hover={{ scope: 'help-' + id }}>
          <Box width={9}><Text color={C.dim}>{label}</Text></Box>
          {rich ? <ui.Client key={'battery-' + id + '-' + label} module="./battery.tsx" width={16} height={1} props={{ percent: b.left, tone }} /> : batteryBody(b.left, tone, ui)}
          {hint !== '' && <Text color={C.red}>{hint}</Text>}
          {note ? <Text color={C.dim} wrap="truncate-end">{note}</Text> : null}
        </Box>
        </Box>
      )
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
      const label = blocked ? `⇢ 無法派工：${blocked}` : active?.kind === kind ? `${SPINNER[pulse % SPINNER.length]} ${actionLabel(kind, p)}…`
        : confirming ? '再按一次確認' : actionLabel(kind, p)
      return <Box key={'help-' + key} hover={{ scope: 'help-action_' + kind }}>
        <Button key={key} plain dimColor={!!active || !!blocked} label={label} onPress={async () => {
          if (!active && !blocked) await triggerAction($, options, p.statusPath, kind)
        }} />
      </Box>
    }
    const projectActions = (p: Project, prefix: string) => {
      const state = list.find(r => r.full === p.name)?.state ?? 'NOCARD'
      const kinds = actionKinds(p, state)
      if (!isManual(p) && dispatchBlockReason(p) && !kinds.includes('continue')) kinds.unshift('continue')
      const active = pending[p.statusPath]?.kind
      if (active && !kinds.includes(active)) kinds.unshift(active)
      const offer = p.executor === 'codex' ? offers[p.statusPath] : undefined
      return <Box flexDirection="column">
        <Box gap={2} flexWrap="wrap">
          {kinds.map(kind => actionButton(p, kind, prefix + kind))}
          {offer && <Box key={'help-' + prefix + 'fallback'} hover={{ scope: 'help-fallback' }}>
            <Button key={prefix + 'fallback'} plain dimColor={!!pending[p.statusPath]} label={`⇢ 改用 Claude 派工（${actionLabel(offer.kind, p).replace(/^⇢\s*/, '')}）`} onPress={async () => {
              if (!pending[p.statusPath]) await triggerAction($, options, p.statusPath, offer.kind, { useClaude: true })
            }} />
          </Box>}
        </Box>
        <Box gap={1} flexWrap="wrap">
          <Text color={C.dim}>執行者</Text>
          <Box hover={{ scope: 'help-project_executor' }}>
            <Button key={prefix + 'executor'} plain label={`${p.executor ?? dispatch.settings.executor}${EXECUTOR_TAG[p.executorSource ?? 'global'] ?? ''}`} onPress={() => cycleProject(p)} />
          </Box>
          {isManual(p) && <Text color={C.dim}>手動交接：面板不派工（CARD、驗證、關卡照常）</Text>}
          {offer && <Text color={C.amber} wrap="truncate-end">Codex 未派工：{offer.reason}</Text>}
        </Box>
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

    if (generation !== dataGeneration) return <Text color={C.dim}>{demoActive ? ' 示範資料 ' : '讀取中…'}</Text>
    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text bold color={C.strong}>主控台{demo && <Text color={C.dim} backgroundColor={C.bar}> 示範資料 </Text>}<Text color={C.dim}>　{s.projects.length} 個專案</Text></Text>
          <Text color={C.dim}>{time} 更新</Text>
        </Box>
        <Box gap={1} flexWrap="wrap">
          <Text color={C.dim}>執行者</Text>
          <Box hover={{ scope: 'help-dispatch_executor' }}>
            <Button key="dispatch-executor" plain label={dispatch.settings.executor} onPress={() => cycle('executor')} />
          </Box>
          <Text color={C.dim}>·</Text>
          <Box hover={{ scope: 'help-dispatch_model' }}>
            <Button key="dispatch-model" plain label={dispatch.settings.model || '預設'} onPress={() => cycle('model')} />
          </Box>
          <Text color={C.dim}>·</Text>
          <Box hover={{ scope: 'help-dispatch_effort' }}>
            <Button key="dispatch-effort" plain label={dispatch.settings.effort || '預設'} onPress={() => cycle('effort')} />
          </Box>
        </Box>

        <Box flexDirection="column" backgroundColor={C.bar} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={n ? C.amber : C.green}>{n ? '下一步' : '就緒'}</Text>
            {targetProject && primaryAction && actionButton(targetProject, primaryAction, 'next-action')}
          </Box>
          <Text color={C.strong} wrap={detail ? 'wrap' : 'truncate-end'}>{n ?? '目前沒有需要處理的項目'}</Text>
        </Box>

        <Box gap={3} flexWrap="wrap">
          {SHOWN.map(k => (
            <Box key={'k' + k} hover={{ scope: 'help-' + k }}>
              <Text color={c[k] ? FG[k] : C.faint}>● {LABEL[k].replace('　', '')} <Text bold>{c[k]}</Text></Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Box gap={1} paddingRight={1}>
            <Box width={W.state}><Text color={C.dim}> 狀態</Text></Box>
            <Box width={W.project}><Text color={C.dim}>專案</Text></Box>
            <Box flexGrow={1}><Text color={C.dim}>項目</Text></Box>
            <Box width={W.age} justifyContent="flex-end"><Text color={C.dim}>更新</Text></Box>
          </Box>
          {rule}
          {table}
          {rule}
          {menuProject && (
            <Box key="menu" flexDirection="column" borderStyle="round" borderColor={C.blue} paddingX={1} marginTop={1}>
              <Text color={C.blue}>{menuProject.name.replace(/\s.*$/, '')}　動作</Text>
              {projectActions(menuProject, 'm-')}
              {verificationView(menuProject)}
              <Button key="m-close" plain dimColor label="✕" onPress={() => void update($, menuFor, () => null)} />
            </Box>
          )}
          {sel !== null
            ? (
              <Box justifyContent="space-between">
                <Text color={C.blue} wrap="truncate-end">◆ 已選取 {sel.replace(/\s.*$/, '')}<Text color={C.dim}>　下一則提示會附上此專案</Text></Text>
                <Button key="unselect" plain dimColor label="✕ 取消" onPress={() => void update($, selected, () => null)} />
              </Box>
            )
            : <Text color={C.faint} wrap="truncate-end">{rich ? '點選或 ↑↓ Enter 選取專案・右鍵開啟動作選單' : '點專案名稱即可選取'}</Text>}
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
                    <Box width={W.state}><Text color={FG[row.state]}>{` ${LABEL[row.state]} `}</Text></Box>
                    <Button key={'df-' + p.name} plain dimColor label={'▸ ' + row.project} onPress={() => void update($, cursor, () => idx)} />
                  </Box>
                )
              }
              const field = (label: string, value: string, color: string) => value ? (
                <Box key={label} gap={2}>
                  <Box width={6} flexShrink={0}><Text color={C.dim}>{label}</Text></Box>
                  <Box flexGrow={1} flexShrink={1}><Text color={color} wrap="wrap">{value}</Text></Box>
                </Box>
              ) : null
              const run = p.jobs.find(j => j.kind === 'running')
              return (
                <Box key={'d-' + p.name} flexDirection="column" borderStyle="round" borderColor={row.state === 'IDLE' ? C.faint : FG[row.state]} paddingX={1} marginY={1}>
                  <Box justifyContent="space-between" gap={1}>
                    <Box gap={1} flexShrink={1}>
                      <Text bold color={FG[row.state]} backgroundColor={BG[row.state]}>{` ${LABEL[row.state]} `}</Text>
                      <Text bold color={C.strong} wrap="truncate-end">{p.name}</Text>
                    </Box>
                    <Text color={C.dim}>{row.age && row.age !== '—' ? `${row.age}前更新` : '無卡片'}</Text>
                  </Box>
                  <Box flexDirection="column" marginTop={1}>
                    {field('狀態', p.state, C.text)}
                    {field('待決', hasAsk(p) ? p.ask : '', C.amber)}
                    {field('關卡', parseGate(p.gate) ? p.gate ?? '' : '', C.purple)}
                    {field('下一步', p.next, C.text)}
                    {field('同步', !run && p.jobs.some(j => j.kind === 'newer') ? '執行者已結束，結果未寫回 STATUS' : '', C.blue)}
                  </Box>
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
            <Text color={C.dim}>動態</Text>
            {(() => {
              const props = { events: feed.slice(0, 5).map(ev => ({ at: ev.at, text: ev.text, color: TONE[ev.tone] ?? C.text })), now, normal: C.text, bright: C.strong, dim: C.dim }
              return rich ? <ui.Client key="feed" module="./feed.tsx" width="100%" props={props} /> : feedBody(props, now, ui, false)
            })()}
          </Box>
        )}

        <Box flexDirection="column">
          {rule}
          <Box gap={3} flexWrap="wrap">
            {codexShown && <Box key="h-codex" hover={{ scope: 'help-codex' }}>
              <Text color={C.dim}>Codex <Text color={health === 'stale' ? C.red : health === 'ok' ? C.green : C.dim}>● {health === 'stale' ? '需處理' : health === 'ok' ? '正常' : '未檢查'}</Text></Text>
            </Box>}
            <Box key="h-sessions" hover={{ scope: 'help-sessions' }}>
              <Text color={C.dim}>其他工作階段 <Text color={s.blocked.length ? C.amber : C.green}>● {s.blocked.length ? `${s.blocked.length} 個停住` : '無'}</Text></Text>
            </Box>
          </Box>
          {/* Quota grouped per tool, each in its own titled frame. */}
          <Box key="quota" flexWrap="wrap" gap={1}>
            <Box key="q-claude" flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1}>
              <Text bold color={C.strong}>Claude</Text>
              {ctx !== null && <Battery id="ctx" label="上下文" used={ctx} hint={ctx >= ROTATE_PERCENT ? '建議換新主控台' : ''} />}
              {limits.map(l => <Battery key={'lim' + l.kind} id={/five/.test(l.kind) ? 'five_hour' : 'seven_day'} label={limitName(l.kind)} used={l.percent} hint="" note={resetText(l.resetsAt, now)} />)}
            </Box>
            {(s.demo || codexShown) && ((s.codexQuota?.limits.length ?? 0) > 0 || s.codexQuota?.credits) && (
              <Box key="q-codex" flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1}>
                <Box gap={1}>
                  <Text bold color={C.strong}>Codex</Text>
                </Box>
                {s.codexQuota?.credits ? <Text color={C.dim}>餘額 {s.codexQuota.credits} credits</Text> : null}
                {(s.codexQuota?.limits ?? []).map(l => (
                  <Battery key={'cq' + l.label} id="codex_quota" label={l.label === 'Codex 週' ? '本週' : l.label.replace('Codex ', '')} used={l.percent} hint=""
                    note={resetText(l.resetsAt, now)} />
                ))}
              </Box>
            )}
          </Box>
          {s.blocked.map((b, i) => <Text key={'b' + i + '-' + b.name} color={C.amber} wrap="truncate-end">{`  ・${b.name}：${b.why}`}</Text>)}
          {codexShown && health !== 'ok' && s.codex.trim() && <Text color={health === 'stale' ? C.red : C.dim} wrap="truncate-end">{`  ・${s.codex}`}</Text>}
          {codexShown && s.companion && (s.companion.source !== 'configured' || s.companion.warning) && (
            <Text key="companion" color={s.companion.warning ? C.amber : C.dim} wrap="truncate-end">{`  ・companion：${s.companion.path || '（無）'}${s.companion.source === 'installed' || s.companion.source === 'cache' ? '（自動選用）' : ''}${s.companion.warning ? `　⚠ ${s.companion.warning}` : ''}`}</Text>
          )}
        </Box>

        <Box key="footer" flexDirection="column" gap={1}>
        {helpStrip}
        <Box gap={2}>
          <Button key="detail" plain dimColor label={detail ? '↥ 精簡' : '↧ 各專案詳細'} onPress={() => void update($, isDetail, v => !v)} />
          <Box gap={1}>
          {refreshing && rich && <ui.Client key="refresh-spin" module="./spinner.tsx" width={1} height={1} props={{ color: C.dim }} />}
          <Button key="refresh" plain dimColor label={refreshing ? '⟳ 更新中…' : '↻ 更新'} onPress={async () => {
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
        </Box>
      </Box>
    )
  })
}
