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

/** Why a command needs the person's word (`reason`, short) and what it does, in plain words (`explain`). */
export type Danger = { reason: string, explain: string }
const danger = (reason: string, explain: string): Danger => ({ reason, explain })

const EXPLAIN = {
  rm: 'rm -r 會把資料夾連同裡面所有檔案一起刪掉，不經過資源回收筒，刪了就救不回來。',
  removeItem: 'Remove-Item -Recurse 會把資料夾和底下所有東西一起刪掉，不經過資源回收筒，無法復原。',
  rd: 'rd /s 會刪掉整個資料夾和底下所有內容（加 /q 時連確認都不問），不經過資源回收筒。',
  del: 'del /s 會在這個資料夾和所有子資料夾裡刪除符合的檔案，不經過資源回收筒。',
  piped: '前一個指令列出的每個項目都會被遞迴刪除；實際刪到哪些，要看前面的輸出，執行前看不到。',
  find: 'find 會把所有符合條件的檔案直接刪掉；條件寫錯一點就會刪到不該刪的檔案。',
  forcePush: '用本機的版本直接蓋掉遠端分支；遠端上本機沒有的 commit（別人或其他對話推的）會消失。比較安全的寫法是 --force-with-lease。',
  deleteRemote: '把遠端（例如 GitHub）上的分支或標籤刪掉；--prune 會刪掉遠端有、本機已經沒有的分支。',
  resetHard: '把目前分支和所有檔案退回指定的 commit；還沒 commit 的修改會直接被蓋掉，git 也找不回來。',
  clean: '刪除 git 沒有追蹤的檔案（新建但還沒 add 的檔案）；加 -x 時連 .gitignore 裡的檔案（例如 .env）也會刪。這些檔案不在 git 裡，刪了救不回來。',
  discardAll: '把工作區每個檔案還原成上次 commit 的樣子；所有還沒 commit 的修改都會消失。',
  forceSwitch: '切換分支時直接丟掉還沒 commit 的修改，不會先確認。',
  branchD: '不管這個分支有沒有合併都直接刪掉；只存在這個分支上的 commit 之後很難找回。',
  stash: 'stash 是先收起來的修改；drop 刪掉一筆、clear 全部刪掉，刪了之後很難找回。',
  filter: '逐一改寫 repo 裡的每個 commit（例如移除某個檔案）；commit 編號全部改變，和遠端及別人的副本對不上。',
  updateRef: '直接刪掉一個分支或標籤，不做任何檢查。',
  format: '把整顆磁碟或分割區清空重建，上面的資料全部消失。',
  dd: '把資料直接寫進磁碟裝置，蓋掉原本的內容（包括分割表），磁碟上的資料會毀損。',
  chmod: '從根目錄或家目錄開始，一路改所有檔案的權限或擁有者；系統檔案權限亂掉後，可能無法開機或登入。',
  terraform: '刪除這份 Terraform 設定管理的所有雲端資源（伺服器、資料庫等），裡面的資料一起消失。',
  kubectl: '一次刪掉整個 namespace 或所有符合的 Kubernetes 資源，上面跑的服務會停掉。',
  helm: '把用 Helm 部署的整套服務從叢集移除。',
  docker: '刪掉所有沒在用的 Docker 映像與容器；加 --volumes 時連資料卷（資料庫的資料常放在這裡）也會刪。',
  ghRepo: '永久刪除 GitHub 上的整個 repo，包括 issue、PR 和設定。',
  ghRelease: '刪掉 GitHub 上的一個 release 和它附帶的下載檔。',
  publish: '把套件公開發布到套件庫（npm、crates.io 等），所有人都能下載；同一個版本號發出去後通常不能改，也不能再用。',
  unpublish: '從套件庫撤下已發布的版本，正在用它的人會裝不到。',
  releaseCreate: '在 GitHub 公開建立一個 release（含版本標籤），追蹤這個 repo 的人會收到通知。',
  sql: 'DROP 會把整張資料表或整個資料庫刪掉；TRUNCATE 會清空資料表裡的所有資料。沒有備份就救不回來。',
} as const

/** `piped`: `xargs` adds targets from stdin, so the named ones (if any) are not all it deletes. */
function rmReason(args: string[], piped = false): Danger | null {
  if (!recursive(args)) return null
  if (piped) return danger('遞迴刪除管線傳入的項目', EXPLAIN.piped)
  const targets = args.filter(a => !a.startsWith('-'))
  if (!targets.length || targets.every(scratch)) return null
  return danger(`遞迴刪除 ${targets.slice(0, 3).join(' ')}${targets.length > 3 ? ' …' : ''}`, EXPLAIN.rm)
}

const dryRun = (args: string[]) => has(args, '--dry-run', '-n', '--what-if', '-WhatIf')

function gitReason(args: string[]): Danger | null {
  // `git -C <dir> <sub>` / `git -c k=v <sub>`: skip each option and its value.
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  const cmd = args[i] ?? ''
  const rest = args.slice(i + 1)
  const flags = shortFlags(rest)
  switch (cmd) {
    case 'push':
      if (dryRun(rest)) return null
      if (has(rest, '--force', '--mirror') || (/f/.test(flags) && !has(rest, '--force-with-lease', '--force-if-includes')) || rest.some(a => /^\+[^+]/.test(a))) return danger('強制推送會覆寫遠端歷史', EXPLAIN.forcePush)
      if (has(rest, '--delete', '--prune') || /d/.test(flags) || rest.some(a => /^:[^/]/.test(a))) return danger('刪除遠端分支或標籤', EXPLAIN.deleteRemote)
      return null
    case 'reset': return has(rest, '--hard') ? danger('git reset --hard 會丟棄未提交的變更', EXPLAIN.resetHard) : null
    case 'clean': return (/f/.test(flags) || has(rest, '--force')) && !/n/.test(flags) && !has(rest, '--dry-run') ? danger('git clean 會刪除未追蹤的檔案', EXPLAIN.clean) : null
    case 'checkout': return rest.includes('.') && (rest.includes('--') || rest.length === 1) ? danger('丟棄工作區所有變更', EXPLAIN.discardAll)
      : has(rest, '-f', '--force') ? danger('強制切換分支會丟棄未提交的變更', EXPLAIN.forceSwitch) : null
    case 'switch': return has(rest, '-f', '--force', '--discard-changes') ? danger('強制切換分支會丟棄未提交的變更', EXPLAIN.forceSwitch) : null
    case 'restore': return rest.includes('.') && !has(rest, '--staged', '-S') ? danger('丟棄工作區所有變更', EXPLAIN.discardAll) : null
    case 'branch': return /D/.test(flags) || (has(rest, '--delete') && has(rest, '--force')) ? danger('強制刪除分支（未合併的 commit 會遺失）', EXPLAIN.branchD) : null
    case 'stash': return rest[0] === 'drop' || rest[0] === 'clear' ? danger('刪除 stash 內容', EXPLAIN.stash) : null
    case 'filter-branch': case 'filter-repo': return danger('改寫整個 repo 歷史', EXPLAIN.filter)
    case 'update-ref': return has(rest, '-d') ? danger('直接刪除 ref', EXPLAIN.updateRef) : null
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

function segmentReason(segment: string, depth: number): Danger | null {
  const { words: w, piped } = command(segment)
  const head = (w[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  const args = w.slice(1)
  const lower = head.toLowerCase()
  const inner = depth < 3 ? innerCommand(lower, args) : null
  if (inner) return reasonOf(inner, depth + 1)
  if (lower === 'rm') return rmReason(args, piped)
  if (lower === 'git') return gitReason(args)
  if (lower === 'find') {
    if (has(args, '-delete')) return danger('find -delete 會刪除找到的檔案', EXPLAIN.find)
    const exec = args.findIndex(a => a === '-exec' || a === '-execdir')
    if (exec >= 0) {
      const run = words(args.slice(exec + 1).join(' '))
      const tool = (run[0] ?? '').replace(/^.*[\\/]/, '').toLowerCase()
      if ((tool === 'rm' || tool === 'remove-item') && recursive(run.slice(1))) return danger('find -exec 遞迴刪除找到的項目', EXPLAIN.find)
      return reasonOf(run.filter(a => a !== '{}' && a !== '+' && a !== '\;' && a !== ';').join(' '), depth + 1)
    }
  }
  if (lower === 'format-volume' || lower === 'clear-disk' || lower === 'initialize-disk') return danger('格式化磁碟', EXPLAIN.format)
  if (lower === 'mkfs' || lower.startsWith('mkfs.')) return danger('格式化磁碟', EXPLAIN.format)
  if (lower === 'dd' && args.some(a => /^of=\/dev\//.test(a))) return danger('直接寫入磁碟裝置', EXPLAIN.dd)
  if ((lower === 'chmod' || lower === 'chown') && /R/.test(shortFlags(args)) && args.some(a => a === '/' || a === '~' || a === '/*')) return danger('遞迴變更根目錄權限', EXPLAIN.chmod)
  if (lower === 'remove-item' || lower === 'ri') {
    const targets = args.filter(a => !a.startsWith('-') && !/^-(?:Path|LiteralPath)$/i.test(a))
    return recursive(args) && !dryRun(args) && !(targets.length && targets.every(scratch)) ? danger(`遞迴刪除 ${targets.slice(0, 2).join(' ')}`.trimEnd(), EXPLAIN.removeItem) : null
  }
  if ((lower === 'rd' || lower === 'rmdir') && args.some(a => /^\/s$/i.test(a))) {
    const targets = args.filter(a => !a.startsWith('/'))
    return targets.length && targets.every(scratch) ? null : danger(`遞迴刪除 ${targets.slice(0, 2).join(' ')}`, EXPLAIN.rd)
  }
  if (lower === 'del' && args.some(a => /^\/s$/i.test(a))) return danger('遞迴刪除檔案', EXPLAIN.del)
  if (lower === 'format' && args.some(a => /^[a-z]:$/i.test(a))) return danger('格式化磁碟', EXPLAIN.format)
  if (lower === 'terraform' && args[0] === 'destroy') return danger('terraform destroy 會刪除基礎設施', EXPLAIN.terraform)
  if (lower === 'kubectl' && args[0] === 'delete' && (args.some(a => /^(?:ns|namespaces?)$/.test(a)) || has(args, '--all', '-A', '--all-namespaces'))) return danger('大量刪除 Kubernetes 資源', EXPLAIN.kubectl)
  if (lower === 'helm' && (args[0] === 'uninstall' || args[0] === 'delete')) return danger('移除 Helm release', EXPLAIN.helm)
  if (lower === 'docker' && args[0] === 'system' && args[1] === 'prune' && has(args, '-a', '--all', '--volumes')) return danger('清除所有 Docker 映像與資料卷', EXPLAIN.docker)
  if (lower === 'gh' && args[0] === 'repo' && args[1] === 'delete') return danger('刪除 GitHub repo', EXPLAIN.ghRepo)
  if (lower === 'gh' && args[0] === 'release' && args[1] === 'delete') return danger('刪除 GitHub release', EXPLAIN.ghRelease)
  if ((lower === 'npm' || lower === 'pnpm' || lower === 'yarn' || lower === 'cargo') && (args[0] === 'publish' || args[0] === 'unpublish') && !dryRun(args)) {
    return args[0] === 'publish' ? danger('發布套件（正式環境操作）', EXPLAIN.publish) : danger('撤下已發布的套件（正式環境操作）', EXPLAIN.unpublish)
  }
  if (lower === 'gh' && args[0] === 'release' && args[1] === 'create') return danger('建立 GitHub release（正式環境操作）', EXPLAIN.releaseCreate)
  return null
}

const SQL = /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i
/** Commands that only search, show or record text: SQL words in their arguments run nothing (`git commit -m "drop table …"`). */
const TEXT_ONLY = /^(?:git|grep|egrep|rg|ag|findstr|select-string|sls|echo|printf|write-output|write-host|cat|type|get-content|gc|less|more|head|tail|wc|ls|dir)$/

function reasonOf(command: string, depth: number): Danger | null {
  const parts = segments(command)
  const heads = parts.map(part => (words(part)[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase())
  if (SQL.test(command) && !heads.every(head => TEXT_ONLY.test(head))) return danger('刪除資料表或資料庫', EXPLAIN.sql)
  for (const segment of parts) {
    const found = segmentReason(segment, depth)
    if (found) return found
  }
  return null
}

/** Why `command` needs the person's word and what it does, or null when it is ordinary. */
export function dangerOf(command: string): Danger | null {
  return reasonOf(command, 0)
}

/** Why `command` needs the person's word, or null when it is ordinary. */
export function dangerReason(command: string): string | null {
  return dangerOf(command)?.reason ?? null
}

/** The command as the person will read it in the question: one line, clipped. */
export function commandPreview(command: string, max = 160): string {
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
