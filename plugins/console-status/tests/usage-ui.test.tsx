import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'

const NOW = Date.parse('2030-01-05T12:00:00Z')
const HOUR = 3_600_000
const CLAUDE = 'C:/Users/example/.claude'
const ALPHA = 'D:/Project Alpha/.console/STATUS.md'
const BETA = 'D:/Project Beta/.console/STATUS.md'
const S1 = '11111111-1111-4111-8111-111111111111'
const ALPHA_LOG = `${CLAUDE}/projects/D--Project-Alpha/${S1}.jsonl`
const OPTIONS = { options: { activation: 'always', registryPath: 'D:/Fixtures/registry.md', companionStateRoots: '["D:/State"]', gitProbe: 'off', cacheHint: 'off', autoSync: 'off' } }
const PANE = () => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
  props: { title: 'Console', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
const iso = (at: number) => new Date(at).toISOString()
const USAGE = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20_000, output_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } }
const reply = (id: string, at: number) => JSON.stringify({ type: 'assistant', timestamp: iso(at), requestId: `req_${id}`, message: { model: 'claude-opus-5-5', id: `msg_${id}`, content: [{ type: 'text', text: '好' }], usage: USAGE } })
const job = (id: string, at: number) => ({ id, root: 'D:/Project Alpha', prompt: 'work', startedAt: iso(at), kind: 'continue', status: 'completed', phase: 'idle', sessionId: S1, completedAt: iso(at + 600_000) })
// The 用量 row wraps between its `・` parts, each its own Text.
const shown = async (ui: any, line: string) => {
  const parts = line.split('・')
  for (const [i, part] of parts.entries()) expect(await ui.find({ type: 'Text', text: i < parts.length - 1 ? part + '・' : part })).toBeDefined()
}
const card = (name: string) => `<!-- CARD -->\n- 更新：2030-01-05 11:58\n- 狀態：${name} ready\n- 等使用者：無\n- 下一步：無\n<!-- /CARD -->`

function fixture(on: any) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local', OS: 'Windows_NT' })
  const data = { reads: [] as string[], runs: [] as string[][] }
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project Alpha | \`${ALPHA}\` |\n| Project Beta | \`${BETA}\` |`,
    [ALPHA]: card('Alpha'),
    [BETA]: card('Beta'),
    [`${CLAUDE}/handoffs/dispatch.json`]: '{"executor":"claude"}',
    [`${CLAUDE}/handoffs/claude-sessions.json`]: JSON.stringify({ version: 1, roots: {
      'd:/project alpha': { root: 'D:/Project Alpha', sessionId: S1, jobs: [job('a', NOW - 26 * HOUR), job('b', NOW - HOUR)] },
    } }),
    // One response a day ago, one in this 5-hour window, each split over two lines.
    [ALPHA_LOG]: [reply('a', NOW - 26 * HOUR), reply('a', NOW - 26 * HOUR), reply('b', NOW - HOUR), reply('b', NOW - HOUR)].join('\n') + '\n',
    // Beta's work ran on Codex, which keeps no token record.
    'D:/State/Project Beta-1a2b3c/state.json': JSON.stringify({ jobs: [{ id: 'task-1', jobClass: 'task', status: 'completed', startedAt: iso(NOW - 3 * HOUR), completedAt: iso(NOW - 2 * HOUR) }] }),
  }
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (path.endsWith('.jsonl')) data.reads.push(path)
    if (!(path in files)) throw new Error('ENOENT')
    return { value: files[path] }
  })
  on('fs.exists', (_: any, e: any) => ({ value: fixturePath(e.path) in files }))
  on('fs.stat', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in files)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: new TextEncoder().encode(files[path]).length, mtimeMs: NOW - HOUR, isLink: false } }
  })
  on('fs.list', (_: any, e: any) => {
    const path = fixturePath(e.path)
    const dirs: Record<string, string[]> = { [`${CLAUDE}/projects`]: ['D--Project-Alpha'], 'D:/State': ['Project Beta-1a2b3c'] }
    return { value: (dirs[path] ?? []).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('process.run', (_: any, e: any) => { data.runs.push(e.argv); return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('session.usage', () => ({ value: { rateLimits: [
    { kind: 'five_hour', percentUsed: 10, resetsAt: iso(NOW + 3 * HOUR) },
    { kind: 'seven_day', percentUsed: 20, resetsAt: iso(NOW + 48 * HOUR) },
  ] } }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  return { data, clock, files }
}

test('an open card shows what its dispatched work used this week, and reads its transcript again only once it changes', OPTIONS, async ($, on) => {
  const { data, clock, files } = fixture(on)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  // Nothing is read until a card opens.
  expect(data.reads).toEqual([])
  await ui.press({ key: 'sel-Project Alpha' })
  await ui.press({ key: 'detail' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '用量' })).toBeDefined()
  // Two responses (each written as two lines) of 21,510 tokens on Opus 5.5, one of them in this 5-hour window.
  await shown(ui, '本週 2 次工作・4.3 萬 tokens・約 $0.04（API 牌價）・5 小時內 2.2 萬')
  const reads = data.reads.filter(p => p === ALPHA_LOG).length
  // A small transcript is read as a file, without a process.
  expect(data.runs.some(argv => argv.join(' ').includes('#consumed'))).toBe(false)

  // The card opened again within the minute is not read again; past it, an unchanged transcript is not read either.
  const reopen = async () => { await ui.press({ key: 'detail' }); await ui.press({ key: 'detail' }); await clock.settle() }
  await reopen()
  await clock.advance(61_000)
  await reopen()
  expect(data.reads.filter(p => p === ALPHA_LOG).length).toBe(reads)

  // A new response: counted once the minute is up.
  files[ALPHA_LOG] += reply('c', NOW + 60_000) + '\n'
  await reopen()
  await shown(ui, '本週 2 次工作・4.3 萬 tokens・約 $0.04（API 牌價）・5 小時內 2.2 萬')
  await clock.advance(61_000)
  await reopen()
  await shown(ui, '本週 2 次工作・6.5 萬 tokens・約 $0.07（API 牌價）・5 小時內 4.3 萬')
  expect(await ui.find({ type: 'Text', text: '4.3 萬 tokens・' })).toBeUndefined()

  // Codex keeps no token record: Beta's job is counted, nothing more.
  await ui.press({ key: 'unselect' })
  await ui.press({ key: 'df-Project Beta' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '本週 1 次工作（Codex 不提供 token 數）' })).toBeDefined()
  await ui.unmount()
})

test('/console usage lists every project, the most first, with what the estimate is', OPTIONS, async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const result: any = await $.command.run({ command: 'console', args: 'usage' } as any)
  const lines = String(result?.text ?? '').split('\n')
  expect(lines[0]).toMatch(/^各專案用量・本週（從 \d+\/\d+ \(.\) \d\d:\d\d 額度重置算起）$/)
  expect(lines.slice(1)).toEqual([
    '金額照 API 牌價估，訂閱方案不會另外收這筆錢；只算主控台派出去的工作，主控台自己的對話看用量表的「花費」。',
    'Project Alpha　4.3 萬 tokens・約 $0.04（100%）・2 次工作・5 小時內 2.2 萬',
    'Project Beta　1 次工作（Codex 不提供 token 數）',
  ])
})

test('the demo has no usage to read', OPTIONS, async ($, on) => {
  fixture(on)
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const result: any = await $.command.run({ command: 'console', args: 'usage' } as any)
  expect(result?.text).toBe('示範資料：沒有用量可算；/console refresh 回到實際資料。')
})
