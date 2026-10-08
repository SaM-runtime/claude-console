import { expect, test } from 'claude-code/testing'
import { agoText, commitLine, gitBadge, gitLine, gitLogArgs, gitNumstatArgs, gitProbeMode, parseGitLog, parseGitStatus, parseNumstat, parsePrView, prLine, prTransitions } from '../hooks/git'
import { selectionContext } from '../hooks/logic'
import type { GitInfo, PrInfo } from '../types'

const clean: GitInfo = { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0 }
const pr = (checks: Partial<PrInfo['checks']>, extra: Partial<PrInfo> = {}): PrInfo =>
  ({ number: 5, title: 'Fix', state: 'OPEN', draft: false, url: 'https://example.test/pr/5', checks: { pass: 0, fail: 0, pending: 0, failing: [], ...checks }, ...extra })

test('porcelain v2 status: branch, upstream, ahead/behind, changes, conflicts; anything else is not a repository', () => {
  expect(parseGitStatus('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -3\n2 R. N... 100644 100644 100644 a b R100 new\told\nu UU N... 1 2 3 4 a b c x\n? t\n? u\n'))
    .toEqual({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 3, changed: 1, untracked: 2, conflicts: 1, head: 'abc' })
  expect(parseGitStatus('# branch.oid 0123456789abcdef\n# branch.head (detached)\n')).toEqual({ branch: '', detached: true, oid: '0123456', head: '0123456789abcdef', ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0 })
  expect(parseGitStatus('# branch.oid (initial)\n# branch.head main\n')).toEqual({ branch: 'main', ahead: 0, behind: 0, changed: 0, untracked: 0, conflicts: 0 })
  expect(parseGitStatus('')).toBe(null)
  expect(parseGitStatus('[]')).toBe(null)
  expect(parseGitStatus('fatal: not a git repository')).toBe(null)
})

test('gh pr view: check runs and status contexts are counted, failures named, odd output is no PR', () => {
  const view = parsePrView(JSON.stringify({ number: 9, title: 'T', state: 'OPEN', isDraft: true, url: 'u', reviewDecision: 'APPROVED', statusCheckRollup: [
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    { __typename: 'CheckRun', name: 'e2e', status: 'QUEUED', conclusion: '' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
    { __typename: 'StatusContext', context: 'ci/wait', state: 'PENDING' },
  ] }))
  expect(view).toEqual({ number: 9, title: 'T', state: 'OPEN', draft: true, url: 'u', review: 'APPROVED', checks: { pass: 2, fail: 2, pending: 2, failing: ['test', 'ci/legacy'] } })
  expect(parsePrView('[]')).toBe(null)
  expect(parsePrView('no pull requests found for branch "x"')).toBe(null)
  expect(parsePrView('{"number":"1"}')).toBe(null)
  expect(parsePrView('{"number":3,"state":"MERGED"}')?.state).toBe('MERGED')
})

test('the Git cell shows the most pressing item first and fits a narrow column', () => {
  expect(gitBadge(undefined, undefined)).toEqual({ text: '', tone: 'dim' })
  expect(gitBadge(clean, undefined)).toEqual({ text: '✓', tone: 'green' })
  expect(gitBadge({ ...clean, conflicts: 2, changed: 4 }, pr({ fail: 1 }))).toEqual({ text: '✕衝突2', tone: 'red' })
  expect(gitBadge({ ...clean, changed: 4 }, pr({ fail: 1 }))).toEqual({ text: 'CI✕1', tone: 'red' })
  expect(gitBadge({ ...clean, changed: 2, untracked: 1, ahead: 4 }, undefined)).toEqual({ text: '●3↑4', tone: 'amber' })
  expect(gitBadge({ ...clean, ahead: 1, behind: 2 }, undefined)).toEqual({ text: '↑1↓2', tone: 'blue' })
  expect(gitBadge(clean, pr({ pending: 2 }))).toEqual({ text: 'CI…', tone: 'teal' })
  // A merged PR's old failures no longer count.
  expect(gitBadge(clean, pr({ fail: 1 }, { state: 'MERGED' }))).toEqual({ text: '✓', tone: 'green' })
})

test('readable lines for cards and prompt context', () => {
  expect(gitLine(clean)).toBe('main → origin/main　乾淨')
  expect(gitLine({ ...clean, upstream: undefined, changed: 1 })).toBe('main（無上游）　1 個檔案未提交')
  expect(gitLine({ ...clean, branch: '', detached: true, oid: 'abc1234', upstream: undefined })).toBe('分離 HEAD abc1234（無上游）　乾淨')
  expect(prLine(pr({ pass: 3 }, { review: 'CHANGES_REQUESTED' }))).toBe('#5 Fix（開啟）　CI ✓ 3 通過　要求修改')
  expect(prLine(pr({ fail: 4, failing: ['a', 'b', 'c', 'd'] }, { draft: true }))).toBe('#5 Fix（草稿）　CI ✕ 4 失敗：a、b、c…')
  expect(prLine(pr({ fail: 1 }, { state: 'MERGED' }))).toBe('#5 Fix（已合併）')
  const ctx = selectionContext({ at: 0, projects: [{ name: 'K', statusPath: 'D:/K/.console/STATUS.md', hasCard: true, state: '', ask: '', next: '', verify: '', updated: '', isStale: false, jobs: [], git: { ...clean, changed: 2 }, pr: pr({ fail: 1, failing: ['lint'] }) }], blocked: [], codex: '', contextPercent: null, error: null }, 'K')!
  expect(ctx.includes('Git：main → origin/main　2 個檔案未提交')).toBe(true)
  expect(ctx.includes('PR：#5 Fix（開啟）　CI ✕ 1 失敗：lint https://example.test/pr/5')).toBe(true)
})

test('CI transitions: a new failure toasts, a recovery and a merge are feed lines, another PR is not compared', () => {
  expect(prTransitions('A', pr({ pending: 1 }), pr({ fail: 1, failing: ['x'] }))).toEqual([{ text: 'A　PR #5 CI 失敗：x', tone: 'red', toast: true }])
  expect(prTransitions('A', pr({ fail: 1 }), pr({ fail: 2 }))).toEqual([])
  expect(prTransitions('A', pr({ fail: 1 }), pr({ pass: 2 }))).toEqual([{ text: 'A　PR #5 CI 全部通過', tone: 'green', toast: false }])
  expect(prTransitions('A', pr({ pass: 2 }), pr({ pass: 2 }, { state: 'MERGED' }))).toEqual([{ text: 'A　PR #5 已合併', tone: 'green', toast: false }])
  expect(prTransitions('A', pr({ pass: 1 }), pr({ fail: 1 }, { number: 6 }))).toEqual([])
  expect(prTransitions('A', undefined, pr({ fail: 1 }))).toEqual([])
})

test('gitProbe option: on by default, git or off on request', () => {
  expect(gitProbeMode(undefined)).toBe('on')
  expect(gitProbeMode(' OFF ')).toBe('off')
  expect(gitProbeMode('git')).toBe('git')
  expect(gitProbeMode('nonsense')).toBe('on')
})

test('what you would type by hand: stash count, recent commits, the size of the uncommitted change', () => {
  expect(parseGitStatus('# branch.oid 0123456789abcdef\n# branch.head main\n# stash 3\n')?.stash).toBe(3)
  expect(parseGitStatus('# branch.oid 0123456789abcdef\n# branch.head main\n# stash 0\n')?.stash).toBeUndefined()
  expect(gitLogArgs('D:/K')).toEqual(['git', '--no-optional-locks', '-C', 'D:/K', 'log', '-5', '--no-color', '--format=%h%x1f%ct%x1f%s'])
  expect(gitNumstatArgs('D:/K')).toEqual(['git', '--no-optional-locks', '-C', 'D:/K', 'diff', '--numstat', '--no-color', 'HEAD'])
  expect(parseGitLog('a1b2c3d\x1f1893844800\x1fFix sync\x1fwith a separator\nnot a commit\n')).toEqual([{ hash: 'a1b2c3d', at: 1893844800000, subject: 'Fix sync\x1fwith a separator' }])
  expect(parseNumstat('10\t2\ta.ts\n-\t-\tlogo.png\n3\t0\tdir/{old => new}.ts\n')).toEqual({ add: 13, del: 2 })
  const now = Date.parse('2030-01-05T12:00:00Z')
  expect(agoText(now - 30_000, now)).toBe('剛剛')
  expect(agoText(now - 5 * 60_000, now)).toBe('5 分鐘前')
  expect(agoText(now - 3 * 3_600_000, now)).toBe('3 小時前')
  expect(agoText(now - 50 * 3_600_000, now)).toBe('2 天前')
  expect(commitLine({ hash: 'a1b2c3d', at: now - 3_600_000, subject: 'Fix sync' }, now)).toBe('a1b2c3d Fix sync（1 小時前）')
  expect(gitLine({ ...clean, changed: 2, lines: { add: 12, del: 3 }, stash: 1 })).toBe('main → origin/main　2 個檔案未提交（+12 −3）　stash 1')
})
