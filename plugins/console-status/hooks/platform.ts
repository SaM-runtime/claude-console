// Per-platform commands: PowerShell scripts on Windows, POSIX sh scripts on macOS / Linux.

export const isWindowsOs = (os: string | null | undefined) => os === 'Windows_NT'

/**
 * Opens a PowerShell command so it prints UTF-8. Left alone it prints in the console's code page (950 on a
 * Traditional Chinese Windows), which reads back as garbled text; where no console can take it, nothing changes.
 */
export const PS_UTF8 = 'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}; '

export function preflightArgs(pluginRoot: string, windows: boolean, script: string, stateDir: string, stateRoots: string[]): string[] {
  const dirs = [...new Set([stateDir, ...stateRoots].filter(Boolean))]
  if (windows) {
    // A Windows path cannot hold `|`, so the other roots travel as one argument.
    const more = dirs.filter(dir => dir !== stateDir)
    return ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${pluginRoot}/scripts/codex-preflight.ps1`,
      ...(script ? ['-CompanionScript', script] : []), '-CompanionStateDir', stateDir, ...(more.length ? ['-StateRoots', more.join('|')] : [])]
  }
  return ['sh', `${pluginRoot}/scripts/codex-preflight.sh`, ...(script ? ['--companion-script', script] : []), ...dirs.flatMap(dir => ['--state-dir', dir])]
}

export function quotaArgs(pluginRoot: string, windows: boolean): string[] {
  return windows
    ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${pluginRoot}/scripts/codex-quota.ps1`]
    : ['sh', `${pluginRoot}/scripts/codex-quota.sh`]
}

/** A file's last lines, as UTF-8 text on every platform. */
export function tailLinesArgs(path: string, windows: boolean, lines: number): string[] {
  return windows
    ? ['powershell', '-NoProfile', '-Command', `${PS_UTF8}Get-Content -LiteralPath '${path.replace(/'/g, "''")}' -Tail ${lines} -Encoding UTF8`]
    : ['tail', '-n', String(lines), path]
}

/** Fallback when the `code` editor CLI is unavailable: the OS default handler. A web address keeps its slashes. */
export function openFallbackArgs(path: string, windows: boolean): string[] {
  return windows ? ['cmd', '/c', 'start', '', /^[a-z][a-z\d+.-]*:\/\//i.test(path) ? path : path.replace(/\//g, '\\')] : ['open', path]
}
