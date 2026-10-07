// Self-update: the installed version against the marketplace's main branch, and the update itself.
// `claude plugin update` installs what the marketplace's default branch declares, so that manifest
// (not the newest GitHub Release) is the version to compare with.
import type { UpdateInfo } from '../types'

export const PLUGIN_ID = 'console-status'
export const LATEST_MANIFEST_URL = 'https://raw.githubusercontent.com/SaM-runtime/claude-console/main/plugins/console-status/.claude-plugin/plugin.json'
export const RELEASES_URL = 'https://github.com/SaM-runtime/claude-console/releases'
/** A session re-checks this often; the pane's button checks at once. */
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000

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
  return ['claude', 'plugin', 'update', PLUGIN_ID]
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
