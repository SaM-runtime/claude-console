// Command guard: a shell command that cannot be taken back (recursive delete, force push, hard
// reset, dropped tables, publish) asks the person first, even under a permission mode or an
// allow rule that would let it run unseen. Pure: no I/O, so tests exercise it directly.

export type GuardMode = 'ask' | 'deny' | 'off'

/** `commandGuard` option: `ask` (default) asks once per command, `deny` refuses, `off` lets everything through. */
export function guardMode(value: unknown): GuardMode {
  const v = String(value ?? '').trim().toLowerCase()
  return v === 'off' || v === 'deny' ? v : 'ask'
}

/** Build output and caches: deleting these is routine and never asks. */
const SCRATCH = /^(?:\.\/)?(?:[\w.-]+\/)*(?:node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.turbo|\.parcel-cache|\.cache|target|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.venv|venv|tmp|\.tmp|[\w.-]+\.egg-info)\/?$/

/** Temp directories: removing something inside one is scratch cleanup (the directory itself still asks). */
const TEMP = /^(?!.*\.\.)["']?(?:\/tmp\/|\/var\/tmp\/|\$\{?TMPDIR\}?[\\/]|\$env:(?:TEMP|TMP)[\\/]|%(?:TEMP|TMP)%[\\/])(?!\*)[^\s]+$/i

const scratch = (target: string) => SCRATCH.test(target.replace(/\\/g, '/')) || TEMP.test(target)

/** One shell command line split into simple commands; quotes are kept, separators outside them split. */
export function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) { cur += ch; if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

/**
 * Wrappers that run the rest of their words as a command. `value` lists the options that take the
 * next word as their value (`sudo -u root`, `xargs -I {}`); `operands` counts the plain words before
 * the command (`timeout 60`). Any other `-x` word is an option on its own.
 */
const WRAPPERS: Record<string, { value?: string[], operands?: number }> = {
  sudo: { value: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--close-from'] },
  doas: { value: ['-u', '-C'] },
  env: { value: ['-u', '-C', '--unset', '--chdir'] },
  nice: { value: ['-n', '--adjustment'] },
  timeout: { value: ['-s', '-k', '--signal', '--kill-after'], operands: 1 },
  stdbuf: { value: ['-i', '-o', '-e'] },
  xargs: { value: ['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'] },
  nohup: {}, time: {}, exec: { value: ['-a'] }, command: {},
}

/**
 * One simple command's words without wrapper prefixes (`sudo -u root`, `timeout 60`, `xargs -0`) or
 * `VAR=value` assignments; quotes removed. `piped` is set when `xargs` appends words read from stdin.
 */
function command(segment: string): { words: string[], piped: boolean } {
  const list = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^["']|["']$/g, '')).filter(w => w !== '{' && w !== '}')
  let piped = false
  while (list.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0]!)) { list.shift(); continue }
    const name = list[0]!.replace(/^.*[\\/]/, '')
    const wrapper = WRAPPERS[name]
    if (!wrapper) break
    if (name === 'xargs') piped = true
    list.shift()
    let operands = wrapper.operands ?? 0
    while (list.length) {
      const w = list[0]!
      if (w === '--') { list.shift(); break }
      if (/^-./.test(w)) { list.shift(); if (wrapper.value?.includes(w)) list.shift(); continue }
      if (operands > 0) { list.shift(); operands--; continue }
      break
    }
  }
  return { words: list, piped }
}

const words = (segment: string) => command(segment).words

const shortFlags = (args: string[]) => args.filter(a => /^-[A-Za-z]+$/.test(a)).join('')
const has = (args: string[], ...flags: string[]) => args.some(a => flags.includes(a))
/**
 * Recursive, for `rm` (POSIX, or PowerShell's alias for Remove-Item) and Remove-Item: a short flag
 * cluster of rm's letters with r (`-rf`, `-Rfv`), `--recursive`, or `-Recurse` and its abbreviations
 * (`-r`, `-Rec`, `-Recurse:$true`). PowerShell words such as `-Force` are not rm clusters, so their r does not count.
 */
const recursive = (args: string[]) => args.some(a => /^-[rRfvidIPWx]+$/.test(a) && /r/i.test(a) || /^--recursive$/.test(a) || /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$true)?$/i.test(a))

/** `piped`: `xargs` adds targets from stdin, so the named ones (if any) are not all it deletes. */
function rmReason(args: string[], piped = false): string | null {
  if (!recursive(args)) return null
  if (piped) return '遞迴刪除管線傳入的項目'
  const targets = args.filter(a => !a.startsWith('-'))
  if (!targets.length || targets.every(scratch)) return null
  return `遞迴刪除 ${targets.slice(0, 3).join(' ')}${targets.length > 3 ? ' …' : ''}`
}

const dryRun = (args: string[]) => has(args, '--dry-run', '-n', '--what-if', '-WhatIf')

function gitReason(args: string[]): string | null {
  // `git -C <dir> <sub>` / `git -c k=v <sub>`: skip each option and its value.
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const cmd = args[i] ?? ''
  const rest = args.slice(i + 1)
  const flags = shortFlags(rest)
  switch (cmd) {
    case 'push':
      if (dryRun(rest)) return null
      if (has(rest, '--force', '--mirror') || (/f/.test(flags) && !has(rest, '--force-with-lease', '--force-if-includes')) || rest.some(a => /^\+[^+]/.test(a))) return '強制推送會覆寫遠端歷史'
      if (has(rest, '--delete', '--prune') || /d/.test(flags) || rest.some(a => /^:[^/]/.test(a))) return '刪除遠端分支或標籤'
      return null
    case 'reset': return has(rest, '--hard') ? 'git reset --hard 會丟棄未提交的變更' : null
    case 'clean': return (/f/.test(flags) || has(rest, '--force')) && !/n/.test(flags) && !has(rest, '--dry-run') ? 'git clean 會刪除未追蹤的檔案' : null
    case 'checkout': return rest.includes('.') && (rest.includes('--') || rest.length === 1) ? '丟棄工作區所有變更'
      : has(rest, '-f', '--force') ? '強制切換分支會丟棄未提交的變更' : null
    case 'switch': return has(rest, '-f', '--force', '--discard-changes') ? '強制切換分支會丟棄未提交的變更' : null
    case 'restore': return rest.includes('.') && !has(rest, '--staged', '-S') ? '丟棄工作區所有變更' : null
    case 'branch': return /D/.test(flags) || (has(rest, '--delete') && has(rest, '--force')) ? '強制刪除分支（未合併的 commit 會遺失）' : null
    case 'stash': return rest[0] === 'drop' || rest[0] === 'clear' ? '刪除 stash 內容' : null
    case 'filter-branch': case 'filter-repo': return '改寫整個 repo 歷史'
    case 'update-ref': return has(rest, '-d') ? '直接刪除 ref' : null
    default: return null
  }
}

/** Shells that run their argument as a command line: `bash -c "…"`, `powershell -Command …`, `cmd /c …`, `eval …`, `iex …`. */
function innerCommand(lower: string, args: string[]): string | null {
  if (lower === 'eval') return args.length ? args.join(' ') : null
  if (lower === 'invoke-expression' || lower === 'iex') {
    const rest = args.filter(a => !/^-command$/i.test(a))
    return rest.length ? rest.join(' ') : null
  }
  let at = -1
  if (/^(?:ba|z|da|k)?sh$/.test(lower)) at = args.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a))
  else if (lower === 'powershell' || lower === 'pwsh') at = args.findIndex(a => /^-(?:c|command)$/i.test(a))
  else if (lower === 'cmd') at = args.findIndex(a => /^\/[ck]$/i.test(a))
  return at >= 0 && at + 1 < args.length ? args.slice(at + 1).join(' ') : null
}

function segmentReason(segment: string, depth: number): string | null {
  const { words: w, piped } = command(segment)
  const head = (w[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  const args = w.slice(1)
  const lower = head.toLowerCase()
  const inner = depth < 3 ? innerCommand(lower, args) : null
  if (inner) return reasonOf(inner, depth + 1)
  if (lower === 'rm') return rmReason(args, piped)
  if (lower === 'git') return gitReason(args)
  if (lower === 'find') {
    if (has(args, '-delete')) return 'find -delete 會刪除找到的檔案'
    const exec = args.findIndex(a => a === '-exec' || a === '-execdir')
    if (exec >= 0) {
      const run = words(args.slice(exec + 1).join(' '))
      const tool = (run[0] ?? '').replace(/^.*[\\/]/, '').toLowerCase()
      if ((tool === 'rm' || tool === 'remove-item') && recursive(run.slice(1))) return 'find -exec 遞迴刪除找到的項目'
      return reasonOf(run.filter(a => a !== '{}' && a !== '+' && a !== '\\;' && a !== ';').join(' '), depth + 1)
    }
  }
  if (lower === 'format-volume' || lower === 'clear-disk' || lower === 'initialize-disk') return '格式化磁碟'
  if (lower === 'mkfs' || lower.startsWith('mkfs.')) return '格式化磁碟'
  if (lower === 'dd' && args.some(a => /^of=\/dev\//.test(a))) return '直接寫入磁碟裝置'
  if ((lower === 'chmod' || lower === 'chown') && /R/.test(shortFlags(args)) && args.some(a => a === '/' || a === '~' || a === '/*')) return `遞迴變更根目錄權限`
  if (lower === 'remove-item' || lower === 'ri') {
    const targets = args.filter(a => !a.startsWith('-') && !/^-(?:Path|LiteralPath)$/i.test(a))
    return recursive(args) && !dryRun(args) && !(targets.length && targets.every(scratch)) ? `遞迴刪除 ${targets.slice(0, 2).join(' ')}`.trimEnd() : null
  }
  if ((lower === 'rd' || lower === 'rmdir') && args.some(a => /^\/s$/i.test(a))) {
    const targets = args.filter(a => !a.startsWith('/'))
    return targets.length && targets.every(scratch) ? null : `遞迴刪除 ${targets.slice(0, 2).join(' ')}`
  }
  if (lower === 'del' && args.some(a => /^\/s$/i.test(a))) return '遞迴刪除檔案'
  if (lower === 'format' && args.some(a => /^[a-z]:$/i.test(a))) return '格式化磁碟'
  if (lower === 'terraform' && args[0] === 'destroy') return 'terraform destroy 會刪除基礎設施'
  if (lower === 'kubectl' && args[0] === 'delete' && (args.some(a => /^(?:ns|namespaces?)$/.test(a)) || has(args, '--all', '-A', '--all-namespaces'))) return '大量刪除 Kubernetes 資源'
  if (lower === 'helm' && (args[0] === 'uninstall' || args[0] === 'delete')) return '移除 Helm release'
  if (lower === 'docker' && args[0] === 'system' && args[1] === 'prune' && has(args, '-a', '--all', '--volumes')) return '清除所有 Docker 映像與資料卷'
  if (lower === 'gh' && ((args[0] === 'repo' && args[1] === 'delete') || (args[0] === 'release' && args[1] === 'delete'))) return `刪除 GitHub ${args[0] === 'repo' ? 'repo' : 'release'}`
  if ((lower === 'npm' || lower === 'pnpm' || lower === 'yarn' || lower === 'cargo') && (args[0] === 'publish' || args[0] === 'unpublish') && !dryRun(args)) return `${args[0] === 'publish' ? '發布套件' : '撤下已發布的套件'}（正式環境操作）`
  if (lower === 'gh' && args[0] === 'release' && args[1] === 'create') return '建立 GitHub release（正式環境操作）'
  return null
}

const SQL = /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i
/** Commands that only search, show or record text: SQL words in their arguments run nothing (`git commit -m "drop table …"`). */
const TEXT_ONLY = /^(?:git|grep|egrep|rg|ag|findstr|select-string|sls|echo|printf|write-output|write-host|cat|type|get-content|gc|less|more|head|tail|wc|ls|dir)$/

function reasonOf(command: string, depth: number): string | null {
  const parts = segments(command)
  const heads = parts.map(part => (words(part)[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase())
  if (SQL.test(command) && !heads.every(head => TEXT_ONLY.test(head))) return '刪除資料表或資料庫'
  for (const segment of parts) {
    const reason = segmentReason(segment, depth)
    if (reason) return reason
  }
  return null
}

/** Why `command` needs the person's word, or null when it is ordinary. */
export function dangerReason(command: string): string | null {
  return reasonOf(command, 0)
}

/** The command as the person will read it in the question: one line, clipped. */
export function commandPreview(command: string, max = 160): string {
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
