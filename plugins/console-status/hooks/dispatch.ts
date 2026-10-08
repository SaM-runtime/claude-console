
export type Executor = 'claude' | 'codex'
/** A project may also be `manual`: the panel never dispatches it (CARD, verify and gates still work). */
export type ProjectExecutor = Executor | 'manual'
/** A sync's own model/effort for one executor; blank fields fall back to the normal dispatch. */
export type SyncModel = { model?: string; effort?: string }
/**
 * `sync` in dispatch.json (globally or per project): a cheaper model for 同步 STATUS, per executor,
 * and whether the sync runs in a new small session (`fresh`) or resumes the project's (`resume`).
 * Nothing set means a sync dispatches exactly like a continue does.
 */
export type SyncSettings = { session?: 'fresh' | 'resume'; claude?: SyncModel; codex?: SyncModel }
export type ProjectOverride = { executor?: ProjectExecutor; model?: string; effort?: string; sync?: SyncSettings }
/**
 * The canonical dispatch file. `projects` is optional and keyed by project root;
 * a file without it (the 0.1 flat shape) keeps working unchanged.
 */
export type DispatchSettings = { executor: Executor; model: string; effort: string; sync?: SyncSettings; projects?: Record<string, ProjectOverride> }
export type ExecutorSource = 'pane' | 'registry' | 'global'
export type EffectiveDispatch = { executor: ProjectExecutor; model: string; effort: string; source: ExecutorSource }
export const PROJECT_EXECUTORS: ProjectExecutor[] = ['claude', 'codex', 'manual']
export type ModelOption = { model: string; efforts: string[] }
const CLAUDE_MODELS: ModelOption[] = ['fable', 'opus', 'sonnet', 'haiku'].map(model => ({ model, efforts: [] }))
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']
const clean = (value: unknown): string | null => typeof value === 'string' && !/[\r\n\x00]/.test(value) ? value.trim() : null
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function parseSettings(text: string | null, defaults: DispatchSettings): DispatchSettings {
  try {
    const data = JSON.parse((text ?? '').replace(/^\uFEFF/, ''))
    if (object(data)) {
      const executor = data.executor === 'claude' || data.executor === 'codex' ? data.executor : defaults.executor
      const settings: DispatchSettings = { executor, model: clean(data.model) ?? defaults.model, effort: clean(data.effort) ?? defaults.effort }
      const sync = parseSync(data.sync)
      if (sync) settings.sync = sync
      const projects = parseProjects(data.projects)
      if (projects) settings.projects = projects
      return settings
    }
  } catch { /* Missing or partially written file: use user defaults. */ }
  return { ...defaults }
}

export type SettingsSource = 'canonical' | 'legacy' | 'defaults'

/**
 * `canonical` / `legacy` are file texts, or null when that file is missing (unreadable).
 * The legacy codex-dispatch.json is read only when the canonical file is missing; it is never
 * written. A legacy file without an `executor` field was a Codex-only file, so it means codex.
 */
export function readSettingsFiles(canonical: string | null, legacy: string | null, defaults: DispatchSettings): { settings: DispatchSettings; source: SettingsSource } {
  if (canonical !== null) return { settings: parseSettings(canonical, defaults), source: 'canonical' }
  if (legacy !== null) {
    try {
      if (object(JSON.parse(legacy.replace(/^﻿/, '')))) return { settings: parseSettings(legacy, { ...defaults, executor: 'codex' }), source: 'legacy' }
    } catch { /* Malformed legacy file: defaults. */ }
  }
  return { settings: { ...defaults }, source: 'defaults' }
}

function parseSyncModel(value: unknown): SyncModel | null {
  if (!object(value)) return null
  const out: SyncModel = {}
  const model = clean(value.model)
  const effort = clean(value.effort)
  if (model) out.model = model
  if (effort) out.effort = effort
  return Object.keys(out).length ? out : null
}

function parseSync(value: unknown): SyncSettings | null {
  if (!object(value)) return null
  const out: SyncSettings = {}
  if (value.session === 'fresh' || value.session === 'resume') out.session = value.session
  for (const executor of ['claude', 'codex'] as const) {
    const model = parseSyncModel(value[executor])
    if (model) out[executor] = model
  }
  return Object.keys(out).length ? out : null
}

function parseProjects(value: unknown): Record<string, ProjectOverride> | null {
  if (!object(value)) return null
  const out: Record<string, ProjectOverride> = {}
  for (const [root, raw] of Object.entries(value)) {
    if (!root.trim() || !object(raw)) continue
    const override: ProjectOverride = {}
    if (raw.executor === 'claude' || raw.executor === 'codex' || raw.executor === 'manual') override.executor = raw.executor
    const model = clean(raw.model)
    const effort = clean(raw.effort)
    if (model) override.model = model
    if (effort) override.effort = effort
    const sync = parseSync(raw.sync)
    if (sync) override.sync = sync
    if (Object.keys(override).length) out[root] = override
  }
  return Object.keys(out).length ? out : null
}

/** Parse a registry `Executor` cell; blank or unknown text means the global default. */
export function parseProjectExecutor(value: string | undefined): ProjectExecutor | undefined {
  const text = (value ?? '').trim().toLowerCase()
  return text === 'claude' || text === 'codex' || text === 'manual' ? text : undefined
}

const slashRoot = (root: string) => root.replace(/\\/g, '/').replace(/\/+$/, '')

/** Same normalization as the executors use: forward slashes, Windows drive and UNC paths case-folded. */
export function projectKey(root: string): string {
  const normalized = slashRoot(root)
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function projectOverride(settings: DispatchSettings, root: string): ProjectOverride | undefined {
  const key = projectKey(root)
  const entry = Object.entries(settings.projects ?? {}).find(([candidate]) => projectKey(candidate) === key)
  return entry?.[1]
}

/**
 * Precedence: pane override in dispatch.json > registry `Executor` column > global executor.
 * Model and effort follow the same chain; a project whose executor differs from the global one
 * does not inherit the global model/effort (they belong to the other executor).
 */
export function effectiveDispatch(settings: DispatchSettings, root: string, registry?: ProjectExecutor): EffectiveDispatch {
  const override = projectOverride(settings, root)
  const executor = override?.executor ?? registry ?? settings.executor
  const source: ExecutorSource = override?.executor ? 'pane' : registry ? 'registry' : 'global'
  const inherit = executor === settings.executor
  return {
    executor, source,
    model: override?.model ?? (inherit ? settings.model : ''),
    effort: override?.effort ?? (inherit ? settings.effort : ''),
  }
}

export type SyncDispatch = {
  model: string
  effort: string
  /** A new small session that reads STATUS and the executor digest, instead of resuming the project's. */
  fresh: boolean
  /** The sync has a model or effort of its own (not the normal dispatch's). */
  custom: boolean
}

/**
 * How a 同步 STATUS dispatch runs on `executor`: the project's `sync` fields over the global ones, each blank
 * field falling back to `base` (the model/effort a continue would use). On Claude, `session` defaults to `fresh` once
 * a sync model or effort is set (a cheap model in the project's long session would re-cache all of it). Codex stays on
 * `resume` unless set: the next continue's `--resume-last` would pick up a fresh sync's thread instead of the work's.
 */
export function syncDispatch(settings: DispatchSettings, root: string, executor: Executor, base: { model?: string; effort?: string }): SyncDispatch {
  const project = projectOverride(settings, root)?.sync
  const own = { ...settings.sync?.[executor], ...project?.[executor] }
  const custom = !!(own.model || own.effort)
  const session = project?.session ?? settings.sync?.session
  return {
    model: own.model || base.model || '',
    effort: own.effort || base.effort || '',
    fresh: session ? session === 'fresh' : custom && executor === 'claude',
    custom,
  }
}

/** Set (or with '' clear) the global sync model, effort or session; empty objects are dropped so the file stays minimal. */
export function setSyncSetting(settings: DispatchSettings, field: 'model' | 'effort' | 'session', value: string, executor: Executor = settings.executor): DispatchSettings {
  const text = value.trim()
  if (/[\r\n\x00]/.test(text)) throw new Error('設定值必須是單行文字。')
  const sync: SyncSettings = { ...settings.sync }
  if (field === 'session') {
    if (text && text !== 'fresh' && text !== 'resume') throw new Error('session 可選：fresh（新的小 session）、resume（接續專案 session）；空白＝有同步模型時 fresh')
    if (text) sync.session = text as 'fresh' | 'resume'
    else delete sync.session
  } else {
    const own: SyncModel = { ...sync[executor] }
    if (text) own[field] = text
    else delete own[field]
    if (Object.keys(own).length) sync[executor] = own
    else delete sync[executor]
  }
  const { sync: _old, ...rest } = settings
  return Object.keys(sync).length ? { ...rest, sync } : rest
}

/** Set (or with an empty value, clear) one field of a project's override, keeping the file minimal. */
export function setProjectOverride(settings: DispatchSettings, root: string, field: Exclude<keyof ProjectOverride, 'sync'>, value: string): DispatchSettings {
  const key = projectKey(root)
  const projects: Record<string, ProjectOverride> = {}
  let storedKey = slashRoot(root)
  for (const [candidate, override] of Object.entries(settings.projects ?? {})) {
    if (projectKey(candidate) === key) storedKey = candidate
    else projects[candidate] = { ...override }
  }
  const current = { ...projectOverride(settings, root) }
  if (field === 'executor') {
    const next = parseProjectExecutor(value)
    if (value.trim() && !next) throw new Error('executor 可選：claude, codex, manual（空白＝沿用預設）')
    if (next !== current.executor) { delete current.model; delete current.effort }
    if (next) current.executor = next
    else delete current.executor
  } else if (value.trim()) current[field] = value.trim()
  else delete current[field]
  if (Object.keys(current).length) projects[storedKey] = current
  const { projects: _old, ...rest } = settings
  return Object.keys(projects).length ? { ...rest, projects } : rest
}

/** Pane cycle for one project: inherit -> claude -> codex -> manual -> inherit. */
export function nextProjectExecutor(current: ProjectExecutor | undefined): ProjectExecutor | '' {
  const order: (ProjectExecutor | '')[] = ['', ...PROJECT_EXECUTORS]
  return order[(order.indexOf(current ?? '') + 1) % order.length] ?? ''
}

/** Executor selections only: a refresh that sees this change mid-flight is redone. */
export function executorSignature(settings: DispatchSettings): string {
  return JSON.stringify([settings.executor, Object.entries(settings.projects ?? {}).map(([root, o]) => [projectKey(root), o.executor ?? ''])])
}

export function parseModels(text: string | null): ModelOption[] {
  try {
    const data = JSON.parse((text ?? '').replace(/^\uFEFF/, ''))
    const entries = Array.isArray(data) ? data : data?.models
    if (!Array.isArray(entries)) return []
    const result: ModelOption[] = []
    for (const entry of entries) {
      if (!object(entry)) continue
      const model = clean(entry.slug) || clean(entry.id)
      if (!model || result.some(m => m.model === model)) continue
      const levels = entry.supported_reasoning_levels
      const efforts = Array.isArray(levels) ? levels.map(v => clean(object(v) ? v.effort : v)).filter((v): v is string => !!v) : []
      result.push({ model, efforts: [...new Set(efforts)] })
    }
    return result
  } catch { return [] }
}

/** Models exposed by the selected executor; Claude aliases come from its CLI. */
export function modelOptions(executor: Executor, codexModels: ModelOption[]): ModelOption[] {
  return executor === 'claude' ? CLAUDE_MODELS.map(option => ({ ...option, efforts: [...option.efforts] })) : codexModels
}

export function effortOptions(executor: Executor, models: ModelOption[], model: string): string[] {
  if (executor === 'claude') return [...CLAUDE_EFFORTS]
  const options = models.find(m => m.model === model)?.efforts
  return options?.length ? options : [...CODEX_EFFORTS]
}

export function nextOption(current: string, options: string[]): string {
  return options.length ? options[(options.indexOf(current) + 1) % options.length] : current
}

