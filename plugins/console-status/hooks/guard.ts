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

/** Words of one simple command without leading `sudo`, `env`, `command` or `VAR=value` prefixes; quotes removed. */
function words(segment: string): string[] {
  const list = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^["']|["']$/g, ''))
  while (list.length && (/^(?:sudo|env|command|nohup|time|exec|xargs)$/.test(list[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0]!))) list.shift()
  return list
}

const shortFlags = (args: string[]) => args.filter(a => /^-[A-Za-z]+$/.test(a)).join('')
const has = (args: string[], ...flags: string[]) => args.some(a => flags.includes(a))

function rmReason(args: string[]): string | null {
  const flags = shortFlags(args)
  if (!/[rR]/.test(flags) && !has(args, '--recursive')) return null
  const targets = args.filter(a => !a.startsWith('-'))
  if (!targets.length || targets.every(t => SCRATCH.test(t))) return null
  return `遞迴刪除 ${targets.slice(0, 3).join(' ')}${targets.length > 3 ? ' …' : ''}`
}

function gitReason(args: string[]): string | null {
  // `git -C <dir> <sub>` / `git -c k=v <sub>`: skip each option and its value.
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const cmd = args[i] ?? ''
  const rest = args.slice(i + 1)
  const flags = shortFlags(rest)
  switch (cmd) {
    case 'push':
      if (has(rest, '--force', '--mirror') || (/f/.test(flags) && !has(rest, '--force-with-lease', '--force-if-includes'))) return '強制推送會覆寫遠端歷史'
      if (has(rest, '--delete') || /d/.test(flags) || rest.some(a => /^:[^/]/.test(a))) return '刪除遠端分支或標籤'
      return null
    case 'reset': return has(rest, '--hard') ? 'git reset --hard 會丟棄未提交的變更' : null
    case 'clean': return /f/.test(flags) || has(rest, '--force') ? 'git clean 會刪除未追蹤的檔案' : null
    case 'checkout': return rest.includes('.') && (rest.includes('--') || rest.length === 1) ? '丟棄工作區所有變更' : null
    case 'restore': return rest.includes('.') && !has(rest, '--staged', '-S') ? '丟棄工作區所有變更' : null
    case 'branch': return /D/.test(flags) || (has(rest, '--delete') && has(rest, '--force')) ? '強制刪除分支（未合併的 commit 會遺失）' : null
    case 'stash': return rest[0] === 'drop' || rest[0] === 'clear' ? '刪除 stash 內容' : null
    case 'filter-branch': case 'filter-repo': return '改寫整個 repo 歷史'
    case 'update-ref': return has(rest, '-d') ? '直接刪除 ref' : null
    default: return null
  }
}

function segmentReason(segment: string): string | null {
  const w = words(segment)
  const head = (w[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  const args = w.slice(1)
  const lower = head.toLowerCase()
  if (lower === 'rm') return rmReason(args)
  if (lower === 'git') return gitReason(args)
  if (lower === 'mkfs' || lower.startsWith('mkfs.')) return '格式化磁碟'
  if (lower === 'dd' && args.some(a => /^of=\/dev\//.test(a))) return '直接寫入磁碟裝置'
  if ((lower === 'chmod' || lower === 'chown') && /R/.test(shortFlags(args)) && args.some(a => a === '/' || a === '~' || a === '/*')) return `遞迴變更根目錄權限`
  if (lower === 'remove-item' || lower === 'ri') {
    const targets = args.filter(a => !a.startsWith('-'))
    return args.some(a => /^-r(?:ecurse)?$/i.test(a)) && !(targets.length && targets.every(t => SCRATCH.test(t.replace(/\\/g, '/')))) ? `遞迴刪除 ${targets.slice(0, 2).join(' ')}` : null
  }
  if ((lower === 'rd' || lower === 'rmdir') && args.some(a => /^\/s$/i.test(a))) return `遞迴刪除 ${args.filter(a => !a.startsWith('/')).slice(0, 2).join(' ')}`
  if (lower === 'del' && args.some(a => /^\/s$/i.test(a))) return '遞迴刪除檔案'
  if (lower === 'format' && args.some(a => /^[a-z]:$/i.test(a))) return '格式化磁碟'
  if (lower === 'terraform' && args[0] === 'destroy') return 'terraform destroy 會刪除基礎設施'
  if (lower === 'kubectl' && args[0] === 'delete' && (args.some(a => /^(?:ns|namespaces?)$/.test(a)) || has(args, '--all', '-A', '--all-namespaces'))) return '大量刪除 Kubernetes 資源'
  if (lower === 'helm' && (args[0] === 'uninstall' || args[0] === 'delete')) return '移除 Helm release'
  if (lower === 'docker' && args[0] === 'system' && args[1] === 'prune' && has(args, '-a', '--all', '--volumes')) return '清除所有 Docker 映像與資料卷'
  if (lower === 'gh' && ((args[0] === 'repo' && args[1] === 'delete') || (args[0] === 'release' && args[1] === 'delete'))) return `刪除 GitHub ${args[0] === 'repo' ? 'repo' : 'release'}`
  if ((lower === 'npm' || lower === 'pnpm' || lower === 'yarn' || lower === 'cargo') && (args[0] === 'publish' || args[0] === 'unpublish')) return `${args[0] === 'publish' ? '發布套件' : '撤下已發布的套件'}（正式環境操作）`
  if (lower === 'gh' && args[0] === 'release' && args[1] === 'create') return '建立 GitHub release（正式環境操作）'
  return null
}

const SQL = /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i

/** Why `command` needs the person's word, or null when it is ordinary. */
export function dangerReason(command: string): string | null {
  if (SQL.test(command)) return '刪除資料表或資料庫'
  for (const segment of segments(command)) {
    const reason = segmentReason(segment)
    if (reason) return reason
  }
  return null
}

/** The command as the person will read it in the question: one line, clipped. */
export function commandPreview(command: string, max = 160): string {
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
