import { expect, test } from 'claude-code/testing'
import { DIGEST_NONE, TAIL_CHARS, digestContext, digestLines, latestJob, loadDigest, parseTranscript, pickSession, tailWindow } from '../hooks/digest'

const NOW = Date.parse('2030-01-05T12:00:00Z')
const CLAUDE = 'C:/Users/example/.claude'
const SESSIONS = `${CLAUDE}/handoffs/claude-sessions.json`
const ROOT = 'D:/Project Alpha'
const line = (value: unknown) => JSON.stringify(value)
const tool = (at: string, name: string, input: Record<string, unknown>) => line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', name, input }] } })
const say = (at: string, text: string) => line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } })
const TRANSCRIPT = [
  line({ type: 'user', timestamp: '2030-01-05T11:00:00Z', message: { content: 'go' } }),
  tool('2030-01-05T11:10:00Z', 'Read', { file_path: 'D:/Project Alpha/a.ts' }),
  tool('2030-01-05T11:20:00Z', 'Bash', { command: 'npm test -- --watch=false' }),
  tool('2030-01-05T11:30:00Z', 'Edit', { file_path: 'D:/Project Alpha/b.ts' }),
  tool('2030-01-05T11:40:00Z', 'Bash', { command: `echo ${'x'.repeat(200)}` }),
  say('2030-01-05T11:50:00Z', '測試全過。\n\nCARD 已更新，關卡留無。'),
  line({ type: 'user', timestamp: '2030-01-05T11:51:00Z', message: { content: [{ type: 'tool_result' }] } }),
].join('\n')

test('(a) the daemon record names the session and transcript before the plugin\'s own record does', () => {
  const job = { id: 'console-a:abcd1234', nativeId: 'abcd1234', sessionId: 'plugin-session' }
  expect(pickSession(job, { sessionId: 'daemon-session', linkScanPath: 'C:\\t\\daemon-session.jsonl' }, 'root-session'))
    .toEqual({ sessionId: 'daemon-session', transcript: 'C:\\t\\daemon-session.jsonl' })
  expect(pickSession(job, null, 'root-session')).toEqual({ sessionId: 'plugin-session' })
  expect(pickSession({ id: 'x' }, null, 'root-session')).toEqual({ sessionId: 'root-session' })
  expect(pickSession(null, null, undefined)).toEqual({ sessionId: null })
  const state = { version: 1, roots: { 'd:/project alpha': { root: ROOT, sessionId: 'root-session', jobs: [{ id: 'old' }, { id: 'new', launchName: 'console-new' }] } } }
  expect(latestJob(state, 'D:\\Project Alpha\\')).toEqual({ job: { id: 'new', launchName: 'console-new' }, rootSessionId: 'root-session' })
  expect(latestJob(state, 'D:/Other')).toEqual({ job: null })
})

test('(b) a long transcript is read from its last TAIL_CHARS, starting at the first whole line', () => {
  const filler = Array.from({ length: 3000 }, (_, i) => line({ type: 'user', timestamp: '2030-01-05T10:00:00Z', message: { content: `filler ${i} ${'y'.repeat(30)}` } })).join('\n')
  const text = `${filler}\n${TRANSCRIPT}`
  expect(text.length).toBeGreaterThan(TAIL_CHARS)
  const tail = tailWindow(text)
  expect(tail.length).toBeLessThanOrEqual(TAIL_CHARS)
  // Every kept line parses: the cut line is dropped, not half-read.
  for (const row of tail.split('\n')) expect(() => JSON.parse(row)).not.toThrow()
  expect(text.endsWith(tail)).toBe(true)
  // A short text is kept whole.
  expect(tailWindow(TRANSCRIPT)).toBe(TRANSCRIPT)
  expect(parseTranscript(tail).lastAt).toBe('2030-01-05T11:51:00Z')
})

test('(d) the digest is always four lines: executor, last activity, last three actions, last words', () => {
  const parsed = parseTranscript(TRANSCRIPT)
  const lines = digestLines({ id: 'console-a:abcd1234', launchName: 'console-a', kind: 'continue', status: 'completed', phase: 'idle' }, { state: 'idle' }, parsed, NOW)
  expect(lines).toEqual([
    '執行者：console-a · continue · completed/idle',
    '最後活動：2030-01-05T11:51:00Z （9 分鐘前）',
    `最後動作：Bash: npm test -- --watch=false → Edit: D:/Project Alpha/b.ts → Bash: echo ${'x'.repeat(75)}`,
    '最後一句：測試全過。 CARD 已更新，關卡留無。',
  ])
  const empty = digestLines({ id: 'j' }, null, parseTranscript(''), NOW)
  expect(empty).toEqual(['執行者：j · - · ?/?', '最後活動：無', '最後動作：無', '最後一句：無'])
  const long = digestLines({ id: 'j' }, null, parseTranscript(say('2030-01-05T11:59:00Z', 'z'.repeat(1000))), NOW)
  expect(long.length).toBe(4)
  expect(long[3].length).toBeLessThanOrEqual('最後一句：'.length + 400)
  expect(digestContext(lines)).toBe(`執行者摘要：\n${lines.join('\n')}`)
})

function io(files: Record<string, string>, dirs: Record<string, string[]> = {}) {
  const reads: string[] = []
  return {
    reads,
    io: {
      windows: true,
      read: async (path: string) => { const p = path.replace(/\\/g, '/'); reads.push(p); if (!(p in files)) throw new Error('ENOENT'); return files[p] },
      exists: async (path: string) => path.replace(/\\/g, '/') in files,
      stat: async (path: string) => { const p = path.replace(/\\/g, '/'); if (!(p in files)) throw new Error('ENOENT'); return { size: files[p].length, mtimeMs: 1000 } },
      list: async (path: string) => (dirs[path.replace(/\\/g, '/')] ?? []).map(name => ({ name, kind: 'dir' })),
      run: async () => ({ exitCode: 1, stdout: '' }),
    },
  }
}

test('(c) no job, and a job whose transcript is nowhere, both come out as 無紀錄', async () => {
  const where = { root: ROOT, claudeDir: CLAUDE, sessionsPath: SESSIONS }
  const none = io({ [SESSIONS]: line({ version: 1, roots: {} }) })
  expect(await loadDigest(none.io, where, new Map(), new Map(), NOW)).toEqual({ kind: 'none' })
  expect(digestContext(null)).toBe(DIGEST_NONE)
  expect(DIGEST_NONE).toBe('執行者摘要：無紀錄')

  const lost = io({ [SESSIONS]: line({ version: 1, roots: { 'd:/project alpha': { root: ROOT, jobs: [{ id: 'j', sessionId: 'gone' }] } } }) }, { [`${CLAUDE}/projects`]: ['D--Project-Alpha'] })
  expect(await loadDigest(lost.io, where, new Map(), new Map(), NOW)).toEqual({ kind: 'none' })

  // Found through the projects folder when the daemon has no record.
  const found = io({
    [SESSIONS]: line({ version: 1, roots: { 'd:/project alpha': { root: ROOT, jobs: [{ id: 'j', launchName: 'console-j', sessionId: 'sess-1', status: 'running', phase: 'working' }] } } }),
    [`${CLAUDE}/projects/D--Project-Alpha/sess-1.jsonl`]: TRANSCRIPT,
  }, { [`${CLAUDE}/projects`]: ['D--Other', 'D--Project-Alpha'] })
  const cache = new Map()
  const result = await loadDigest(found.io, where, cache, new Map(), NOW)
  expect(result.kind).toBe('ready')
  expect(result.kind === 'ready' && result.lines[0]).toBe('執行者：console-j · - · running/working')
  // Same mtime: the transcript is not read again.
  await loadDigest(found.io, where, cache, new Map(), NOW)
  expect(found.reads.filter(p => p.endsWith('.jsonl')).length).toBe(1)
})
