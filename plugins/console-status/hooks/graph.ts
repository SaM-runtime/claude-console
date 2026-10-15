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

/** One drawn cell: a character and the colour slot of the line it belongs to (-1: no line). */
export type GraphCell = { ch: string; color: number }
export type GraphRow = { cells: GraphCell[]; col: number; commit?: GraphCommit }

/**
 * Lays commits (newest first, children before parents) out in lanes. Each lane waits for one
 * commit; a commit takes the leftmost lane waiting for it, the other lanes waiting for it bend into
 * it (`╯` `╰`), its first parent continues its lane, and each further parent bends out to a lane of
 * its own (`╮` `╭`) or into the lane already waiting for it (`┤` `├`). A line crossed by a bend shows
 * `┼`. Every new line gets the next of `colors` colour slots, so two branches side by side differ.
 * `work` adds a row above for uncommitted changes, on HEAD's line, which then stays leftmost.
 */
export function layoutGraph(commits: GraphCommit[], opts: { colors?: number; head?: string; work?: boolean } = {}): GraphRow[] {
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
    rows.push({ cells: [{ ch: '○', color: laneColor[0]! }], col: 0 })
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
      cells.push(i === col ? { ch: '●', color } : { ch: BOX[`${+up}${+down}${+l}${+r}`]!, color: up || down ? laneColor[i]! : l || r ? owner(i) : -1 })
      if (i < width - 1) cells.push(i >= col && i < right || i < col && i >= left ? { ch: '─', color: owner(i >= col ? i + 1 : i) } : { ch: ' ', color: -1 })
    }
    if (commit.hash === opts.head) cells[col * 2] = { ch: '◉', color }
    rows.push({ cells, col, commit })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
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
export function cellRuns(cells: GraphCell[], width: number): { text: string; color: number }[] {
  const out: { text: string; color: number }[] = []
  const padded = cells.concat(Array.from({ length: Math.max(0, width - cells.length) }, () => ({ ch: ' ', color: -1 })))
  for (const cell of padded) {
    const color = cell.ch === ' ' ? -1 : cell.color
    const last = out[out.length - 1]
    if (last && last.color === color) last.text += cell.ch
    else out.push({ text: cell.ch, color })
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
