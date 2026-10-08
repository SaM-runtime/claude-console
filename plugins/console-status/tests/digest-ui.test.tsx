import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { PROMPT_DIGEST_MS } from '../hooks/digest'

const NOW = Date.parse('2030-01-05T12:00:00Z')
const CLAUDE = 'C:/Users/example/.claude'
const ALPHA = 'D:/Project Alpha/.console/STATUS.md'
const BETA = 'D:/Project Beta/.console/STATUS.md'
const ALPHA_LOG = `${CLAUDE}/projects/D--Project-Alpha/sess-alpha-daemon.jsonl`
const BETA_LOG = `${CLAUDE}/projects/D--Project-Beta/sess-beta.jsonl`
const OPTIONS = { options: { activation: 'always', registryPath: 'D:/Fixtures/registry.md', companionStateRoots: '["D:/State"]', gitProbe: 'off', cacheHint: 'off', autoSync: 'off' } }
const PANE = () => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
  props: { title: 'Console', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
const line = (value: unknown) => JSON.stringify(value)
const transcript = (command: string, words: string) => [
  line({ type: 'assistant', timestamp: '2030-01-05T11:40:00Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }),
  line({ type: 'assistant', timestamp: '2030-01-05T11:50:00Z', message: { content: [{ type: 'text', text: words }] } }),
].join('\n')
const job = (root: string, extra: Record<string, unknown>) => ({ root, prompt: 'work', startedAt: '2030-01-05T11:00:00Z', kind: 'continue', status: 'completed', phase: 'idle', updatedAt: '2030-01-05T11:55:00Z', completedAt: '2030-01-05T11:55:00Z', ...extra })

function fixture(on: any) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local', OS: 'Windows_NT' })
  const data = { reads: [] as string[], mtime: 1000, slow: 0, statFails: false, submitted: [] as any[] }
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project Alpha | \`${ALPHA}\` |\n| Project Beta | \`${BETA}\` |`,
    [ALPHA]: '<!-- CARD -->\n- 更新：2030-01-05 11:58\n- 狀態：Alpha ready\n- 等使用者：無\n- 下一步：無\n<!-- /CARD -->',
    [BETA]: '<!-- CARD -->\n- 更新：2030-01-05 11:58\n- 狀態：Beta ready\n- 等使用者：無\n- 下一步：無\n<!-- /CARD -->',
    [`${CLAUDE}/handoffs/dispatch.json`]: '{"executor":"claude"}',
    [`${CLAUDE}/handoffs/claude-sessions.json`]: line({ version: 1, roots: {
      'd:/project alpha': { root: 'D:/Project Alpha', jobs: [job('D:/Project Alpha', { id: 'console-alpha:aaaa1111', nativeId: 'aaaa1111', launchName: 'console-alpha', sessionId: 'sess-alpha-plugin' })] },
      'd:/project beta': { root: 'D:/Project Beta', jobs: [job('D:/Project Beta', { id: 'console-beta:bbbb2222', launchName: 'console-beta', sessionId: 'sess-beta' })] },
    } }),
    [`${CLAUDE}/jobs/aaaa1111/state.json`]: line({ state: 'idle', sessionId: 'sess-alpha-daemon', linkScanPath: ALPHA_LOG.replace(/\//g, '\\') }),
    [ALPHA_LOG]: transcript('npm test', 'Alpha 完成。'),
    [BETA_LOG]: transcript('git status', 'Beta 完成。'),
  }
  on('fs.read', async (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (path.endsWith('.jsonl')) { data.reads.push(path); if (data.slow) await clock.sleep(data.slow) }
    return { value: files[path] ?? '' }
  })
  on('fs.exists', (_: any, e: any) => ({ value: fixturePath(e.path) in files }))
  on('fs.stat', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (data.statFails) throw new Error('denied')
    if (!(path in files)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: files[path].length, mtimeMs: data.mtime, isLink: false } }
  })
  on('fs.list', (_: any, e: any) => ({ value: fixturePath(e.path) === `${CLAUDE}/projects`
    ? ['D--Project-Alpha', 'D--Project-Beta'].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) : [] }))
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => { data.submitted.push(e); return { text: e.text, context: e.context } })
  return { data, clock, files }
}
const logReads = (data: { reads: string[] }, path: string) => data.reads.filter(p => p === path).length

test('(e) an expanded card shows the executor\'s four lines, reading first, and the same mtime is not read again', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  // Nothing is read until a card opens.
  expect(data.reads).toEqual([])
  data.slow = 1000
  await ui.press({ key: 'sel-Project Alpha' })
  await ui.press({ key: 'detail' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: '執行者：讀取中…' })).toBeDefined()
  await clock.advance(1000)
  // The daemon's session (sess-alpha-daemon), not the plugin's (sess-alpha-plugin).
  expect(await ui.find({ type: 'Text', text: '執行者：console-alpha · continue · completed/idle' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '最後活動：2030-01-05T11:50:00Z （10 分鐘前）' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '最後動作：Bash: npm test' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '最後一句：Alpha 完成。' })).toBeDefined()
  expect(logReads(data, ALPHA_LOG)).toBe(1)

  data.slow = 0
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail' })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  await clock.settle()
  expect(logReads(data, ALPHA_LOG)).toBe(1)
  // A transcript that changed is read again when the card is opened again.
  data.mtime = 2000
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail' })
  await clock.settle()
  expect(logReads(data, ALPHA_LOG)).toBe(2)
  await ui.unmount()
})

test('(f) a collapsed card, or another project, does not read files it does not show', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'sel-Project Alpha' })
  await ui.press({ key: 'detail' })
  await clock.settle()
  expect(logReads(data, ALPHA_LOG)).toBe(1)
  expect(logReads(data, BETA_LOG)).toBe(0)

  // Collapsed: a refresh with changed transcripts reads nothing.
  await ui.press({ key: 'detail' })
  data.mtime = 2000
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  await clock.settle()
  expect(data.reads.length).toBe(1)

  // Opened again on Alpha: its changed transcript is read once more.
  await ui.press({ key: 'detail' })
  await clock.settle()
  expect(logReads(data, ALPHA_LOG)).toBe(2)
  expect(logReads(data, BETA_LOG)).toBe(0)

  // Focus moves to Beta (the selection let go): Beta is read, found through the projects folder; Alpha is not read again.
  await ui.press({ key: 'unselect' })
  await ui.press({ key: 'df-Project Beta' })
  await clock.settle()
  expect(logReads(data, BETA_LOG)).toBe(1)
  expect(logReads(data, ALPHA_LOG)).toBe(2)
  expect(await ui.find({ type: 'Text', text: '最後動作：Bash: git status' })).toBeDefined()
  await ui.unmount()
})

test('a prompt sent with a project selected carries its 執行者摘要, from the same cache', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'sel-Project Alpha' })
  await ui.press({ key: 'detail' })
  await clock.settle()
  expect(logReads(data, ALPHA_LOG)).toBe(1)
  await $.prompt.submit({ text: '這個專案現在怎樣？' } as any)
  const context = (data.submitted.at(-1)?.context ?? []).join('\n')
  expect(context.includes('【主控台面板選取】使用者在 console-status 面板選了專案「Project Alpha」')).toBe(true)
  expect(context.includes('執行者摘要：\n執行者：console-alpha · continue · completed/idle\n最後活動：2030-01-05T11:50:00Z （10 分鐘前）\n最後動作：Bash: npm test\n最後一句：Alpha 完成。')).toBe(true)
  expect(logReads(data, ALPHA_LOG)).toBe(1)
  await ui.unmount()
})

test('a project with no executor record says 執行者摘要：無紀錄, and a broken read never holds the prompt', OPTIONS, async ($, on) => {
  const { data } = fixture(on)
  data.statFails = true
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'sel-Project Beta' })
  await $.prompt.submit({ text: 'Beta?' } as any)
  const context = (data.submitted.at(-1)?.context ?? []).join('\n')
  expect(context.includes('專案「Project Beta」')).toBe(true)
  expect(/執行者摘要：(無紀錄|無法讀取（.+）)/.test(context)).toBe(true)
  await ui.unmount()
})

const contextOf = (data: { submitted: any[] }) => (data.submitted.at(-1)?.context ?? []).join('\n')

test('(i) a slow digest read lets the prompt go after PROMPT_DIGEST_MS, carrying the project\'s last digest', OPTIONS, async ($, on) => {
  const { data, clock, files } = fixture(on)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'sel-Project Alpha' })
  await ui.press({ key: 'detail' })
  await clock.settle()
  expect(logReads(data, ALPHA_LOG)).toBe(1)
  // The executor moved on; reading its transcript now takes five seconds.
  files[ALPHA_LOG] = transcript('npm run build', 'Alpha 第二輪。')
  data.mtime = 2000
  data.slow = 5000
  const sending = $.prompt.submit({ text: '進度？' } as any)
  await clock.advance(PROMPT_DIGEST_MS)
  expect(data.submitted.length).toBe(1)
  expect(contextOf(data).includes('執行者摘要：\n執行者：console-alpha')).toBe(true)
  expect(contextOf(data).includes('最後一句：Alpha 完成。')).toBe(true)
  await clock.advance(5000)
  await sending
  await ui.unmount()
})

test('(j) a slow digest read with nothing cached says 無法讀取（逾時）', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'sel-Project Alpha' })
  data.slow = 5000
  const sending = $.prompt.submit({ text: '進度？' } as any)
  await clock.advance(PROMPT_DIGEST_MS)
  expect(data.submitted.length).toBe(1)
  expect(contextOf(data).includes('執行者摘要：無法讀取（逾時）')).toBe(true)
  await clock.advance(5000)
  await sending
  await ui.unmount()
})

test('(k) the read a prompt stopped waiting for goes on, and the next prompt carries what it found without reading again', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'sel-Project Alpha' })
  data.slow = 5000
  const first = $.prompt.submit({ text: '進度？' } as any)
  await clock.advance(PROMPT_DIGEST_MS)
  await clock.advance(5000)
  await first
  expect(logReads(data, ALPHA_LOG)).toBe(1)
  await ui.press({ key: 'sel-Project Alpha' })
  await $.prompt.submit({ text: '再一次' } as any)
  expect(contextOf(data).includes('最後一句：Alpha 完成。')).toBe(true)
  expect(logReads(data, ALPHA_LOG)).toBe(1)
  await ui.unmount()
})
