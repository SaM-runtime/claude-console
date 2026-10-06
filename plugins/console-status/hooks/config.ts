export type ConsoleConfig = {
  registryPath: string
  companionScript: string
  companionStateDir: string
  executor: 'claude' | 'codex'
  dispatchSettingsPath: string
  claudeSessionsPath: string
  modelsCachePath: string
  defaultModel: string
  defaultEffort: string
  companionStateRoots: string[]
}

/** Resolve user paths without shell expansion or a versioned plugin cache path. */
export function resolveConfig(options: Readonly<Record<string, unknown>>, home: string, local: string, temp = '/tmp'): ConsoleConfig {
  const value = (key: string, fallback = '') => typeof options[key] === 'string' && (options[key] as string).trim()
    ? (options[key] as string).trim() : fallback
  const path = (text: string) => text.replace(/\\/g, '/').replace(/^~(?=\/|$)/, home.replace(/\\/g, '/'))
  const legacyState = path(value('companionStateDir', local ? `${local}/Temp/codex-companion` : `${temp}/codex-companion`))
  let roots = [path('~/.claude/plugins/data/codex-openai-codex/state'), legacyState]
  try {
    const configured = typeof options.companionStateRoots === 'string' ? JSON.parse(options.companionStateRoots) : options.companionStateRoots
    if (Array.isArray(configured) && configured.length && configured.every(v => typeof v === 'string' && v.trim())) roots = configured.map(v => path(v.trim()))
  } catch { /* Invalid list falls back to both standard roots. */ }
  return {
    registryPath: path(value('registryPath', '~/.claude/handoffs/projects-scope.md')),
    companionScript: path(value('companionScript')),
    companionStateDir: legacyState,
    executor: value('executor', 'claude') === 'codex' ? 'codex' : 'claude',
    dispatchSettingsPath: path(value('dispatchSettingsPath', '~/.claude/handoffs/dispatch.json')),
    claudeSessionsPath: path(value('claudeSessionsPath', '~/.claude/handoffs/claude-sessions.json')),
    modelsCachePath: path(value('modelsCachePath', '~/.codex/models_cache.json')),
    defaultModel: typeof options.defaultModel === 'string' ? options.defaultModel.trim() : '',
    defaultEffort: typeof options.defaultEffort === 'string' ? options.defaultEffort.trim() : '',
    companionStateRoots: [...new Set(roots)],
  }
}

export type FallbackMode = 'ask' | 'claude' | 'off'
export type FallbackOptions = { codexFallback: FallbackMode; codexMinQuotaPercent: number }

/** Codex quota/broker fallback options; kept apart from resolveConfig so its shape stays stable. */
export function resolveFallbackOptions(options: Readonly<Record<string, unknown>>): FallbackOptions {
  const mode = typeof options.codexFallback === 'string' ? options.codexFallback.trim().toLowerCase() : ''
  const raw = options.codexMinQuotaPercent
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : NaN
  return {
    codexFallback: mode === 'claude' || mode === 'off' ? mode : 'ask',
    codexMinQuotaPercent: Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 10,
  }
}

/**
 * Read-only compatibility path, `codex-dispatch.json` beside the canonical dispatch file
 * (`~/.claude/handoffs/` by default); consulted only when the canonical file is missing.
 */
export function legacyDispatchPath(dispatchSettingsPath: string): string {
  const path = dispatchSettingsPath.replace(/\\/g, '/')
  const cut = path.lastIndexOf('/')
  return `${cut >= 0 ? path.slice(0, cut) : '.'}/codex-dispatch.json`
}
