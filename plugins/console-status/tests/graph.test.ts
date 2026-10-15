import { expect, test } from 'claude-code/testing'
import { DAY_GROUPS, cellRuns, clipCells, clipPatch, dayGroup, gitCommitArgs, parseCommitDetail, parseHashes, gitGraphArgs, graphStyle, throughCells, graphWidth, layoutGraph, mix, parseGraphLog, parseRefs, refLabels, shortAgo } from '../hooks/graph'
import type { GraphCommit } from '../types'

const c = (hash: string, parents: string[] = [], subject = hash): GraphCommit => ({ hash, parents, refs: [], at: 0, subject })
const draw = (rows: ReturnType<typeof layoutGraph>) => rows.map(r => r.cells.map(x => x.ch).join('').trimEnd())

test('graph args read the local branches and the upstream, or everything, never the stash', () => {
  expect(gitGraphArgs('D:/A', 'local', 30, 'origin/main').slice(4)).toEqual(['log', '--topo-order', '--decorate=full', '--no-color', '-31', '--format=%H%x1f%P%x1f%D%x1f%ct%x1f%s', 'HEAD', '--branches', '--remotes=origin/main', '--'])
  expect(gitGraphArgs('D:/A', 'local', 30).slice(-3)).toEqual(['HEAD', '--branches', '--'])
  expect(gitGraphArgs('D:/A', 'all', 60).slice(-5)).toEqual(['HEAD', '--branches', '--remotes', '--tags', '--'])
})

test('refs: the current branch first, a remote twin on the same commit folds into it, origin/HEAD is dropped', () => {
  const refs = parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/remotes/upstream/main, tag: refs/tags/v1.0, refs/heads/docs, refs/remotes/origin/feature/x')
  expect(refs).toEqual([
    { kind: 'branch', name: 'main', current: true }, { kind: 'remote', name: 'origin/main' }, { kind: 'remote', name: 'upstream/main' },
    { kind: 'tag', name: 'v1.0' }, { kind: 'branch', name: 'docs' }, { kind: 'remote', name: 'origin/feature/x' },
  ])
  expect(refLabels(refs)).toEqual([
    { text: 'main', kind: 'current', synced: 'origin・upstream' }, { text: 'docs', kind: 'branch' },
    { text: 'origin/feature/x', kind: 'remote' }, { text: 'v1.0', kind: 'tag' },
  ])
  expect(refLabels(parseRefs('HEAD, refs/heads/main'))).toEqual([{ text: 'HEAD', kind: 'head' }, { text: 'main', kind: 'branch' }])
})

test('the log parses parents, refs and subjects with separators kept; junk lines are skipped', () => {
  const text = ['a'.repeat(40) + '\x1f' + 'b'.repeat(40) + ' ' + 'c'.repeat(40) + '\x1fHEAD -> refs/heads/main\x1f1700000000\x1fMerge: a\x1fb', 'warning: something', ''].join('\r\n')
  expect(parseGraphLog(text)).toEqual([{ hash: 'a'.repeat(40), parents: ['b'.repeat(40), 'c'.repeat(40)], refs: [{ kind: 'branch', name: 'main', current: true }], at: 1700000000000, subject: 'Merge: a\x1fb' }])
})

test('a merge bends out and the branch bends back in on the commits own rows', () => {
  // M merges F into main; F and A both come from B.
  const rows = layoutGraph([c('M', ['A', 'F']), c('F', ['B']), c('A', ['B']), c('B')], { head: 'M', work: true, style: 'dot' })
  expect(draw(rows)).toEqual(['○', '◉─╮', '│ ●', '● │', '●─╯'])
  expect(rows.map(r => r.col)).toEqual([0, 0, 1, 0, 0])
  // The merged branch keeps its own colour on its bend and its line.
  expect(rows[1]!.cells[2]!.color).toBe(rows[2]!.cells[2]!.color)
  expect(rows[1]!.cells[0]!.color).not.toBe(rows[1]!.cells[2]!.color)
})

test('the line style draws each commit as a heavy stretch joined to its line and bends, with no gap', () => {
  const rows = layoutGraph([c('M', ['A', 'F']), c('F', ['B']), c('A', ['B']), c('B')], { head: 'M', work: true, style: 'line' })
  // Uncommitted work is dashed; a commit is heavy below its centre, so commits in a row stay apart.
  expect(draw(rows)).toEqual(['┇', '┟─╮', '│ ╽', '╽ │', '┖─╯'])
  expect(rows[1]!.cells.map(x => Boolean(x.node))).toEqual([true, false, false])
  expect(draw(layoutGraph([c('T')], { style: 'line' }))).toEqual(['┃'])
  expect(cellRuns([{ ch: '╽', color: 0, node: true }, { ch: '─', color: 0 }, { ch: '╮', color: 1 }], 3)).toEqual([{ text: '╽', color: 0, node: true }, { text: '─', color: 0 }, { text: '╮', color: 1 }])
  expect([graphStyle(undefined), graphStyle('line'), graphStyle(' Dot '), graphStyle('x')]).toEqual(['spaced', 'line', 'dot', 'spaced'])
  expect(mix('#8BD5CA', '#1C222B', 0.45)).toBe('#598482')
  expect(mix('bad', '#000000', 0.5)).toBe('bad')
})

test('the spaced style puts a row of lines between commits, where branches bend in and out', () => {
  const rows = layoutGraph([c('M', ['A', 'F']), c('F', ['B']), c('A', ['B']), c('B')], { head: 'M', work: true })
  // A merge bends out below it, a branch bends in above the commit it starts from; plain lines part the rest.
  expect(draw(rows)).toEqual(['○', '│', '●', '├─╮', '│ ●', '│ │', '● │', '├─╯', '●'])
  expect(rows.map(r => Boolean(r.link))).toEqual([false, true, false, true, false, true, false, true, false])
  expect(rows[2]!.cells.map(x => Boolean(x.node))).toEqual([true])
  // A bend that passes a line crosses it; a parent another lane already waits for is joined with ┤.
  expect(draw(layoutGraph([c('T', ['M1']), c('X', ['D', 'M2']), c('D', ['M2']), c('M1', ['M2', 'H']), c('H', ['M2']), c('M2')])))
    .toEqual(['●', '│', '│ ●', '│ ├─╮', '│ ● │', '│ │ │', '● │ │', '├─┼─┼─╮', '│ │ │ ●', '├─┴─┴─╯', '●'])
  expect(draw(layoutGraph([c('T')]))).toEqual(['●'])
})

test('a bend that crosses a line shows the crossing and joins a lane already waiting for that parent', () => {
  const rows = layoutGraph([c('T', ['M1']), c('X', ['D', 'M2']), c('D', ['M2']), c('M1', ['M2', 'H']), c('H', ['M2']), c('M2')], { style: 'dot' })
  expect(draw(rows)).toEqual(['●', '│ ●─╮', '│ ● │', '●─┼─┼─╮', '│ │ │ ●', '●─┴─┴─╯'])
})

test('a lane that ends on a row is not reused on it: the new branch line starts beyond it', () => {
  // M merges H while the D line bends into M on the same row.
  const rows = layoutGraph([c('T', ['M']), c('D', ['M']), c('M', ['B', 'H']), c('H', ['B']), c('B')], { style: 'dot' })
  expect(draw(rows)).toEqual(['●', '│ ●', '●─┴─╮', '│   ●', '●───╯'])
})

test('a second tip gets its own lane; a commit merging into a waiting lane draws ├ or ┤', () => {
  const rows = layoutGraph([c('A', ['P']), c('B', ['Q', 'P']), c('Q', ['P']), c('P')], { style: 'dot' })
  expect(draw(rows)).toEqual(['●', '├─●', '│ ●', '●─╯'])
})

test('clipping folds extra lanes into …, keeps an off-screen commit visible, and runs merge colours', () => {
  const wide = layoutGraph([c('a', ['z']), c('b', ['z']), c('c', ['z']), c('d', ['z']), c('z')], { style: 'dot' })
  expect(draw(wide)).toEqual(['●', '│ ●', '│ │ ●', '│ │ │ ●', '●─┴─┴─╯'])
  expect(clipCells(wide[3]!, 2).map(x => x.ch).join('')).toBe('│ ●')
  expect(clipCells(wide[4]!, 2).map(x => x.ch).join('')).toBe('●─…')
  expect(graphWidth(wide, 3)).toBe(5)
  expect(cellRuns([{ ch: '●', color: 0 }, { ch: '─', color: 1 }, { ch: '╮', color: 1 }], 5)).toEqual([{ text: '●', color: 0 }, { text: '─╮', color: 1 }, { text: '  ', color: -1 }])
})

test('divider rows carry every lane still running, and time groups follow the age column', () => {
  const rows = layoutGraph([c('M', ['A', 'F']), c('F', ['B']), c('A', ['B']), c('B')], { style: 'dot' })
  expect(rows.map(r => r.after)).toEqual([[0, 1], [0, 1], [0, 1], []])
  expect(throughCells(rows[0]!).map(x => x.ch).join('')).toBe('│ │')
  expect(throughCells(rows[3]!)).toEqual([])
  const now = new Date(2030, 0, 5, 12, 0).getTime()
  const at = (d: number, h = 12) => new Date(2030, 0, 5 - d, h, 0).getTime()
  expect([at(0, 1), at(1, 23), at(2), at(6), at(7), at(29), at(30)].map(t => dayGroup(t, now))).toEqual(['今天', '昨天', '最近一週', '最近一週', '最近一個月', '最近一個月', '更早'])
  expect(DAY_GROUPS).toEqual(['今天', '昨天', '最近一週', '最近一個月', '更早'])
})

test('a commit opened in the graph: who, when, message and files; hashes and long patches', () => {
  expect(gitCommitArgs('D:/A', 'abc1234').slice(4)).toEqual(['show', '--no-color', '--no-renames', '-m', '--first-parent', '--numstat', '--format=%H%x1f%an%x1f%ct%x1f%B%x1e', 'abc1234', '--'])
  expect(parseCommitDetail('abc1234\x1fAnn\x1f1700000000\x1fTitle\r\n\r\nBody\x1e\n\n3\t1\ta.ts\n-\t-\tb.png\n3\t1\ta.ts\n')).toEqual({
    hash: 'abc1234', author: 'Ann', at: 1700000000000, body: 'Title\r\n\r\nBody', files: [{ path: 'a.ts', lines: { add: 3, del: 1 } }, { path: 'b.png' }],
  })
  expect(parseCommitDetail('fatal: bad revision')).toBeNull()
  expect(parseHashes('abc1234\r\nnot a hash\n\ndef5678\n')).toEqual(['abc1234', 'def5678'])
  expect(clipPatch('a\nb\n', 5)).toBe('a\nb')
  expect(clipPatch('1\n2\n3\n4', 2)).toBe('1\n2\n…（後面還有 2 行沒有附上）')
  expect(clipPatch('abcdef', 5, 3)).toBe('abc\n…（內容太長，後面的部分沒有附上）')
})

test('ages stay short for the graph column', () => {
  const now = Date.parse('2030-01-05T12:00:00Z')
  expect([0, 5, 90, 60 * 30, 60 * 24 * 40, 60 * 24 * 800].map(m => shortAgo(now - m * 60_000, now))).toEqual(['剛剛', '5 分', '1 時', '1 天', '1 月', '2 年'])
})
