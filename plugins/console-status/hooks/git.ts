// Git and pull-request state per project: what a developer checks before and after a dispatch.
// `git status` is local and cheap (every refresh); `gh pr view` goes to the network (slow interval).
import type { GitCommit, GitInfo, PrInfo } from '../types'

export type GitProbe = 'on' | 'git' | 'off'

/** `gitProbe` option: `on` git + gh, `git` local git only, `off` neither. Unknown values mean `on`. */
export function gitProbeMode(value: unknown): GitProbe {
  const v = String(value ?? '').trim().toLowerCase()
  return v === 'off' || v === 'git' ? v : 'on'
}

/** `--no-optional-locks`: a status read must never take the index lock a running executor needs. */
export function gitStatusArgs(root: string): string[] {
  return ['git', '--no-optional-locks', '-C', root, 'status', '--porcelain=v2', '--branch', '--show-stash']
}

/** The newest commits: short hash, commit time (seconds) and subject, unit-separated. */
export function gitLogArgs(root: string, count = 5): string[] {
  return ['git', '--no-optional-locks', '-C', root, 'log', `-${count}`, '--no-color', '--format=%h%x1f%ct%x1f%s']
}

/** Lines added and removed in uncommitted changes, staged or not. */
export function gitNumstatArgs(root: string): string[] {
  return ['git', '--no-optional-locks', '-C', root, 'diff', '--numstat', '--no-color', 'HEAD']
}

export function parseGitLog(text: string): GitCommit[] {
  const out: GitCommit[] = []
  for (const line of text.split(/\r?\n/)) {
    const [hash, at, ...rest] = line.split('\x1f')
    const seconds = Number(at)
    if (!hash || !/^[0-9a-f]{4,40}$/.test(hash) || !Number.isFinite(seconds)) continue
    out.push({ hash, at: seconds * 1000, subject: rest.join('\x1f').trim() })
  }
  return out
}

/** `git diff --numstat` totals; a binary file (`-`) counts no lines. */
export function parseNumstat(text: string): { add: number; del: number } {
  let add = 0, del = 0
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line)
    if (!m) continue
    if (m[1] !== '-') add += Number(m[1])
    if (m[2] !== '-') del += Number(m[2])
  }
  return { add, del }
}

/** `3 小時前` style age for commits and fetches. */
export function agoText(t: number, now: number): string {
  const m = Math.floor(Math.max(0, now - t) / 60_000)
  if (m < 1) return '剛剛'
  if (m < 60) return `${m} 分鐘前`
  if (m < 1440) return `${Math.floor(m / 60)} 小時前`
  return `${Math.floor(m / 1440)} 天前`
}

/** One commit for the card: `a1b2c3d 修正同步（2 小時前）`. */
export function commitLine(c: GitCommit, now: number): string {
  return `${c.hash} ${c.subject}（${agoText(c.at, now)}）`
}

/** A fetch older than this makes ahead/behind stale enough to say so. */
export const FETCH_STALE_MS = 24 * 3_600_000

const PR_FIELDS = 'number,title,state,isDraft,url,reviewDecision,statusCheckRollup'
export function prViewArgs(): string[] {
  return ['gh', 'pr', 'view', '--json', PR_FIELDS]
}

/** `git status --porcelain=v2 --branch`, or null when the output is not that (not a repository, a failed run). */
export function parseGitStatus(text: string): GitInfo | null {
  const lines = text.split(/\r?\n/)
  if (!lines.some(line => line.startsWith('# branch.oid '))) return null
  const info: GitInfo = { branch: '', ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0 }
  for (const line of lines) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      if (head === '(detached)') info.detached = true
      else info.branch = head
    } else if (line.startsWith('# branch.upstream ')) info.upstream = line.slice('# branch.upstream '.length).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/)
      if (m) { info.ahead = Number(m[1]); info.behind = Number(m[2]) }
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      if (oid !== '(initial)') { info.oid = oid.slice(0, 7); info.head = oid }
    } else if (line.startsWith('# stash ')) {
      const n = Number(line.slice('# stash '.length).trim())
      if (n > 0) info.stash = n
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) info.changed++
    else if (line.startsWith('u ')) info.conflicts++
    else if (line.startsWith('? ')) info.untracked++
  }
  if (!info.detached) delete info.oid
  return info
}

const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

/** `gh pr view --json …` for the current branch, or null (no PR, gh failed, unexpected shape). */
export function parsePrView(text: string): PrInfo | null {
  let data: any
  try { data = JSON.parse(text) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.number !== 'number') return null
  const checks = { pass: 0, fail: 0, pending: 0, failing: [] as string[] }
  for (const item of Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : []) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name ?? item.context ?? '').trim()
    // CheckRun: status + conclusion; StatusContext: state.
    const verdict = String(item.conclusion || item.state || '').toUpperCase()
    const done = item.status === undefined || String(item.status).toUpperCase() === 'COMPLETED'
    if (done && FAIL.has(verdict)) { checks.fail++; if (name && !checks.failing.includes(name)) checks.failing.push(name) }
    else if (done && PASS.has(verdict)) checks.pass++
    else checks.pending++
  }
  const state = String(data.state ?? '').toUpperCase()
  return {
    number: data.number,
    title: String(data.title ?? ''),
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    draft: data.isDraft === true,
    url: String(data.url ?? ''),
    ...(typeof data.reviewDecision === 'string' && data.reviewDecision ? { review: data.reviewDecision } : {}),
    checks,
  }
}

export type Tone = 'red' | 'amber' | 'blue' | 'teal' | 'green' | 'dim'

/** The table's short Git cell: the most pressing item first, at most ~7 columns. */
export function gitBadge(git: GitInfo | undefined, pr: PrInfo | undefined): { text: string; tone: Tone } {
  if (!git) return { text: '', tone: 'dim' }
  if (git.conflicts) return { text: `✕衝突${git.conflicts}`, tone: 'red' }
  const ci = pr && pr.state === 'OPEN' ? pr.checks : null
  if (ci?.fail) return { text: `CI✕${ci.fail}`, tone: 'red' }
  const dirty = git.changed + git.untracked
  const parts = [dirty ? `●${dirty}` : '', git.ahead ? `↑${git.ahead}` : '', git.behind ? `↓${git.behind}` : ''].filter(Boolean)
  if (parts.length) return { text: parts.join(''), tone: dirty ? 'amber' : 'blue' }
  if (ci?.pending) return { text: 'CI…', tone: 'teal' }
  return { text: '✓', tone: 'green' }
}

/** One readable line for cards, the action menu and prompt context. */
export function gitLine(git: GitInfo): string {
  const head = git.detached ? `分離 HEAD${git.oid ? ` ${git.oid}` : ''}` : git.branch || '（無分支）'
  const parts = [git.upstream ? `${head} → ${git.upstream}` : `${head}（無上游）`]
  if (git.ahead) parts.push(`領先 ${git.ahead}`)
  if (git.behind) parts.push(`落後 ${git.behind}`)
  if (git.conflicts) parts.push(`${git.conflicts} 個衝突`)
  if (git.changed) parts.push(`${git.changed} 個檔案未提交${git.lines && (git.lines.add || git.lines.del) ? `（+${git.lines.add} −${git.lines.del}）` : ''}`)
  if (git.untracked) parts.push(`${git.untracked} 個未追蹤`)
  if (!git.ahead && !git.behind && !git.conflicts && !git.changed && !git.untracked) parts.push('乾淨')
  if (git.stash) parts.push(`stash ${git.stash}`)
  return parts.join('　')
}

const REVIEW: Record<string, string> = { APPROVED: '已核准', CHANGES_REQUESTED: '要求修改', REVIEW_REQUIRED: '待審查' }

export function prLine(pr: PrInfo): string {
  const status = pr.state === 'MERGED' ? '已合併' : pr.state === 'CLOSED' ? '已關閉' : pr.draft ? '草稿' : '開啟'
  const parts = [`#${pr.number} ${pr.title}（${status}）`]
  if (pr.state === 'OPEN') {
    const c = pr.checks
    if (c.fail) parts.push(`CI ✕ ${c.fail} 失敗：${c.failing.slice(0, 3).join('、')}${c.failing.length > 3 ? '…' : ''}`)
    if (c.pending) parts.push(`${c.pending} 進行中`)
    if (!c.fail && !c.pending && c.pass) parts.push(`CI ✓ ${c.pass} 通過`)
    if (pr.review && REVIEW[pr.review]) parts.push(REVIEW[pr.review]!)
  }
  return parts.join('　')
}

/** CI transitions worth a feed line (and a toast for a new failure). Same PR number only. */
export function prTransitions(name: string, prev: PrInfo | undefined, cur: PrInfo | undefined): { text: string; tone: 'red' | 'green'; toast: boolean }[] {
  if (!prev || !cur || prev.number !== cur.number) return []
  const out: { text: string; tone: 'red' | 'green'; toast: boolean }[] = []
  if (cur.state === 'MERGED' && prev.state !== 'MERGED') out.push({ text: `${name}　PR #${cur.number} 已合併`, tone: 'green', toast: false })
  else if (cur.state === 'OPEN') {
    if (cur.checks.fail && !prev.checks.fail) out.push({ text: `${name}　PR #${cur.number} CI 失敗：${cur.checks.failing.slice(0, 2).join('、')}`, tone: 'red', toast: true })
    else if (!cur.checks.fail && !cur.checks.pending && cur.checks.pass && (prev.checks.fail || prev.checks.pending)) out.push({ text: `${name}　PR #${cur.number} CI 全部通過`, tone: 'green', toast: false })
  }
  return out
}
