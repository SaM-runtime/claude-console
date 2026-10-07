// Self-update: the installed version against the marketplace's main branch, and the update itself.
// `claude plugin update` installs what the marketplace's default branch declares, so that manifest
// (not the newest GitHub Release) is the version to compare with.
import type { UpdateInfo } from '../types'

export const PLUGIN_ID = 'console-status'
export const LATEST_MANIFEST_URL = 'https://raw.githubusercontent.com/SaM-runtime/claude-console/main/plugins/console-status/.claude-plugin/plugin.json'
export const RELEASES_URL = 'https://github.com/SaM-runtime/claude-console/releases'
/** A session re-checks this often; the pane's button checks at once. */
export const UPDATE_CHECK_MS = 30 * 60 * 1000

/** `version` of a plugin.json text, or null when it is not one. */
export function manifestVersion(text: string | null | undefined): string | null {
  if (!text) return null
  try {
    const version = JSON.parse(text)?.version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version.trim()) ? version.trim() : null
  } catch { return null }
}

/** Numeric x.y.z comparison; a pre-release suffix sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.replace(/^v/, '').split('-', 2)
    return { parts: core.split('.').map(n => Number(n) || 0), pre }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.parts[i] ?? 0) !== (y.parts[i] ?? 0)) return (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
  if (x.pre === y.pre) return 0
  return !x.pre ? 1 : !y.pre ? -1 : x.pre < y.pre ? -1 : 1
}

export const hasUpdate = (info: UpdateInfo | null | undefined) =>
  !!info?.current && !!info.latest && compareVersions(info.latest, info.current) > 0

export const MARKETPLACE = 'claude-console'

/** Refreshes the marketplace's copy of the repository first, so the update sees the newest main. */
export function marketplaceUpdateArgs(): string[] {
  return ['claude', 'plugin', 'marketplace', 'update', MARKETPLACE]
}

export function updateArgs(): string[] {
  return ['claude', 'plugin', 'update', PLUGIN_ID, '--json']
}

export function pluginListArgs(): string[] {
  return ['claude', 'plugin', 'list', '--json']
}

const slashes = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * The folder console-status is read from when it is not a marketplace copy: `readFromFolder` of
 * `claude plugin list --json` (a marketplace added from a local directory), else the loaded root
 * itself when it is not listed and outside Claude Code's plugin cache (`--plugin-dir`). Null for an
 * installed marketplace copy.
 */
export function localFolder(listJson: string | null | undefined, root: string): string | null {
  try {
    const list = JSON.parse(listJson ?? '')
    const entry = Array.isArray(list) ? list.find((item: any) => typeof item?.id === 'string' && item.id.split('@')[0] === PLUGIN_ID && item.enabled !== false) : null
    if (typeof entry?.readFromFolder === 'string' && entry.readFromFolder.trim()) return slashes(entry.readFromFolder.trim())
    if (entry) return null
  } catch { /* no list: judge by the root */ }
  const r = slashes(root)
  return r && !/\/plugins\/cache\//i.test(r) ? r : null
}

export function gitTopArgs(folder: string): string[] {
  return ['git', '-C', folder, 'rev-parse', '--show-toplevel']
}

/** Fast-forward only: a checkout with its own commits or conflicting edits is left for the person. */
export function gitPullArgs(top: string): string[] {
  return ['git', '-C', top, 'pull', '--ff-only']
}

export function gitBranchArgs(top: string): string[] {
  return ['git', '-C', top, 'rev-parse', '--abbrev-ref', 'HEAD']
}

/** `claude plugin update --json`'s result line: whether it installed something new. */
export function updateOutcome(stdout: string): { updated: boolean; message: string } | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    try {
      const data = JSON.parse(line)
      if (data && typeof data === 'object' && typeof data.updateOutcome === 'string') return { updated: data.updateOutcome === 'updated', message: String(data.message ?? '') }
    } catch { /* not the JSON line */ }
  }
  return null
}

/** One short line for the pane's version row. */
export function versionLine(info: UpdateInfo | null): string {
  if (!info) return '版本：檢查中…'
  const current = info.current ? `v${info.current}` : '版本不明'
  switch (info.phase) {
    case 'checking': return `${current}　檢查更新中…`
    case 'updating': return `${current}　更新到 v${info.latest ?? '最新版'} 中…`
    case 'updated': return `${current} → v${info.latest ?? '最新版'}　已安裝，重新載入中…`
    case 'failed': return `${current}　更新失敗：${info.message ?? '未知錯誤'}`
  }
  if (info.error) return `${current}　無法檢查最新版（${info.error}）`
  if (hasUpdate(info)) return `${current}　有新版 v${info.latest}`
  return info.latest ? `${current}　已是最新版` : current
}
