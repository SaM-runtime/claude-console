// The on-demand branch graph under a project's Git row: `git log` read once, laid out here.
// One row per commit, lanes drawn with rounded box lines the way lazygit draws its graph:
// a branch joining or leaving bends on the commit's own row (`●─╮`, `●─╯`), so the graph
// never needs connector-only rows and stays as tall as the commit list.
import type { GraphCommit, GraphRef } from '../types'

export type GraphScope = 'local' | 'all'

/** How many commits a view reads first; `▾ 更多` adds this many again, up to GRAPH_MAX. */
export const GRAPH_PAGE = 30
export const GRAPH_MAX = 150

/**
 * `git log` for the graph: full hash, parents, full ref names, time and subject,
 * unit-separated. `local` is HEAD, the local branches and the current upstream; `all` adds every
 * remote branch and tag. The upstream goes in as `--remotes=` so one that is really a local branch
 * matches nothing instead of failing the read. Refs are named so `refs/stash` never joins the graph,
 * and `--` keeps a branch name from being read as a path. One extra commit says whether there is more.
 */
export function gitGraphArgs(root: string, scope: GraphScope, limit: number, upstream?: string): string[] {
  const refs = scope === 'all' ? ['HEAD', '--branches', '--remotes', '--tags'] : ['HEAD', '--branches', ...(upstream ? [`--remotes=${upstream}`] : [])]
  return ['git', '--no-optional-locks', '-C', root, 'log', '--topo-order', '--decorate=full', '--no-color', `-${limit + 1}`, '--format=%H%x1f%P%x1f%D%x1f%ct%x1f%s', ...refs, '--']
}

/** `%D` with `--decorate=full`: what kind each ref is, `origin/HEAD` left out. */
export function parseRefs(text: string): GraphRef[] {
  const out: GraphRef[] = []
  for (const raw of text.split(', ')) {
    let name = raw.trim()
    if (!name) continue
    let head = false
    if (name.startsWith('HEAD -> ')) { head = true; name = name.slice('HEAD -> '.length) }
    if (name === 'HEAD') { out.push({ kind: 'head', name: 'HEAD' }); continue }
    if (name.startsWith('tag: ')) { out.push({ kind: 'tag', name: name.slice('tag: '.length).replace(/^refs\/tags\//, '') }); continue }
    if (name.startsWith('refs/heads/')) { out.push({ kind: 'branch', name: name.slice('refs/heads/'.length), ...(head ? { current: true } : {}) }); continue }
    if (name.startsWith('refs/remotes/')) {
      const short = name.slice('refs/remotes/'.length)
      if (!short.endsWith('/HEAD')) out.push({ kind: 'remote', name: short })
      continue
    }
    if (name.startsWith('refs/tags/')) { out.push({ kind: 'tag', name: name.slice('refs/tags/'.length) }); continue }
  }
  return out
}

export function parseGraphLog(text: string): GraphCommit[] {
  const out: GraphCommit[] = []
  for (const line of text.split(/\r?\n/)) {
    const [hash, parents, refs, at, ...rest] = line.split('\x1f')
    const seconds = Number(at)
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash) || !Number.isFinite(seconds)) continue
    out.push({
      hash, parents: (parents ?? '').split(' ').filter(Boolean), refs: parseRefs(refs ?? ''),
      at: seconds * 1000, subject: rest.join('\x1f').trim(),
    })
  }
  return out
}

/**
 * The labels a commit shows, current branch first. A local branch whose remote twin sits on the
 * same commit is one label with the remote's name after it (`main ⇄ origin`): in step with it.
 */
export function refLabels(refs: GraphRef[]): { text: string; kind: 'current' | 'branch' | 'remote' | 'tag' | 'head'; synced?: string }[] {
  const locals = refs.filter(r => r.kind === 'branch')
  const remotes = refs.filter(r => r.kind === 'remote')
  const twin = (name: string) => remotes.filter(r => r.name.slice(r.name.indexOf('/') + 1) === name)
  const used = new Set<string>()
  const out: ReturnType<typeof refLabels> = []
  if (refs.some(r => r.kind === 'head')) out.push({ text: 'HEAD', kind: 'head' })
  for (const b of [...locals.filter(r => r.current), ...locals.filter(r => !r.current)]) {
    const twins = twin(b.name)
    twins.forEach(r => used.add(r.name))
    const synced = twins.map(r => r.name.slice(0, r.name.indexOf('/'))).join('・')
    out.push({ text: b.name, kind: b.current ? 'current' : 'branch', ...(synced ? { synced } : {}) })
  }
  for (const r of remotes) if (!used.has(r.name)) out.push({ text: r.name, kind: 'remote' })
  for (const t of refs.filter(r => r.kind === 'tag')) out.push({ text: t.name, kind: 'tag' })
  return out
}

/** Box character by which way lines leave a cell: up, down, left, right. */
const BOX: Record<string, string> = {
  '0000': ' ', '1100': '│', '0011': '─', '1111': '┼', '1110': '┤', '1101': '├',
  '1010': '╯', '1001': '╰', '1011': '┴', '0110': '╮', '0101': '╭', '0111': '┬',
  '1000': '│', '0100': '│', '0010': '─', '0001': '─',
}

/**
 * The `line` style's commit: a heavy stretch of its own lane, joined to the bends beside it, so the
 * line runs through the commit with no gap. A dot (`●`) is a font glyph that never reaches the top
 * and bottom of its cell, so a line above or below it always shows a break; box lines do reach the
 * edges, and Windows Terminal draws them itself edge to edge. Keyed up, down, left, right.
 */
const NODE: Record<string, string> = {
  '1100': '╽', '1101': '┟', '1110': '┧', '1111': '╁', '1000': '╹', '1001': '┖', '1010': '┚', '1011': '┸',
  '0100': '╻', '0101': '┎', '0110': '┒', '0111': '┰', '0000': '┃', '0001': '┃', '0010': '┃', '0011': '┃',
}

/**
 * `spaced`: VS Code Git Graph / GitKraken style, a `●` per commit with a row of lines between
 * commits, where branches bend in and out. `line`: one row per commit, each a heavy stretch of a
 * seamless line. `dot`: one row per commit, a `●` each (HEAD `◉`), as in 0.22.0.
 */
export type GraphStyle = 'spaced' | 'line' | 'dot'
export const GRAPH_STYLES: GraphStyle[] = ['spaced', 'line', 'dot']

/** `gitGraph` option: `line` or `dot` on request, anything else is `spaced`. */
export function graphStyle(value: unknown): GraphStyle {
  const v = String(value ?? '').trim().toLowerCase()
  return v === 'line' || v === 'dot' ? v : 'spaced'
}

/**
 * One drawn cell: a character and the colour slot of the line it belongs to (-1: no line). `node`
 * marks a commit (drawn bright; the lines between commits are drawn softer in the `line` style).
 */
export type GraphCell = { ch: string; color: number; node?: boolean }
/**
 * `after`: the colour slot of each lane still running below the row (-1: none), for a divider row.
 * `link`: a row of lines only, between two commits of the `spaced` style (no commit, `col` -1).
 */
export type GraphRow = { cells: GraphCell[]; col: number; commit?: GraphCommit; after: number[]; link?: boolean }

/**
 * Lays commits (newest first, children before parents) out in lanes. Each lane waits for one
 * commit; a commit takes the leftmost lane waiting for it, the other lanes waiting for it bend into
 * it (`╯` `╰`), its first parent continues its lane, and each further parent bends out to a lane of
 * its own (`╮` `╭`) or into the lane already waiting for it (`┤` `├`). A line crossed by a bend shows
 * `┼`. Every new line gets the next of `colors` colour slots, so two branches side by side differ.
 * `work` adds a row above for uncommitted changes, on HEAD's line, which then stays leftmost.
 */
export function layoutGraph(commits: GraphCommit[], opts: { colors?: number; head?: string; work?: boolean; style?: GraphStyle } = {}): GraphRow[] {
  if ((opts.style ?? 'spaced') === 'spaced') return layoutSpaced(commits, opts)
  const line = opts.style === 'line'
  const colors = Math.max(1, opts.colors ?? 6)
  const lanes: (string | null)[] = []
  const laneColor: number[] = []
  let nextColor = 0
  const fresh = () => nextColor++ % colors
  const rows: GraphRow[] = []
  const shown = new Set(commits.map(c => c.hash))
  if (opts.work && opts.head && shown.has(opts.head)) {
    lanes.push(opts.head)
    laneColor.push(fresh())
    rows.push({ cells: [{ ch: line ? '┇' : '○', color: laneColor[0]!, node: true }], col: 0, after: [laneColor[0]!] })
  }
  for (const commit of commits) {
    const hits: number[] = []
    lanes.forEach((h, i) => { if (h === commit.hash) hits.push(i) })
    let col = hits[0] ?? lanes.indexOf(null)
    if (col < 0) col = lanes.length
    const before = lanes.slice()
    if (!hits.length) laneColor[col] = fresh()
    const color = laneColor[col]!
    for (const i of hits) if (i !== col) lanes[i] = null
    lanes[col] = commit.parents[0] ?? null
    // Further parents: into a lane already waiting for that parent, else a new lane to the right.
    const out = new Map<number, boolean>()
    for (const parent of commit.parents.slice(1)) {
      const waiting = lanes.indexOf(parent)
      if (waiting >= 0 && waiting !== col) { out.set(waiting, true); continue }
      // A lane that just bent in is not reused on the same row: its line ends here.
      let j = lanes.findIndex((h, i) => h === null && i > col && !hits.includes(i))
      if (j < 0) j = Math.max(lanes.length, col + 1)
      lanes[j] = parent
      laneColor[j] = fresh()
      out.set(j, false)
    }
    const into = new Set(hits.filter(i => i !== col))
    const ends = [...into, ...out.keys()]
    const right = Math.max(col, ...ends.filter(i => i > col))
    const left = Math.min(col, ...ends.filter(i => i < col))
    const width = Math.max(before.length, lanes.length)
    // The bend nearest beyond a point owns the horizontal line there, so each line keeps its colour.
    const owner = (i: number) => {
      const near = i > col ? ends.filter(e => e >= i && e > col).sort((a, b) => a - b)[0] : ends.filter(e => e <= i && e < col).sort((a, b) => b - a)[0]
      return near === undefined ? color : laneColor[near]!
    }
    const cells: GraphCell[] = []
    for (let i = 0; i < width; i++) {
      const up = before[i] != null, down = lanes[i] != null
      // A bend reaches this lane from the commit's side; it goes on past it when a farther one waits.
      const inner = (i > col && i <= right) || (i < col && i >= left)
      const outer = (i > col && i < right) || (i < col && i > left)
      const [l, r] = i > col ? [inner, outer] : [outer, inner]
      cells.push(i === col ? { ch: line ? NODE[`${+(hits.length > 0)}${+(lanes[col] != null)}${+(left < col)}${+(right > col)}`]! : '●', color, node: true } : { ch: BOX[`${+up}${+down}${+l}${+r}`]!, color: up || down ? laneColor[i]! : l || r ? owner(i) : -1 })
      if (i < width - 1) cells.push(i >= col && i < right || i < col && i >= left ? { ch: '─', color: owner(i >= col ? i + 1 : i) } : { ch: ' ', color: -1 })
    }
    if (commit.hash === opts.head && !line) cells[col * 2] = { ch: '◉', color, node: true }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    rows.push({ cells, col, commit, after: lanes.map((h, i) => (h === null ? -1 : laneColor[i]!)) })
  }
  return rows
}

/**
 * The `spaced` layout: the lanes of {@link layoutGraph}, but a commit row holds only its `●` and the
 * lines passing by. Between two commits sits a link row: plain lines, or the bends there. Lanes
 * waiting for the next commit bend into it on the link row above it (`├─╯`); a merge's further
 * parents bend out on the link row below it (`├─╮`, or `┤` into a lane already waiting). A link row
 * never holds both, so each bend reads on its own.
 */
function layoutSpaced(commits: GraphCommit[], opts: { colors?: number; head?: string; work?: boolean }): GraphRow[] {
  const colors = Math.max(1, opts.colors ?? 6)
  const lanes: (string | null)[] = []
  const laneColor: number[] = []
  let nextColor = 0
  const fresh = () => nextColor++ % colors
  const rows: GraphRow[] = []
  const shown = new Set(commits.map(c => c.hash))
  const running = () => lanes.map((h, i) => (h === null ? -1 : laneColor[i]!))
  type Seg = { u: boolean; d: boolean; l: boolean; r: boolean; color: number }
  const pass = (): Seg[] => lanes.map((h, i) => ({ u: h !== null, d: h !== null, l: false, r: false, color: h === null ? -1 : laneColor[i]! }))
  /** Lanes as cells; `gap[i]` colours the `─` between lane i and i+1 (-1: blank). */
  const cellsOf = (segs: Seg[], gap: number[] = []): GraphCell[] => {
    const out: GraphCell[] = []
    segs.forEach((g, i) => {
      if (i) out.push(gap[i - 1]! >= 0 ? { ch: '─', color: gap[i - 1]! } : { ch: ' ', color: -1 })
      out.push({ ch: BOX[`${+g.u}${+g.d}${+g.l}${+g.r}`]!, color: g.color })
    })
    while (out.length && out[out.length - 1]!.ch === ' ') out.pop()
    return out
  }
  const link = (cells: GraphCell[]) => rows.push({ cells, col: -1, after: running(), link: true })
  /** Bends from `col` to each end in `ends` (lane → colour of its line): the nearest end beyond a point owns the line there. */
  const bend = (segs: Seg[], col: number, ends: Map<number, number>) => {
    const gap: number[] = Array.from({ length: segs.length }, () => -1)
    const keys = [...ends.keys()]
    for (let i = 0; i < segs.length; i++) {
      if (i === col) continue
      const beyond = i > col ? keys.filter(e => e >= i && e > col).sort((a, b) => a - b)[0] : keys.filter(e => e <= i && e < col).sort((a, b) => b - a)[0]
      if (beyond === undefined) continue
      const owner = ends.get(beyond)!
      const seg = segs[i]!
      if (i > col) { seg.l = true; seg.r = i < beyond || keys.some(e => e > i) } else { seg.r = true; seg.l = i > beyond || keys.some(e => e < i) }
      if (!seg.u && !seg.d) seg.color = owner
      gap[i > col ? i - 1 : i] = owner
      if (i > col) segs[col]!.r = true; else segs[col]!.l = true
    }
    return gap
  }
  if (opts.work && opts.head && shown.has(opts.head)) {
    lanes.push(opts.head)
    laneColor.push(fresh())
    rows.push({ cells: [{ ch: '○', color: laneColor[0]!, node: true }], col: 0, after: running() })
  }
  for (const commit of commits) {
    const hits: number[] = []
    lanes.forEach((h, i) => { if (h === commit.hash) hits.push(i) })
    let col = hits[0] ?? lanes.indexOf(null)
    if (col < 0) col = lanes.length
    // The link row above: lanes waiting for this commit bend into its lane, else plain lines.
    if (rows.length) {
      const segs = pass()
      const ends = new Map(hits.filter(i => i !== col).map(i => [i, laneColor[i]!] as [number, number]))
      for (const i of ends.keys()) segs[i]!.d = false
      // A merge's link row already parts this commit from the one above, unless bends must go in too.
      if (ends.size || !rows[rows.length - 1]!.link) link(cellsOf(segs, ends.size ? bend(segs, col, ends) : []))
      for (const i of ends.keys()) lanes[i] = null
    }
    if (!hits.length) { lanes[col] = commit.hash; laneColor[col] = fresh() }
    const color = laneColor[col]!
    const node = pass()
    const cells = cellsOf(node.map((g, i) => (i === col ? { ...g, u: false, d: false } : g)))
    while (cells.length <= col * 2) cells.push({ ch: ' ', color: -1 })
    cells[col * 2] = { ch: '●', color, node: true }
    lanes[col] = commit.parents[0] ?? null
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    rows.push({ cells, col, commit, after: running() })
    // A merge's further parents bend out on the link row below: into a lane already waiting, else a new lane.
    const further = commit.parents.slice(1)
    if (further.length) {
      const segs = pass()
      while (segs.length <= col) segs.push({ u: false, d: false, l: false, r: false, color: -1 })
      segs[col] = { u: true, d: lanes[col] != null, l: false, r: false, color }
      const ends = new Map<number, number>()
      for (const parent of further) {
        const waiting = lanes.indexOf(parent)
        if (waiting >= 0 && waiting !== col) { ends.set(waiting, laneColor[waiting]!); continue }
        let j = lanes.findIndex((h, i) => h === null && i > col)
        if (j < 0) j = Math.max(lanes.length, col + 1)
        lanes[j] = parent
        laneColor[j] = fresh()
        while (segs.length <= j) segs.push({ u: false, d: false, l: false, r: false, color: -1 })
        segs[j] = { u: false, d: true, l: false, r: false, color: laneColor[j]! }
        ends.set(j, laneColor[j]!)
      }
      link(cellsOf(segs, bend(segs, col, ends)))
    }
  }
  return rows
}

/**
 * A row cut to `lanes` lanes: what does not fit becomes one `…`, and a commit beyond the cut is
 * drawn there instead, so every row still shows its dot. Trailing blanks are trimmed by the caller.
 */
export function clipCells(row: GraphRow, lanes: number): GraphCell[] {
  const max = lanes * 2 - 1
  if (row.cells.length <= max) return row.cells
  const kept = row.cells.slice(0, max - 1)
  const dot = row.col * 2 >= max - 1 ? row.cells[row.col * 2]! : null
  return [...kept, dot ?? { ch: '…', color: -1 }]
}

/** The widest row in drawn cells, so every row's text starts in the same column. */
export function graphWidth(rows: GraphRow[], lanes: number): number {
  return rows.reduce((w, row) => Math.max(w, clipCells(row, lanes).length), 1)
}

/** Consecutive cells of one colour merged into runs, to draw a row with few Text nodes. */
export function cellRuns(cells: GraphCell[], width: number): { text: string; color: number; node?: boolean }[] {
  const out: { text: string; color: number; node?: boolean }[] = []
  const padded = cells.concat(Array.from({ length: Math.max(0, width - cells.length) }, () => ({ ch: ' ', color: -1 })))
  for (const cell of padded as GraphCell[]) {
    const color = cell.ch === ' ' ? -1 : cell.color
    const node = Boolean(cell.node)
    const last = out[out.length - 1]
    if (last && last.color === color && Boolean(last.node) === node) last.text += cell.ch
    else out.push(node ? { text: cell.ch, color, node } : { text: cell.ch, color })
  }
  return out
}

/** `3 時` style age that stays within five columns, for the graph's right-hand column. */
export function shortAgo(t: number, now: number): string {
  const m = Math.floor(Math.max(0, now - t) / 60_000)
  if (m < 1) return '剛剛'
  if (m < 60) return `${m} 分`
  if (m < 1440) return `${Math.floor(m / 60)} 時`
  if (m < 60 * 24 * 30) return `${Math.floor(m / 1440)} 天`
  if (m < 60 * 24 * 365) return `${Math.floor(m / 43200)} 月`
  return `${Math.floor(m / 525600)} 年`
}

/** `#rrggbb` moved `amount` of the way toward `to`: a softer shade of a line on a dark pane. */
export function mix(color: string, to: string, amount: number): string {
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const a = rgb(color), b = rgb(to)
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return color
  return '#' + a.map((v, i) => Math.round(v + (b[i]! - v) * amount).toString(16).padStart(2, '0')).join('')
}

/** The cells of a divider row under `row`: every lane still running goes straight through. */
export function throughCells(row: GraphRow): GraphCell[] {
  const out: GraphCell[] = []
  row.after.forEach((color, i) => {
    if (i) out.push({ ch: ' ', color: -1 })
    out.push(color < 0 ? { ch: ' ', color: -1 } : { ch: '│', color })
  })
  return out
}

/** The graph's divider labels, newest first. */
export const DAY_GROUPS = ['今天', '昨天', '最近一週', '最近一個月', '更早']

/** Which stretch of time a commit falls in, by local calendar day: the graph's divider labels. */
export function dayGroup(t: number, now: number): string {
  const day = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000 }
  const days = day(now) - day(t)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  // Past yesterday, count whole days elapsed, the way the age column (`6 天`) counts them.
  const elapsed = Math.floor(Math.max(0, now - t) / 86_400_000)
  return elapsed < 7 ? '最近一週' : elapsed < 30 ? '最近一個月' : '更早'
}

/** Commits on local branches that no remote has: what a push would send. */
export function gitUnpushedArgs(root: string): string[] {
  return ['git', '--no-optional-locks', '-C', root, 'log', '-500', '--format=%H', '--branches', '--not', '--remotes', '--']
}

/** Commits the upstream has and HEAD does not: what a pull would bring. Fails harmlessly with no upstream. */
export function gitIncomingArgs(root: string): string[] {
  return ['git', '--no-optional-locks', '-C', root, 'rev-list', '-500', '@{upstream}', '--not', 'HEAD', '--']
}

/** Every open pull request with its branch and checks, so each branch label can carry its PR. */
export function prListArgs(): string[] {
  return ['gh', 'pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,state,isDraft,url,reviewDecision,statusCheckRollup,headRefName']
}

/** Full hashes, one per line. */
export function parseHashes(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => /^[0-9a-f]{7,64}$/.test(line))
}

/** One commit opened in the graph: who, when, the whole message and the files with their lines. */
export function gitCommitArgs(root: string, hash: string): string[] {
  return ['git', '--no-optional-locks', '-C', root, 'show', '--no-color', '--no-renames', '-m', '--first-parent', '--numstat', '--format=%H%x1f%an%x1f%ct%x1f%B%x1e', hash, '--']
}

export type CommitDetail = { hash: string; author: string; at: number; body: string; files: { path: string; lines?: { add: number; del: number } }[] }

/** `git show` read by gitCommitArgs; a merge's files are what it brought into its first parent. */
export function parseCommitDetail(text: string): CommitDetail | null {
  const cut = text.indexOf('\x1e')
  if (cut < 0) return null
  const [hash, author, at, ...body] = text.slice(0, cut).split('\x1f')
  const seconds = Number(at)
  if (!hash || !/^[0-9a-f]{7,64}$/.test(hash.trim()) || !Number.isFinite(seconds)) return null
  const files: CommitDetail['files'] = []
  const seen = new Set<string>()
  for (const line of text.slice(cut + 1).split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m || seen.has(m[3]!)) continue
    seen.add(m[3]!)
    files.push(m[1] === '-' || m[2] === '-' ? { path: m[3]! } : { path: m[3]!, lines: { add: Number(m[1]), del: Number(m[2]) } })
  }
  return { hash: hash.trim(), author: (author ?? '').trim(), at: seconds * 1000, body: body.join('\x1f').trim(), files }
}

/** What a commit attached to a prompt carries: its message, the files and the patch, cut to fit. */
export function gitAttachArgs(root: string, hash: string): string[] {
  return ['git', '--no-optional-locks', '-C', root, 'show', '--no-color', '-m', '--first-parent', '--stat', '--patch', '--format=commit %H%nAuthor: %an%nDate: %ci%n%n%B', hash, '--']
}

/** At most `maxLines` lines and `maxChars` characters, saying how much was left out. */
export function clipPatch(text: string, maxLines = 400, maxChars = 24_000): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  let out = lines.slice(0, maxLines).join('\n')
  const cutChars = out.length > maxChars
  if (cutChars) out = out.slice(0, maxChars)
  if (cutChars) return `${out}\n…（內容太長，後面的部分沒有附上）`
  if (lines.length <= maxLines) return out
  return `${out}\n…（後面還有 ${lines.length - maxLines} 行沒有附上）`
}
