// Locate codex-companion.mjs when the configured path is empty or stale (the Codex plugin
// installs each version into its own cache folder, so a pinned path goes stale on update).

export type CompanionFiles = {
  read(path: string): Promise<string>
  list(path: string): Promise<{ name: string; kind: string }[]>
}
export type CompanionSource = 'configured' | 'installed' | 'cache' | 'none'
export type CompanionResolution = { path: string; source: CompanionSource; version?: string; warning?: string }

const PLUGIN_ID = 'codex@openai-codex'
const SCRIPT = 'scripts/codex-companion.mjs'
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const slash = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')

/** Semantic-version order (1.0.10 > 1.0.9; a pre-release sorts before its release); null if not semver. */
export function compareSemver(a: string, b: string): number | null {
  const x = a.trim().match(SEMVER)
  const y = b.trim().match(SEMVER)
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d) return Math.sign(d)
  }
  const pa = x[4], pb = y[4]
  if (!pa || !pb) return pa === pb ? 0 : pa ? -1 : 1
  const left = pa.split('.'), right = pb.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i], r = right[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r)
    if (ln && rn && Number(l) !== Number(r)) return Math.sign(Number(l) - Number(r))
    if (ln !== rn) return ln ? -1 : 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/** The highest semantic version among names; non-semver names are ignored. */
export function newestVersion(names: string[]): string | null {
  let best: string | null = null
  for (const name of names) {
    if (compareSemver(name, name) === null) continue
    if (best === null || (compareSemver(name, best) ?? 0) > 0) best = name
  }
  return best
}

/** Install paths recorded for the Codex plugin, newest version first. */
export function installedPaths(text: string | null): { path: string; version?: string }[] {
  try {
    const data = JSON.parse((text ?? '').replace(/^﻿/, ''))
    const entries = data?.plugins?.[PLUGIN_ID]
    const list = Array.isArray(entries) ? entries : entries && typeof entries === 'object' ? [entries] : []
    const out: { path: string; version?: string }[] = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || typeof entry.installPath !== 'string' || !entry.installPath.trim()) continue
      const version = typeof entry.version === 'string' && compareSemver(entry.version, entry.version) !== null ? entry.version
        : slash(entry.installPath).split('/').pop()
      out.push({ path: slash(entry.installPath), ...(version && compareSemver(version, version) !== null ? { version } : {}) })
    }
    return out.sort((a, b) => (b.version && a.version ? compareSemver(b.version, a.version) ?? 0 : a.version ? -1 : b.version ? 1 : 0))
  } catch { return [] }
}

async function fileExists(files: CompanionFiles, path: string): Promise<boolean> {
  const normalized = slash(path)
  const cut = normalized.lastIndexOf('/')
  if (cut <= 0) return false
  const entries = await files.list(normalized.slice(0, cut)).catch(() => [])
  const name = normalized.slice(cut + 1).toLowerCase()
  return entries.some(entry => entry?.kind !== 'dir' && typeof entry?.name === 'string' && entry.name.toLowerCase() === name)
}

/**
 * Pick the companion script. `configuredMissing` comes from a caller that already knows the
 * configured file is absent (the preflight's `companion=MISSING`). An existing configured path wins;
 * otherwise the newest semver among installed_plugins.json install paths and
 * `~/.claude/plugins/cache/openai-codex/codex/<version>/` that actually contains the script.
 */
export async function resolveCompanion(files: CompanionFiles, home: string, configured: string, configuredMissing = false): Promise<CompanionResolution> {
  const wanted = slash(configured.trim())
  if (wanted && !configuredMissing) return { path: wanted, source: 'configured' }
  const base = slash(home)
  const candidates: { path: string; version: string; source: CompanionSource }[] = []
  const installed = installedPaths(await files.read(`${base}/.claude/plugins/installed_plugins.json`).catch(() => null))
  for (const entry of installed) {
    if (entry.version) candidates.push({ path: `${entry.path}/${SCRIPT}`, version: entry.version, source: 'installed' })
  }
  const cacheRoot = `${base}/.claude/plugins/cache/openai-codex/codex`
  const versions = (await files.list(cacheRoot).catch(() => []))
    .filter(entry => entry?.kind === 'dir' && typeof entry.name === 'string' && compareSemver(entry.name, entry.name) !== null)
    .map(entry => entry.name)
  for (const version of versions) candidates.push({ path: `${cacheRoot}/${version}/${SCRIPT}`, version, source: 'cache' })
  // Newest first; on a tie the installed record wins because it was pushed first and sort is stable.
  candidates.sort((a, b) => compareSemver(b.version, a.version) ?? 0)
  for (const candidate of candidates) {
    if (wanted && candidate.path.toLowerCase() === wanted.toLowerCase()) continue
    if (!await fileExists(files, candidate.path)) continue
    return {
      path: candidate.path, source: candidate.source, version: candidate.version,
      ...(wanted ? { warning: `configured companionScript not found (${wanted}); using ${candidate.version}` } : {}),
    }
  }
  return wanted
    ? { path: wanted, source: 'configured', warning: `configured companionScript not found (${wanted}) and no installed Codex plugin was found` }
    : { path: '', source: 'none', warning: 'companionScript is empty and no installed Codex plugin was found' }
}
