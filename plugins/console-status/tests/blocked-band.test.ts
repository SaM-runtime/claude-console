import { expect, test } from 'claude-code/testing'
import { blockedLines, relevantBlocked, BLOCKED_MAX } from '../hooks/logic'

const HOME = 'C:/Users/jack_wang'
const CONSOLE = 'D:\\SAM-runtime\\claude-console'
const INVOICE = 'D:\\invoice-extractor'
const PROJECTS = [{ root: 'D:/SAM-runtime/claude-console', name: 'claude-console' }, { root: 'D:/invoice-extractor', name: 'invoice-extractor' }]

/** `claude agents --json --all` on 2026-10-07 23:35: 5 retired (no pid, no status) and 4 that stopped on a question. */
const TONIGHT = [
  { name: 'console-muxx95ds-0', kind: 'background', state: 'blocked', cwd: CONSOLE, startedAt: 1791366318505 },
  { name: 'console-muy3rgcm-3', kind: 'background', state: 'blocked', cwd: INVOICE, startedAt: 1791377250237 },
  { name: 'console-muy4gylr-5', kind: 'background', state: 'blocked', cwd: INVOICE, startedAt: 1791378440299 },
  { name: 'console-muy5vbha-6', kind: 'background', state: 'blocked', cwd: CONSOLE, startedAt: 1791380789794 },
  { name: 'console-muy683ea-7', kind: 'background', state: 'blocked', cwd: CONSOLE, startedAt: 1791381385836 },
  { name: 'console-muy7em5t-b', kind: 'background', status: 'idle', state: 'blocked', pid: 26688, cwd: CONSOLE, startedAt: 1791383370534 },
  { name: 'console-muy6sinz-9', kind: 'background', status: 'idle', state: 'blocked', pid: 11236, cwd: CONSOLE, startedAt: 1791383373305 },
  { name: 'console-muy4gugj-4', kind: 'background', status: 'idle', state: 'blocked', pid: 40944, cwd: CONSOLE, startedAt: 1791383373352 },
  { name: 'console-muy7pbqa-c', kind: 'background', status: 'idle', state: 'blocked', pid: 51252, cwd: `${CONSOLE}\\.claude\\worktrees\\fix+executor-tracking-fixes`, startedAt: 1791383870289 },
]

test('tonight\'s 9 entries become one line: the newest session of claude-console, stopped on a question', () => {
  const blocked = relevantBlocked(TONIGHT as any, 'console-self', PROJECTS, HOME)
  const lines = blockedLines(blocked)
  expect(lines.length).toBeLessThanOrEqual(3)
  expect(lines).toEqual(['console-muy7pbqa-c（claude-console）：停在提問'])
  expect(lines.some(line => line.includes('等待批准'))).toBe(false)
})

test('a retired background agent (no pid, no status) is never listed; one without kind is not taken for retired', () => {
  const b = relevantBlocked([
    { name: 'retired', kind: 'background', state: 'blocked', cwd: CONSOLE, startedAt: 1 },
    { name: 'retired-idle', kind: 'background', state: 'idle', cwd: INVOICE, startedAt: 2 },
  ] as any, null, PROJECTS, HOME)
  expect(b).toEqual([])
  const legacy = relevantBlocked([{ name: 'older-cli', state: 'blocked', cwd: CONSOLE }] as any, null, PROJECTS, HOME)
  expect(legacy.map(x => x.why)).toEqual(['等待輸入'])
})

test('the wording follows the session: waiting = 等待批准, idle + blocked = 停在提問, any other blocked = 等待輸入', () => {
  const b = relevantBlocked([
    { name: 'perm', kind: 'background', status: 'waiting', pid: 1, cwd: CONSOLE, startedAt: 3 },
    { name: 'asked', kind: 'background', status: 'idle', state: 'blocked', pid: 2, cwd: INVOICE, startedAt: 2 },
    { name: 'other', status: 'busy', state: 'blocked', pid: 3, cwd: HOME, startedAt: 1 },
  ] as any, null, PROJECTS, HOME)
  expect(b.map(x => [x.name, x.project, x.why])).toEqual([
    ['perm', 'claude-console', '等待批准'],
    ['asked', 'invoice-extractor', '停在提問'],
    ['other', '主控台', '等待輸入'],
  ])
})

test('one line per project: among sessions with the same wording, the newest, whatever order the listing came in', () => {
  const b = relevantBlocked([
    { name: 'a-old', kind: 'background', status: 'idle', state: 'blocked', pid: 1, cwd: CONSOLE, startedAt: '2026-10-07T10:00:00Z' },
    { name: 'a-new', kind: 'background', status: 'idle', state: 'blocked', pid: 2, cwd: `${CONSOLE}\\sub`, startedAt: '2026-10-07T12:00:00Z' },
    { name: 'a-mid', kind: 'background', status: 'idle', state: 'blocked', pid: 3, cwd: CONSOLE, startedAt: '2026-10-07T11:00:00Z' },
  ] as any, null, PROJECTS, HOME)
  expect(b.map(x => x.name)).toEqual(['a-new'])
})

test('a permission prompt is not hidden behind a newer question: 等待批准 > 停在提問 > 等待輸入, then the newest', () => {
  const b = relevantBlocked([
    { name: 'perm-old', kind: 'background', status: 'waiting', pid: 1, cwd: CONSOLE, startedAt: '2026-10-07T10:00:00Z' },
    { name: 'asked-new', kind: 'background', status: 'idle', state: 'blocked', pid: 2, cwd: CONSOLE, startedAt: '2026-10-07T12:00:00Z' },
    { name: 'input-newest', kind: 'background', status: 'busy', state: 'blocked', pid: 3, cwd: INVOICE, startedAt: '2026-10-07T13:00:00Z' },
    { name: 'asked-invoice', kind: 'background', status: 'idle', state: 'blocked', pid: 4, cwd: INVOICE, startedAt: '2026-10-07T09:00:00Z' },
  ] as any, null, PROJECTS, HOME)
  expect(b.map(x => [x.name, x.why])).toEqual([['perm-old', '等待批准'], ['asked-invoice', '停在提問']])
})

test('at most BLOCKED_MAX lines, the rest summed up as …另 N 條', () => {
  expect(BLOCKED_MAX).toBe(3)
  const five = ['p1', 'p2', 'p3', 'p4', 'p5'].map(name => ({ name: `s-${name}`, project: name, why: '停在提問' }))
  expect(blockedLines(five)).toEqual(['s-p1（p1）：停在提問', 's-p2（p2）：停在提問', 's-p3（p3）：停在提問', '…另 2 條'])
  expect(blockedLines(five.slice(0, 3))).toEqual(['s-p1（p1）：停在提問', 's-p2（p2）：停在提問', 's-p3（p3）：停在提問'])
  // A session without a project keeps the old line.
  expect(blockedLines([{ name: 'x', why: '等待輸入' }])).toEqual(['x：等待輸入'])
  expect(blockedLines([])).toEqual([])
})
