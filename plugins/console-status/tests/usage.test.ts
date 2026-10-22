import { expect, test } from 'claude-code/testing'
import { modelPrice } from '../hooks/cache'
import { dispatchedWork, entryCost, loadUsage, readTranscriptUsage, tokenCount, usageChunk, usageChunkArgs, usageEntry, usageLine, usageReport, usageSum, usageWindows, utf8Length } from '../hooks/usage'
import type { ProjectUsage } from '../types'

const NOW = Date.parse('2030-01-08T12:00:00Z')
const HOUR = 3_600_000
const CLAUDE = 'C:/Users/example/.claude'
const ROOT = 'D:/Project Alpha'
const DIR = `${CLAUDE}/projects/D--Project-Alpha`
const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '33333333-3333-4333-8333-333333333333'
const iso = (at: number) => new Date(at).toISOString()
const round = (v: number | null) => v === null ? null : Math.round(v * 10_000) / 10_000

/** One assistant line, as Claude Code writes one per content block. */
const reply = (id: string, at: number, usage: Record<string, unknown>, model = 'claude-opus-5-5', text = '好') => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'assistant', timestamp: iso(at), requestId: `req_${id}`, uuid: `u-${id}-${text.length}`,
  message: { model, id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }], usage },
})
const said = (at: number, text: string) => JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: text } })
const USAGE = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20_000, output_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } }

test('a response is read once from the lines it is split into, by kind of token; other lines are not responses', () => {
  const [key, entry] = usageEntry(reply('a', NOW, USAGE))!
  expect(key).toBe('msg_a|req_a')
  expect(entry).toEqual({ at: NOW, model: 'claude-opus-5-5', input: 10, write5m: 0, write1h: 1000, read: 20_000, output: 500 })
  // The same response's other block: the same key.
  expect(usageEntry(reply('a', NOW + 5, USAGE, 'claude-opus-5-5', '第二段'))![0]).toBe(key)
  // No TTL split recorded: every write counts as a 5-minute one.
  expect(usageEntry(reply('b', NOW, { input_tokens: 1, cache_creation_input_tokens: 300, output_tokens: 2 }))![1]).toMatchObject({ write5m: 300, write1h: 0 })
  // A user's words that mention "output_tokens", a synthetic response with no usage, a cut line: none of them.
  expect(usageEntry(said(NOW, '把 "output_tokens" 加起來'))).toBe(null)
  expect(usageEntry(reply('c', NOW, { input_tokens: 0, output_tokens: 0 }, '<synthetic>'))).toBe(null)
  expect(usageEntry(reply('d', NOW, USAGE).slice(0, -5))).toBe(null)
  expect(usageEntry(JSON.stringify({ type: 'assistant', message: { usage: USAGE } }))).toBe(null)
})

test('list prices: cache reads, Haiku 5.5 past 100K, older Opus; a response costs its writes, reads and output', () => {
  expect(modelPrice('claude-opus-5-5')).toEqual({ input: 4, read: 0.2 })
  expect(modelPrice('claude-fable-5-1')).toEqual({ input: 10, read: 0.25 })
  expect(modelPrice('claude-opus-4-8')).toEqual({ input: 5, read: 0.5 })
  expect(modelPrice('claude-opus-4-1-20250805')).toEqual({ input: 15, read: 1.5 })
  expect(modelPrice('claude-sonnet-5-5')).toEqual({ input: 2, read: 0.2 })
  expect(modelPrice('claude-haiku-5-5')).toEqual({ input: 0.1, read: 0.01 })
  expect(modelPrice('claude-haiku-5-5', 150_000)).toEqual({ input: 0.5, read: 0.05 })
  expect(modelPrice('claude-3-haiku-20240307')).toEqual({ input: 0.25, read: 0.03 })
  expect(modelPrice('gateway-model')).toBe(null)
  // Opus 5.5: 10 × $4 + 1000 × $8 (one-hour write) + 20,000 × $0.20 + 500 × $20, per million.
  const [, entry] = usageEntry(reply('a', NOW, USAGE))!
  expect(round(entryCost(entry))).toBe(round((10 * 4 + 1000 * 8 + 20_000 * 0.2 + 500 * 20) / 1e6))
  expect(entryCost({ ...entry, model: 'gateway-model' })).toBe(null)
  const sum = usageSum([entry, { ...entry, at: NOW - 10 * HOUR }, { ...entry, model: 'gateway-model', at: NOW + 1 }], NOW)
  expect(sum).toEqual({ tokens: 2 * 21_510, cost: null, unknown: ['gateway-model'] })
  expect(usageSum([entry], NOW - HOUR).cost).toBe(entryCost(entry))
})

test('the windows: the weekly and 5-hour windows Claude Code reported, else the last 7 days and 5 hours', () => {
  const limits = [
    { kind: 'seven_day_fable', resetsAt: iso(NOW + 24 * HOUR) },
    { kind: 'seven_day', resetsAt: iso(NOW + 48 * HOUR) },
    { kind: 'five_hour', resetsAt: iso(NOW + 2 * HOUR) },
  ]
  expect(usageWindows(limits, NOW)).toEqual({ week: { start: NOW + 48 * HOUR - 168 * HOUR, label: '本週' }, five: { start: NOW - 3 * HOUR, label: '5 小時內' } })
  // Past its reset, or with none: the last 7 days.
  expect(usageWindows([{ kind: 'seven_day', resetsAt: iso(NOW - HOUR) }], NOW)).toEqual({ week: { start: NOW - 168 * HOUR, label: '近 7 天' }, five: { start: NOW - 5 * HOUR, label: '5 小時內' } })
  expect(usageWindows(undefined, NOW).week.label).toBe('近 7 天')
})

test('what the console dispatched for a root: its sessions once each, and when its kept jobs started', () => {
  const job = (at: number, extra: Record<string, unknown> = {}) => ({ id: `j${at}`, root: ROOT, prompt: 'p', startedAt: iso(at), status: 'completed', phase: 'idle', ...extra })
  const state = { version: 1, roots: {
    'd:/project alpha': { root: ROOT, sessionId: S1, jobs: [job(NOW - HOUR, { sessionId: S1.toUpperCase() }), job(NOW, { sessionId: S2, unmanagedSessionId: S3 }), job(NOW, { sessionId: '../escape' })] },
    '/Users/me/My App': { root: '/Users/me/My App', jobs: [job(NOW, { sessionId: S2 })] },
  } }
  expect(dispatchedWork(state, 'D:\\Project Alpha\\')).toEqual({ sessions: [S1, S2, S3], starts: [NOW - HOUR, NOW, NOW], full: false })
  // A POSIX root keeps its case, as the executor keys it.
  expect(dispatchedWork(state, '/Users/me/My App').sessions).toEqual([S2])
  expect(dispatchedWork(state, '/users/me/my app').sessions).toEqual([])
  expect(dispatchedWork(null, ROOT)).toEqual({ sessions: [], starts: [], full: false })
  const twenty = { version: 1, roots: { 'd:/project alpha': { root: ROOT, jobs: Array.from({ length: 20 }, (_, i) => job(NOW - i * HOUR)) } } }
  expect(dispatchedWork(twenty, ROOT).full).toBe(true)
})

test('token counts in 萬 and 億, and the card row in its cases', () => {
  expect([0, 9_800, 32_000, 1_800_000, 99_999_999, 140_000_000, 2_500_000_000].map(tokenCount)).toEqual(['0', '9,800', '3.2 萬', '180 萬', '1 億', '1.4 億', '25 億'])
  const u = (over: Partial<ProjectUsage> = {}): ProjectUsage => ({ at: NOW, label: '本週', start: NOW - 48 * HOUR, week: { tokens: 1_800_000, cost: 4.2 }, five: { tokens: 600_000, cost: 1 }, jobs: 4, codex: 0, ...over })
  expect(usageLine(u())).toBe('本週 4 次工作・180 萬 tokens・約 $4.20（API 牌價）・5 小時內 60 萬')
  expect(usageLine(u({ five: { tokens: 0, cost: 0 }, jobs: 20, atLeast: true }))).toBe('本週 至少 20 次工作・180 萬 tokens・約 $4.20（API 牌價）')
  expect(usageLine(u({ codex: 2 }))).toBe('本週 6 次工作（Codex 2 次不計 token）・180 萬 tokens・約 $4.20（API 牌價）・5 小時內 60 萬')
  expect(usageLine(u({ week: { tokens: 1_800_000, cost: null, unknown: ['gateway-model'] }, five: { tokens: 0, cost: 0 } }))).toBe('本週 4 次工作・180 萬 tokens・gateway-model 沒有牌價，不估金額')
  expect(usageLine(u({ jobs: 0, five: { tokens: 0, cost: 0 } }))).toBe('本週 180 萬 tokens・約 $4.20（API 牌價）')
  expect(usageLine(u({ jobs: 0, codex: 2, week: { tokens: 0, cost: 0 }, five: { tokens: 0, cost: 0 } }))).toBe('本週 2 次工作（Codex 不提供 token 數）')
  expect(usageLine(u({ week: { tokens: 0, cost: 0 }, five: { tokens: 0, cost: 0 } }))).toBe('本週 4 次工作・還沒有用量紀錄')
  expect(usageLine(u({ label: '近 7 天', jobs: 0, week: { tokens: 0, cost: 0 }, five: { tokens: 0, cost: 0 } }))).toBe('近 7 天沒有派工')
})

test('/console usage: the most first with its share, then work with no record, the total, the idle and the unreadable', () => {
  const start = new Date(2030, 0, 6, 21, 0).getTime()
  const u = (tokens: number, cost: number | null, over: Partial<ProjectUsage> = {}): ProjectUsage => ({ at: NOW, label: '本週', start, week: { tokens, cost, ...(cost === null ? { unknown: ['gateway-model'] } : {}) }, five: { tokens: 0, cost: 0 }, jobs: 2, codex: 0, ...over })
  const report = usageReport([
    { name: 'web', usage: u(1_200_000, 1) },
    { name: 'api', usage: u(1_800_000, 3, { five: { tokens: 600_000, cost: 1 } }) },
    { name: 'docs', usage: u(0, 0, { jobs: 0, codex: 2 }) },
    { name: 'blog', usage: u(0, 0, { jobs: 0 }) },
    { name: 'notes', usage: null, error: '讀取對話紀錄失敗（結束碼 1）' },
  ]).split('\n')
  expect(report).toEqual([
    '各專案用量・本週（從 1/6 (日) 21:00 額度重置算起）',
    '金額照 API 牌價估，訂閱方案不會另外收這筆錢；只算主控台派出去的工作，主控台自己的對話看用量表的「花費」。',
    'api　180 萬 tokens・約 $3.00（75%）・2 次工作・5 小時內 60 萬',
    'web　120 萬 tokens・約 $1.00（25%）・2 次工作',
    'docs　2 次工作（Codex 不提供 token 數）',
    '合計　300 萬 tokens・約 $4.00',
    '沒有派工：blog',
    'notes：讀不到（讀取對話紀錄失敗（結束碼 1））',
  ])
  // A model with no list price: shares by tokens, and no total cost.
  const unpriced = usageReport([{ name: 'api', usage: u(1_800_000, 3) }, { name: 'web', usage: u(1_200_000, null) }]).split('\n')
  expect(unpriced.slice(2)).toEqual([
    'api　180 萬 tokens（60%）・約 $3.00・2 次工作',
    'web　120 萬 tokens（40%）・gateway-model 沒有牌價，不估金額・2 次工作',
    '合計　300 萬 tokens',
  ])
  expect(usageReport([{ name: 'api', usage: u(1000, 0.01, { label: '近 7 天' }) }]).split('\n')[0]).toBe('各專案用量・近 7 天')
  expect(usageReport([])).toBe('還沒有專案資料；先 /console refresh。')
})

/** Files as bytes, a process read done as the commands do it, and a log of what ran. */
function disk(files: Record<string, string>, dirs: Record<string, { name: string; kind: string }[]> = {}, mtimes: Record<string, number> = {}) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const runs: { path: string; from: number; bytes: number }[] = []
  const reads: string[] = []
  const chunk = (path: string, from: number, bytes: number, cap: number) => {
    const part = encoder.encode(files[path]).slice(from, from + bytes)
    let start = 0
    let out = 0
    const lines: string[] = []
    while (start < part.length) {
      const end = part.indexOf(10, start)
      if (end < 0) break
      const line = decoder.decode(part.slice(start, end))
      if (line.includes('"output_tokens"')) {
        if (out + end - start + 1 > cap) { if (out > 0) break }
        else { lines.push(line + '\n'); out += end - start + 1 }
      }
      start = end + 1
    }
    return `${lines.join('')}#consumed ${start}\n`
  }
  return {
    runs, reads, files, mtimes,
    io: {
      windows: false,
      read: async (path: string) => { reads.push(path); if (!(path in files)) throw new Error('ENOENT'); return files[path]! },
      exists: async (path: string) => path in files,
      stat: async (path: string) => { if (!(path in files)) throw new Error('ENOENT'); return { size: encoder.encode(files[path]).length, mtimeMs: mtimes[path] ?? NOW } },
      list: async (path: string) => dirs[path] ?? [],
      run: async (argv: string[]) => {
        // POSIX form: sh -c <script> sh <path> <from + 1> <bytes> <cap> <awk>
        const [path, from, bytes, cap] = [argv[4]!, Number(argv[5]) - 1, Number(argv[6]), Number(argv[7])]
        runs.push({ path, from, bytes })
        return { exitCode: 0, stdout: chunk(path, from, bytes, cap) }
      },
    },
  }
}

test('the process read: sh with awk off Windows, PowerShell on it; its output names how far it got', () => {
  const posix = usageChunkArgs('/home/me/.claude/projects/x/a b.jsonl', false, 100, 5000, 2000)
  expect(posix.slice(0, 2)).toEqual(['sh', '-c'])
  expect(posix.slice(3, 8)).toEqual(['sh', '/home/me/.claude/projects/x/a b.jsonl', '101', '5000', '2000'])
  expect(posix[8]).toContain('index(line, "\\"output_tokens\\"")')
  const windows = usageChunkArgs("C:/Users/O'Neil/.claude/projects/x/a.jsonl", true, 100, 5000, 2000)
  expect(windows.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(windows[4]).toContain("[IO.File]::Open('C:/Users/O''Neil/.claude/projects/x/a.jsonl','Open','Read','ReadWrite')")
  expect(windows[4]).toContain('[void]$f.Seek(100,')
  expect(windows[4]).toContain('if ($w+$l -gt 2000)')
  // No double quote: nothing for the command line to escape.
  expect(windows[4]).not.toContain('"')
  expect(usageChunk('a\nb\n#consumed 42\n')).toEqual({ lines: ['a', 'b'], consumed: 42 })
  expect(usageChunk('#consumed 0')).toEqual({ lines: [], consumed: 0 })
  expect(usageChunk('a\nb')).toBe(null)
  expect(utf8Length('aé中😀')).toBe(1 + 2 + 3 + 4)
})

test('a transcript is read whole up to the limit, then a span at a time past it, only past where the last read stopped', async () => {
  const path = `${DIR}/${S1}.jsonl`
  // Chinese, so bytes and characters differ; long user lines between the responses.
  const block = (i: number) => [said(NOW - HOUR + i, `第 ${i} 輪：${'許功蓋'.repeat(40)}`), reply(`r${i}`, NOW - HOUR + i, USAGE, 'claude-opus-5-5', `回覆 ${i} ✓`), reply(`r${i}`, NOW - HOUR + i, USAGE, 'claude-opus-5-5', '第二段')].join('\n') + '\n'
  const d = disk({ [path]: Array.from({ length: 6 }, (_, i) => block(i)).join('') })
  const cache = new Map()
  const opts = { limit: 2000, span: 1500, cap: 900 }
  const first = await readTranscriptUsage(d.io as any, path, cache, NOW - 7 * 24 * HOUR, opts)
  expect([...first.entries.keys()]).toEqual(Array.from({ length: 6 }, (_, i) => `msg_r${i}|req_r${i}`))
  expect(first.bytes).toBe(utf8Length(d.files[path]!))
  expect(d.reads).toEqual([])
  expect(d.runs.length).toBeGreaterThan(2)
  // Every span starts where the one before stopped, on a line's start.
  for (let i = 1; i < d.runs.length; i++) expect(d.runs[i]!.from).toBeGreaterThan(d.runs[i - 1]!.from)

  // Unchanged: nothing runs.
  const before = d.runs.length
  expect(await readTranscriptUsage(d.io as any, path, cache, NOW - 7 * 24 * HOUR, opts)).toBe(first)
  expect(d.runs.length).toBe(before)

  // Appended, with its last line still being written: only the new part is read, and the cut line waits.
  const done = utf8Length(d.files[path]!)
  const next = reply('r7', NOW, USAGE)
  d.files[path] += block(6) + next.slice(0, 40)
  const grown = await readTranscriptUsage(d.io as any, path, cache, NOW - 7 * 24 * HOUR, opts)
  expect(d.runs[before]!.from).toBe(done)
  expect(grown.entries.size).toBe(7)
  expect(grown.bytes).toBe(utf8Length(d.files[path]!) - 40)
  d.files[path] += next.slice(40) + '\n'
  expect((await readTranscriptUsage(d.io as any, path, cache, NOW - 7 * 24 * HOUR, opts)).entries.size).toBe(8)

  // Rewritten shorter: read again from the start.
  d.files[path] = block(9)
  const again = await readTranscriptUsage(d.io as any, path, cache, NOW - 7 * 24 * HOUR, { limit: 10 })
  expect([...again.entries.keys()]).toEqual(['msg_r9|req_r9'])
})

test('past a span-long line the read steps on; a usage line alone past the output cap is passed over; old responses drop', async () => {
  const path = `${DIR}/${S1}.jsonl`
  const giant = said(NOW - 2 * HOUR, 'x'.repeat(3000))
  const d = disk({ [path]: [reply('a', NOW - 2 * HOUR, USAGE), giant, reply('b', NOW - HOUR, USAGE, 'claude-opus-5-5', 'y'.repeat(1200)), reply('old', NOW - 9 * 24 * HOUR, USAGE), reply('c', NOW, USAGE)].join('\n') + '\n' })
  const read = await readTranscriptUsage(d.io as any, path, new Map(), NOW - 7 * 24 * HOUR, { limit: 100, span: 2000, cap: 1000 })
  // The user's line is longer than a span, b alone longer than the cap; the 9-day-old response is dropped.
  expect(d.runs.some(r => r.bytes === 2000)).toBe(true)
  expect([...read.entries.keys()]).toEqual(['msg_a|req_a', 'msg_c|req_c'])
  expect(read.bytes).toBe(utf8Length(d.files[path]!))
})

test('a project: each session found, subagents counted, a resumed copy counted once, last week\'s files not read', async () => {
  const sessions = `${CLAUDE}/handoffs/claude-sessions.json`
  const state = { version: 1, roots: { 'd:/project alpha': { root: ROOT, sessionId: S1, jobs: [
    { id: 'a', root: ROOT, prompt: 'p', startedAt: iso(NOW - 3 * HOUR), status: 'completed', phase: 'idle', sessionId: S1 },
    { id: 'b', root: ROOT, prompt: 'p', startedAt: iso(NOW - 9 * 24 * HOUR), status: 'completed', phase: 'idle', sessionId: S3 },
    { id: 'c', root: ROOT, prompt: 'p', startedAt: iso(NOW - HOUR), status: 'running', phase: 'working', sessionId: S2 },
  ] } } }
  const elsewhere = `${CLAUDE}/projects/d--project-alpha`
  const d = disk({
    [sessions]: JSON.stringify(state),
    [`${DIR}/${S1}.jsonl`]: [reply('a', NOW - 3 * HOUR, USAGE), reply('b', NOW - 30 * 60_000, USAGE)].join('\n') + '\n',
    [`${DIR}/${S1}/subagents/agent-1.jsonl`]: reply('sub', NOW - 2 * HOUR, USAGE, 'claude-haiku-5-5') + '\n',
    // S2 resumed S1 under another folder spelling: its copy of S1's responses counts once.
    [`${elsewhere}/${S2}.jsonl`]: [reply('a', NOW - 3 * HOUR, USAGE), reply('d', NOW - 10 * 60_000, USAGE)].join('\n') + '\n',
    [`${DIR}/${S3}.jsonl`]: reply('e', NOW - 9 * 24 * HOUR, USAGE) + '\n',
  }, {
    [`${DIR}/${S1}/subagents`]: [{ name: 'agent-1.jsonl', kind: 'file' }, { name: 'notes.txt', kind: 'file' }],
    [`${CLAUDE}/projects`]: [{ name: 'D--Project-Alpha', kind: 'dir' }, { name: 'd--project-alpha', kind: 'dir' }],
  }, { [`${DIR}/${S3}.jsonl`]: NOW - 9 * 24 * HOUR })
  const windows = usageWindows([{ kind: 'seven_day', resetsAt: iso(NOW + 24 * HOUR) }, { kind: 'five_hour', resetsAt: iso(NOW + 4 * HOUR) }], NOW)
  const codex = [{ startedAt: iso(NOW - 2 * HOUR) }, { createdAt: iso(NOW - 8 * 24 * HOUR) }]
  const usage = await loadUsage(d.io as any, { root: ROOT, claudeDir: CLAUDE, sessions: state, codex }, new Map(), new Map(), windows, NOW, { limit: 100, span: 4000, cap: 4000 })
  const each = 21_510
  const opus = (10 * 4 + 1000 * 8 + 20_000 * 0.2 + 500 * 20) / 1e6
  const haiku = (10 * 0.1 + 1000 * 0.2 + 20_000 * 0.01 + 500 * 0.5) / 1e6
  expect({ ...usage, week: { ...usage.week, cost: round(usage.week.cost) }, five: { ...usage.five, cost: round(usage.five.cost) } }).toEqual({
    at: NOW, label: '本週', start: NOW + 24 * HOUR - 168 * HOUR,
    week: { tokens: 4 * each, cost: round(3 * opus + haiku) },
    five: { tokens: 2 * each, cost: round(2 * opus) },
    jobs: 2, codex: 1,
  })
  // The file last written nine days ago was not read.
  expect(d.runs.some(r => r.path.endsWith(`${S3}.jsonl`))).toBe(false)
})
