// Per-platform commands: PowerShell scripts on Windows, POSIX sh scripts on macOS / Linux.

export const isWindowsOs = (os: string | null | undefined) => os === 'Windows_NT'

export function preflightArgs(pluginRoot: string, windows: boolean, script: string, stateDir: string, stateRoots: string[]): string[] {
  if (windows) {
    return ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${pluginRoot}/scripts/codex-preflight.ps1`,
      ...(script ? ['-CompanionScript', script] : []), '-CompanionStateDir', stateDir]
  }
  const dirs = [...new Set([stateDir, ...stateRoots].filter(Boolean))]
  return ['sh', `${pluginRoot}/scripts/codex-preflight.sh`, ...(script ? ['--companion-script', script] : []), ...dirs.flatMap(dir => ['--state-dir', dir])]
}

export function quotaArgs(pluginRoot: string, windows: boolean): string[] {
  return windows
    ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${pluginRoot}/scripts/codex-quota.ps1`]
    : ['sh', `${pluginRoot}/scripts/codex-quota.sh`]
}

/** Fallback when the `code` editor CLI is unavailable: the OS default handler. */
export function openFallbackArgs(path: string, windows: boolean): string[] {
  return windows ? ['cmd', '/c', 'start', '', path.replace(/\//g, '\\')] : ['open', path]
}
