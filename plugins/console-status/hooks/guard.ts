// Command guard: a shell command that cannot be taken back (recursive delete, force push, hard
// reset, dropped tables, wiped databases, cloud deletes, publish, code run straight from a
// download) asks the person first, even under a permission mode or an
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

/** Keys, cloud credentials and system settings: deleting even one file here asks (`~/.ssh/id_ed25519`, `/etc/hosts`). */
const SECRET = /^(?:~|\$\{?HOME\}?|\$env:USERPROFILE|%USERPROFILE%|\/home\/[^/]+|\/root|\/Users\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)[\\/]\.(?:ssh|aws|gnupg|kube|azure|config[\\/]gcloud)(?:[\\/]|$)|^\/etc(?:\/|$)/i

/** The Windows registry, as PowerShell and reg.exe name it (`HKCU:\Software\x`, `HKLM\…`, `Registry::HKEY_…`). */
const REGISTRY = /^(?:HKLM|HKCU|HKCR|HKU|HKCC|HKEY_[A-Z_]+)(?::|\\|$)|^Registry::/i

/** A drive root, the Windows, Users, Program Files or ProgramData folders (or one level in), or a home folder. */
const SYSTEM_ROOT = /^(?:[A-Za-z]:[\\/]?|[A-Za-z]:[\\/](?:Windows|Users|Program ?Files[^\\/]*|ProgramData)(?:[\\/][^\\/]+)?[\\/]?|~|\$\{?HOME\}?|\$env:USERPROFILE|%USERPROFILE%|\/)[\\/]?\*?$/i

/** Commands that delete files (POSIX, cmd and PowerShell's aliases for Remove-Item). */
const DELETERS = /^(?:rm|remove-item|ri|del|erase|rd|rmdir|unlink)$/

/**
 * One shell command line split into simple commands; quotes are kept, separators outside them split.
 * `piped` is set on a command the one before it pipes into (`a | b`; `a || b` is not a pipe).
 */
function pieces(command: string): { text: string, piped: boolean }[] {
  const out: { text: string, piped: boolean }[] = []
  let cur = ''
  let quote: string | null = null
  let piped = false
  const cut = (next: boolean) => { out.push({ text: cur.trim(), piped }); cur = ''; piped = next }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) { cur += ch; if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '|') { if (command[i + 1] === '|') { cut(false); i++ } else cut(true); continue }
    if (ch === '\n' || ch === ';' || ch === '&' || ch === '(' || ch === ')' || ch === '`') { cut(false); continue }
    cur += ch
  }
  cut(false)
  return out.filter(piece => piece.text)
}

/** One shell command line split into simple commands; quotes are kept, separators outside them split. */
export function segments(command: string): string[] {
  return pieces(command).map(piece => piece.text)
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
  terraform: '刪除這份 Terraform（或 OpenTofu）設定管理的所有雲端資源（伺服器、資料庫等），裡面的資料一起消失。',
  kubectl: '一次刪掉整個 namespace 或所有符合的 Kubernetes 資源，上面跑的服務會停掉。',
  helm: '把用 Helm 部署的整套服務從叢集移除。',
  docker: '刪掉所有沒在用的 Docker 映像與容器；加 --volumes 時連資料卷（資料庫的資料常放在這裡）也會刪。',
  ghRepo: '永久刪除 GitHub 上的整個 repo，包括 issue、PR 和設定。',
  ghRelease: '刪掉 GitHub 上的一個 release 和它附帶的下載檔。',
  publish: '把套件公開發布到套件庫（npm、PyPI、crates.io、RubyGems、NuGet、VS Code 擴充功能市集等），所有人都能下載；同一個版本號發出去後通常不能改，也不能再用。',
  unpublish: '從套件庫撤下已發布的版本，正在用它的人會裝不到。',
  releaseCreate: '在 GitHub 公開建立一個 release（含版本標籤），追蹤這個 repo 的人會收到通知。',
  sql: 'DROP 會把整張資料表或整個資料庫刪掉；TRUNCATE 會清空資料表裡的所有資料。沒有備份就救不回來。',
  deleteAll: 'DELETE FROM 沒有加 WHERE 條件，會刪掉整張資料表的每一筆資料；沒有備份就救不回來。',
  psAlias: '在 PowerShell 裡 del、erase、rd、rmdir 都是 Remove-Item；加上 -Recurse 會把資料夾和底下所有東西一起刪掉，不經過資源回收筒，無法復原。',
  reflog: '平常 reset、rebase 或刪掉分支之後，原本的 commit 還會在 git 的紀錄（reflog）裡留一段時間，找得回來；這個指令立刻清掉這些紀錄或沒有分支指著的 commit，之後就救不回來了。',
  worktree: '強制移除另一個 worktree 資料夾；那裡還沒 commit 的修改和沒加進 git 的檔案會一起刪掉。',
  registry: '刪除 Windows 登錄檔的機碼或設定值；登錄檔沒有資源回收筒，刪錯可能讓程式或 Windows 本身無法正常運作。',
  shadows: '刪除 Windows 的系統還原點（陰影複製）；之後就不能用它把檔案或系統還原到之前的狀態。',
  cipher: '把磁碟上的空白空間整個覆寫一遍；已經刪掉的檔案從此無法用救援工具找回。',
  diskpart: '磁碟分割工具：可以刪除或清空整個分割區、整顆磁碟，做錯資料就沒了。',
  bcdedit: '修改 Windows 的開機設定；設錯可能讓電腦開不了機。',
  robocopy: '/MIR、/PURGE 會讓目的地和來源一模一樣：目的地有、來源沒有的檔案會被刪掉；來源或目的地寫錯（例如寫反），整個資料夾就被清空。',
  acl: '從磁碟根目錄、Windows 或使用者資料夾開始，一路改所有檔案的權限或擁有者；系統檔案權限亂掉後，Windows 可能無法正常運作或登入。',
  fetchRun: '從網路下載一段程式直接執行，執行前看不到內容；網址被換掉或下載到一半中斷，都會執行到不是你預期的東西。',
  dbDrop: '清空或刪除整個資料庫（Redis 的 FLUSHALL／FLUSHDB、MongoDB 的 dropDatabase／drop、dropdb 等），裡面的資料全部消失。',
  devDb: '把資料庫整個清空或刪掉重建，現有的資料（包括測試帳號、手動建的資料）全部消失；連線設定如果指向正式資料庫，正式資料也會一起清空。',
  dockerVolume: '刪除 Docker 資料卷；本機資料庫等服務的資料通常存在資料卷裡，刪了就沒有了。',
  cloud: '刪除雲端上的資源（伺服器、資料庫、儲存空間裡的檔案等），裡面的資料一起消失，通常無法復原。',
  ghPublic: '把 repo 改成公開，所有人都看得到程式碼和整個 commit 歷史（包括曾經 commit 過的金鑰或密碼）；改回私人之前，可能已經被複製走。',
  ghArchive: '把 repo 封存成唯讀：之後不能推送、開 issue 或 PR，直到有人在 GitHub 設定裡解除封存。',
  ghSecret: '刪除 GitHub 上存的密鑰（例如部署用的 token）；用到它的 CI 或部署會開始失敗，而且密鑰的值無法再查看，要重新產生。',
  ghApi: '直接呼叫 GitHub API 刪除東西（repo、分支、release、留言等），不經過 gh 平常的確認；刪掉的通常找不回來。',
  secrets: '刪除 SSH 金鑰、雲端帳號憑證、GPG 金鑰或系統設定檔；金鑰刪了就要重新產生、到各個服務重新設定，系統設定刪錯可能讓電腦無法正常運作。',
  crontab: 'crontab -r 會刪掉這個帳號所有的排程工作，不會先確認，也沒有備份。',
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
    case 'clean': {
      if (!(/f/.test(flags) || has(rest, '--force')) || /n/.test(flags) || has(rest, '--dry-run')) return null
      // Cleaning only build output (`git clean -fdx build`) is routine, as `rm -rf build` is.
      const paths = rest.filter((a, n) => !a.startsWith('-') && rest[n - 1] !== '-e' && rest[n - 1] !== '--exclude')
      return paths.length && paths.every(scratch) ? null : danger('git clean 會刪除未追蹤的檔案', EXPLAIN.clean)
    }
    case 'reflog': return rest[0] === 'expire' && rest.some(a => /^--expire(?:-unreachable)?=(?:now|all)$/i.test(a)) ? danger('清除 git 的復原紀錄（reflog）', EXPLAIN.reflog) : null
    case 'gc': return rest.some(a => /^--prune=(?:now|all)$/i.test(a)) ? danger('立刻清除沒有分支指著的 commit', EXPLAIN.reflog) : null
    case 'prune': return dryRun(rest) || rest.some(a => /^--expire/.test(a) && !/=(?:now|all)$/i.test(a)) ? null : danger('立刻清除沒有分支指著的 commit', EXPLAIN.reflog)
    case 'worktree': return rest[0] === 'remove' && (has(rest, '--force') || /f/.test(shortFlags(rest.slice(1)))) ? danger('強制移除 worktree（沒 commit 的修改會遺失）', EXPLAIN.worktree) : null
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

/** A command's name as typed: no folder, no `.exe`, lower case. */
const nameOf = (w: string[]) => (w[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()

/**
 * The words of the tool a launcher runs: `npx prisma …`, `pnpm exec prisma …`, `bundle exec rails …`,
 * `uv run python manage.py …`; the words themselves for anything else.
 */
function launched(w: string[]): string[] {
  const name = nameOf(w)
  let rest = w
  if (/^(?:npx|pnpx|bunx)$/.test(name)) rest = w.slice(1)
  else if (/^(?:pnpm|yarn|bun)$/.test(name) && /^(?:exec|dlx|x)$/.test(w[1] ?? '')) rest = w.slice(2)
  else if (/^(?:pnpm|yarn)$/.test(name) && /^(?:prisma|vsce|ovsx)$/.test(w[1] ?? '')) rest = w.slice(1)
  else if ((name === 'bundle' && w[1] === 'exec') || (/^(?:uv|poetry|pipenv|pdm|hatch)$/.test(name) && w[1] === 'run')) rest = w.slice(2)
  else return w
  while (rest.length && rest[0]!.startsWith('-')) rest = rest.slice(1)
  return rest
}

const DOWNLOADERS = /^(?:curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest)$/
/** A command that fetches from the network (`curl …`, `iwr …`, also after PowerShell's `.` or `&`). */
const downloads = (segment: string) => DOWNLOADERS.test(nameOf(words(segment).filter(w => w !== '.' && w !== '&')))
/** A command that runs what comes in on stdin as a program: `sh`, `bash -s`, `iex`, `python -`, a bare `node`. */
function runsInput(segment: string): boolean {
  const w = words(segment)
  const name = nameOf(w), args = w.slice(1)
  if (/^(?:ba|z|da|k|fi)?sh$/.test(name)) return !args.some(a => /^-[a-z]*c[a-z]*$/.test(a))
  if (name === 'iex' || name === 'invoke-expression') return true
  if (/^(?:python[\d.]*|py|node|perl|ruby|php)$/.test(name)) return !args.length || args[0] === '-'
  if (name === 'powershell' || name === 'pwsh') return args.includes('-')
  return false
}
/** A listing that walks into every subfolder: `Get-ChildItem -Recurse`, `ls -R`, `find`. */
function listsAll(segment: string): boolean {
  const w = words(segment)
  const name = nameOf(w)
  return name === 'find' || (/^(?:ls|dir|gci|get-childitem)$/.test(name) && recursive(w.slice(1)))
}

/**
 * `upstream`: the commands piping into this one, nearest last (`curl … | sh`, `Get-ChildItem -Recurse | Remove-Item`).
 */
function segmentReason(segment: string, depth: number, upstream: string[] = []): Danger | null {
  const { words: w, piped } = command(segment)
  const head = (w[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  const args = w.slice(1)
  const lower = head.toLowerCase()
  const inner = depth < 3 ? innerCommand(lower, args) : null
  if (inner) return reasonOf(inner, depth + 1)
  // Code straight from a download: nobody sees what runs.
  if (upstream.some(downloads) && runsInput(segment)) return danger('下載後直接執行（執行前看不到內容）', EXPLAIN.fetchRun)
  if (DELETERS.test(lower) || lower === 'remove-itemproperty' || lower === 'rp') {
    if (args.some(a => REGISTRY.test(a))) return danger('刪除登錄檔設定', EXPLAIN.registry)
    const secret = args.find(a => SECRET.test(a))
    if (secret && lower !== 'remove-itemproperty' && lower !== 'rp' && !dryRun(args)) return danger(`刪除 ${secret}`, EXPLAIN.secrets)
    // PowerShell deletes what is piped in: `Get-ChildItem -Recurse | Remove-Item`, `ls | rm -r`.
    if (upstream.length && DELETERS.test(lower) && !args.some(a => !a.startsWith('-')) && !dryRun(args) && (recursive(args) || upstream.some(listsAll))) {
      return danger('遞迴刪除管線傳入的項目', EXPLAIN.piped)
    }
  }
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
  if (lower === 'remove-partition') return danger('刪除磁碟分割', EXPLAIN.diskpart)
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
  if ((lower === 'del' || lower === 'erase') && args.some(a => /^\/s$/i.test(a))) return danger('遞迴刪除檔案', EXPLAIN.del)
  // PowerShell, where del, erase, rd and rmdir are Remove-Item: `rd C:\x -Recurse`.
  if (/^(?:del|erase|rd|rmdir)$/.test(lower) && recursive(args) && !dryRun(args)) {
    const targets = args.filter(a => !a.startsWith('-'))
    return targets.length && targets.every(scratch) ? null : danger(`遞迴刪除 ${targets.slice(0, 2).join(' ')}`.trimEnd(), EXPLAIN.psAlias)
  }
  if (lower === 'format' && args.some(a => /^[a-z]:$/i.test(a))) return danger('格式化磁碟', EXPLAIN.format)
  if (lower === 'crontab' && /r/.test(shortFlags(args))) return danger('刪除所有排程工作', EXPLAIN.crontab)
  // Windows: the registry, restore points, partitions, boot settings, mirrors and permissions.
  if (lower === 'reg' && /^delete$/i.test(args[0] ?? '')) return danger('刪除登錄檔設定', EXPLAIN.registry)
  if ((lower === 'vssadmin' && /^delete$/i.test(args[0] ?? '')) || (lower === 'wmic' && args.some(a => /^shadowcopy$/i.test(a)) && args.some(a => /^delete$/i.test(a)))) return danger('刪除系統還原點', EXPLAIN.shadows)
  if (lower === 'cipher' && args.some(a => /^\/w(?::|$)/i.test(a))) return danger('覆寫磁碟的空白空間', EXPLAIN.cipher)
  if (lower === 'diskpart') return danger('磁碟分割工具', EXPLAIN.diskpart)
  if (lower === 'bcdedit' && args.some(a => /^\/(?!enum$|v$|export$|\?$)/i.test(a))) return danger('修改開機設定', EXPLAIN.bcdedit)
  if (lower === 'robocopy' && args.some(a => /^\/(?:mir|purge)$/i.test(a))) {
    const dest = args.filter(a => !a.startsWith('/'))[1]
    return dest && scratch(dest) ? null : danger(`鏡像複製會刪除 ${dest ?? '目的地'} 裡多出來的檔案`, EXPLAIN.robocopy)
  }
  if (lower === 'icacls' && args.some(a => /^\/t$/i.test(a)) && SYSTEM_ROOT.test(args[0] ?? '')) return danger('遞迴變更整個磁碟或系統資料夾的權限', EXPLAIN.acl)
  if (lower === 'takeown' && args.some(a => /^\/r$/i.test(a))) {
    const f = args.findIndex(a => /^\/f$/i.test(a))
    if (f >= 0 && SYSTEM_ROOT.test(args[f + 1] ?? '')) return danger('遞迴取得整個磁碟或系統資料夾的擁有權', EXPLAIN.acl)
  }
  if ((lower === 'terraform' || lower === 'tofu') && (args[0] === 'destroy' || (args[0] === 'apply' && has(args, '-destroy', '--destroy')))) return danger(`${lower} destroy 會刪除基礎設施`, EXPLAIN.terraform)
  if (lower === 'pulumi' && (args[0] === 'destroy' || args[0] === 'down')) return danger('pulumi destroy 會刪除基礎設施', EXPLAIN.cloud)
  if (lower === 'aws' && args[0] === 's3' && !has(args, '--dryrun') && ((args[1] === 'rm' && has(args, '--recursive')) || (args[1] === 'rb' && has(args, '--force')))) return danger('刪除 S3 上的檔案或整個儲存桶', EXPLAIN.cloud)
  if (lower === 'gsutil' && ((args.includes('rm') && /r/i.test(shortFlags(args))) || args.includes('rb'))) return danger('刪除 Cloud Storage 上的檔案或儲存桶', EXPLAIN.cloud)
  if ((lower === 'gcloud' || lower === 'az') && args.includes('delete')) return danger(`${lower} 刪除雲端資源`, EXPLAIN.cloud)
  if (lower === 'kubectl' && args[0] === 'delete' && (args.some(a => /^(?:ns|namespaces?)$/.test(a)) || has(args, '--all', '-A', '--all-namespaces'))) return danger('大量刪除 Kubernetes 資源', EXPLAIN.kubectl)
  if (lower === 'helm' && (args[0] === 'uninstall' || args[0] === 'delete')) return danger('移除 Helm release', EXPLAIN.helm)
  if (lower === 'docker' || lower === 'podman' || lower === 'docker-compose') {
    const sub = lower === 'docker-compose' ? ['compose', ...args] : args
    if (sub[0] === 'system' && sub[1] === 'prune' && (has(sub, '-a', '--all', '--volumes') || /a/.test(shortFlags(sub.slice(2))))) return danger('清除所有 Docker 映像與資料卷', EXPLAIN.docker)
    if (sub[0] === 'volume' && /^(?:rm|remove|prune)$/.test(sub[1] ?? '')) return danger('刪除 Docker 資料卷', EXPLAIN.dockerVolume)
    const down = sub[0] === 'compose' ? sub.indexOf('down') : -1
    if (down > 0 && (has(sub.slice(down + 1), '--volumes') || /v/.test(shortFlags(sub.slice(down + 1))))) return danger('連同資料卷一起移除 Docker Compose 服務', EXPLAIN.dockerVolume)
  }
  // Databases: one command empties all of it.
  if (lower === 'redis-cli' && args.some(a => /^flush(?:all|db)$/i.test(a))) return danger('清空 Redis 資料庫', EXPLAIN.dbDrop)
  if (lower === 'dropdb' || (lower === 'mysqladmin' && args.some(a => /^drop$/i.test(a)))) return danger('刪除整個資料庫', EXPLAIN.dbDrop)
  const tool = launched(w)
  const name = nameOf(tool), rest = tool.slice(1)
  if (name === 'prisma' && ((rest[0] === 'migrate' && rest[1] === 'reset') || (rest[0] === 'db' && rest[1] === 'push' && has(rest, '--force-reset')))) return danger('清空並重建資料庫', EXPLAIN.devDb)
  if ((name === 'rails' || name === 'rake') && rest.some(a => /^db:(?:drop|reset|purge|migrate:reset)(?::all)?$/.test(a))) return danger('刪除並重建資料庫', EXPLAIN.devDb)
  const artisan = name === 'php' && /(?:^|[\\/])artisan$/.test(rest[0] ?? '') ? rest[1] : name === 'artisan' ? rest[0] : undefined
  if (artisan && /^(?:migrate:(?:fresh|reset|refresh)|db:wipe)$/.test(artisan)) return danger('清空並重建資料庫', EXPLAIN.devDb)
  const manage = /^(?:python[\d.]*|py)$/.test(name) && /(?:^|[\\/])manage\.py$/.test(rest[0] ?? '') ? rest[1] : name === 'manage.py' || name === 'django-admin' ? rest[0] : undefined
  if (manage === 'flush' || manage === 'reset_db') return danger('清空資料庫', EXPLAIN.devDb)
  // GitHub beyond `gh repo delete`.
  if (lower === 'gh' && args[0] === 'repo' && args[1] === 'delete') return danger('刪除 GitHub repo', EXPLAIN.ghRepo)
  if (lower === 'gh' && args[0] === 'repo' && args[1] === 'edit' && args.some((a, n) => /^--visibility=public$/i.test(a) || (a === '--visibility' && /^public$/i.test(args[n + 1] ?? '')))) return danger('把 repo 改成公開', EXPLAIN.ghPublic)
  if (lower === 'gh' && args[0] === 'repo' && args[1] === 'archive') return danger('封存 GitHub repo', EXPLAIN.ghArchive)
  if (lower === 'gh' && args[0] === 'secret' && (args[1] === 'delete' || args[1] === 'remove')) return danger('刪除 GitHub 密鑰', EXPLAIN.ghSecret)
  if (lower === 'gh' && args[0] === 'api' && args.some((a, n) => /^(?:-X|--method)=?DELETE$/i.test(a) || ((a === '-X' || a === '--method') && /^delete$/i.test(args[n + 1] ?? '')))) return danger('用 GitHub API 刪除', EXPLAIN.ghApi)
  if (lower === 'gh' && args[0] === 'release' && args[1] === 'delete') return danger('刪除 GitHub release', EXPLAIN.ghRelease)
  if ((lower === 'npm' || lower === 'pnpm' || lower === 'yarn' || lower === 'cargo') && (args[0] === 'publish' || args[0] === 'unpublish') && !dryRun(args)) {
    return args[0] === 'publish' ? danger('發布套件（正式環境操作）', EXPLAIN.publish) : danger('撤下已發布的套件（正式環境操作）', EXPLAIN.unpublish)
  }
  const publishes = (lower === 'yarn' && args[0] === 'npm' && args[1] === 'publish')
    || (name === 'twine' && rest[0] === 'upload') || (name === 'gem' && rest[0] === 'push') || (name === 'dotnet' && rest[0] === 'nuget' && rest[1] === 'push')
    || (/^(?:vsce|ovsx|poetry|flit|hatch|uv|bun|deno|jsr)$/.test(name) && rest[0] === 'publish')
  if (publishes && !dryRun(rest)) return danger('發布套件（正式環境操作）', EXPLAIN.publish)
  if (lower === 'gh' && args[0] === 'release' && args[1] === 'create') return danger('建立 GitHub release（正式環境操作）', EXPLAIN.releaseCreate)
  return null
}

/** Statements that empty or drop data, found anywhere in the command (an argument, a heredoc). */
const SQL: [RegExp, Danger][] = [
  [/\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i, danger('刪除資料表或資料庫', EXPLAIN.sql)],
  [/(?:^|[\s"'`;(])truncate\s+(?!table\b)(?!-)[A-Za-z_][\w.]*\s*(?:;|["'`]|$)/i, danger('清空資料表', EXPLAIN.sql)],
  [/(?:^|[\s"'`;(])delete\s+from\s+[\w."`[\]]+\s*(?:;|["'`]|$)/i, danger('刪除整張資料表的資料（沒有 WHERE）', EXPLAIN.deleteAll)],
  [/\bdb\.(?:[\w$]+\.)*drop(?:Database)?\(\s*\)/, danger('刪除 MongoDB 資料庫或集合', EXPLAIN.dbDrop)],
]
const FETCH = String.raw`(?:curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest)\b`
/** Downloads run without a pipe: `bash <(curl …)`, `sh -c "$(curl …)"`, `iex (irm …)`, `iex ((New-Object Net.WebClient).DownloadString(…))`. */
const FETCH_RUN = [
  new RegExp(String.raw`(?:^|[\s;&|(])(?:ba|z|da|k)?sh\s+<\(\s*${FETCH}`, 'i'),
  new RegExp(String.raw`(?:^|[\s;&|(])(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*${FETCH}`, 'i'),
  new RegExp(String.raw`\b(?:iex|invoke-expression)\b[\s("'&{$]*${FETCH}`, 'i'),
  /\b(?:iex|invoke-expression)\b[\s\S]*\.downloadstring\s*\(/i,
]
/** Commands that only search, show or record text: SQL words in their arguments run nothing (`git commit -m "drop table …"`). */
const TEXT_ONLY = /^(?:git|grep|egrep|rg|ag|findstr|select-string|sls|echo|printf|write-output|write-host|cat|type|get-content|gc|less|more|head|tail|wc|ls|dir)$/

function reasonOf(command: string, depth: number): Danger | null {
  const parts = pieces(command)
  const heads = parts.map(part => nameOf(words(part.text)))
  if (!heads.every(head => TEXT_ONLY.test(head))) {
    const sql = SQL.find(([pattern]) => pattern.test(command))
    if (sql) return sql[1]
    if (FETCH_RUN.some(pattern => pattern.test(command))) return danger('下載後直接執行（執行前看不到內容）', EXPLAIN.fetchRun)
  }
  let pipeline: string[] = []
  for (const part of parts) {
    pipeline = part.piped ? pipeline : []
    const found = segmentReason(part.text, depth, pipeline)
    if (found) return found
    pipeline = [...pipeline, part.text]
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
