import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { GATE_PENDING_MS } from '../hooks/actions'

const OPTIONS = { options: { activation: 'always', registryPath: 'D:/Fixtures/registry.md', companionStateRoots: '["D:/State"]' } }
const ALPHA = 'D:/Project Alpha/.console/STATUS.md'
const BETA = 'D:/Project Beta/.console/STATUS.md'
const NOW = Date.parse('2030-01-05T12:00:00Z')
const PANE = () => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
  props: { title: 'Console', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
const result = (exitCode = 0, stdout = '') => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const done = (turnId: string, answer: string) => ({ turnId, answer, durationMs: 1, isAborted: false, reason: 'answer' } as any)
/** How the host hands a plugin's prompt to the model when it was queued behind a running turn (seen 2026-10-07 in the console transcripts). */
const wrapped = (text: string) => `The console-status plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns; it starts this turn in the user's place. Address the message above.`

function fixture(on: any) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local', OS: 'Windows_NT' })
  const data = {
    cards: { [ALPHA]: '- 驗證：`node test.mjs`\n- 關卡：review：Inspect evidence', [BETA]: '- 驗證：`node test.mjs`\n- 關卡：無' } as Record<string, string>,
    state: {} as Record<string, any>, toasts: [] as string[], runs: [] as string[][],
    /** ms a verify run takes; 0 answers at once. */
    verifyDelay: 0,
    submit: async (e: any): Promise<any> => ({ text: e.text }),
  }
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    const files: Record<string, string> = {
      'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project Alpha | \`${ALPHA}\` |\n| Project Beta | \`${BETA}\` |`,
      [ALPHA]: `<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 狀態：Ready\n- 等使用者：無\n- 下一步：無\n${data.cards[ALPHA]}\n<!-- /CARD -->`,
      [BETA]: `<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 狀態：Ready\n- 等使用者：無\n- 下一步：無\n${data.cards[BETA]}\n<!-- /CARD -->`,
      'C:/Users/example/.claude/handoffs/dispatch.json': '{}',
      'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
      'C:/Users/example/.codex/models_cache.json': '{}',
    }
    return { value: files[path] ?? '' }
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', async (_: any, e: any) => {
    data.runs.push(e.argv)
    if (e.argv[0] === 'claude') return { value: result(0, '[]') }
    if (e.argv[0] === 'git') return { value: result(128) }
    if (e.argv[0] === 'gh') return { value: result(1) }
    if (data.verifyDelay) await clock.sleep(data.verifyDelay)
    return { value: result(0, 'ok') }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', (_: any, e: any) => { data.toasts.push(e.text); return { value: undefined } })
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => data.submit(e))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('state.set', async (_: any, e: any, next: any) => { const answer = await next(e); data.state[e.key] = e.value; return answer })
  const store: Record<string, unknown> = {}
  on('store.get', (_: any, e: any) => ({ value: store[e.key] ?? null }))
  on('store.set', (_: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  return { data, clock }
}

/** The 驗證 command is not yet trusted, so the first press arms it and the second runs it. */
async function pressVerify(ui: any, project: string) {
  await ui.press({ key: `detail-${project}-verify` })
  await ui.press({ key: `detail-${project}-verify` })
}
const verifyRuns = (data: { runs: string[][] }) => data.runs.filter(argv => argv[0] === 'powershell').length

async function open($: any, detail = true) {
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  if (detail) await ui.press({ key: 'detail' })
  return ui
}

test('a review prompt the host wrapped still binds its turn, and the end of that turn unlocks the row', OPTIONS, async ($, on) => {
  const { data } = fixture(on)
  let submitted = ''
  data.submit = async e => { submitted = e.text; return { text: e.text } }
  const ui = await open($)
  await ui.press({ key: 'detail-Project Alpha-gate' })
  expect(data.state.pendingActions[ALPHA]?.kind).toBe('gate')
  expect(submitted.startsWith('依 claude-console skill 審核「Project Alpha」的 review 關卡。')).toBe(true)

  await $.turn.start({ text: wrapped(submitted), turnId: 'wrapped-review' })
  expect(data.state.reviewRequests[ALPHA]?.turnId).toBe('wrapped-review')
  await $.turn.complete(done('wrapped-review', '可上線：證據齊全'))
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()
  expect(data.state.reviewRequests[ALPHA]).toBeUndefined()
  expect(data.state.feed.some((event: any) => event.text.includes('審核已回覆：可上線：證據齊全'))).toBe(true)
  await pressVerify(ui, 'Project Alpha')
  expect(verifyRuns(data)).toBe(1)
  await ui.unmount()
})

test('a submit that resolves only after its wrapped turn has ended still unlocks the row and lets go of its lock', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on)
  let submitted = ''
  let resolveSubmit: (value: any) => void = () => {}
  data.submit = e => { submitted = e.text; return new Promise(resolve => { resolveSubmit = resolve }) }
  const ui = await open($)
  const pressing = ui.press({ key: 'detail-Project Alpha-gate' })
  await clock.settle()
  expect(submitted).not.toBe('')
  expect(data.state.pendingActions[ALPHA]?.kind).toBe('gate')

  await $.turn.start({ text: wrapped(submitted), turnId: 'queued-review' })
  await $.turn.complete(done('queued-review', '不可上線：缺測試'))
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()
  expect(data.state.feed.some((event: any) => event.text.includes('審核已回覆：不可上線：缺測試'))).toBe(true)
  resolveSubmit({ text: submitted })
  await pressing
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()
  await pressVerify(ui, 'Project Alpha')
  expect(verifyRuns(data)).toBe(1)
  await ui.unmount()
})

test('a review no turn ever answers unlocks the row after GATE_PENDING_MS, at the next refresh', { options: { ...OPTIONS.options, cacheHint: 'off', gitProbe: 'off' } }, async ($, on) => {
  const { data, clock } = fixture(on)
  const ui = await open($)
  await ui.press({ key: 'detail-Project Alpha-gate' })
  expect(data.state.pendingActions[ALPHA]?.kind).toBe('gate')
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(data.state.pendingActions[ALPHA]?.kind).toBe('gate')
  // The waiting row redraws once a second; ten minutes of that is not what this test is about.
  await ui.unmount()

  await clock.advance(GATE_PENDING_MS)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()
  // Only the row is let go: the request stays, so a turn that starts late still reports its answer.
  expect(data.state.reviewRequests[ALPHA]).toBeDefined()
  expect(data.toasts.some(text => text.endsWith('：審核狀態已逾時，按鈕已解鎖'))).toBe(true)
  const again = await $.ui.mount(PANE())
  await pressVerify(again, 'Project Alpha')
  expect(verifyRuns(data)).toBe(1)
  await again.unmount()
})

test('a review whose gate the CARD has moved past is dropped at the next refresh: the stale button goes and verify runs', OPTIONS, async ($, on) => {
  const { data } = fixture(on)
  const ui = await open($)
  await ui.press({ key: 'detail-Project Alpha-gate' })
  expect(await ui.find({ key: 'detail-Project Alpha-gate' })).toBeDefined()

  data.cards[ALPHA] = '- 驗證：`node test.mjs`\n- 關卡：無'
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()
  expect(data.state.reviewRequests[ALPHA]).toBeUndefined()
  expect(data.toasts.some(text => text.endsWith('：關卡已變更，按鈕已解鎖'))).toBe(true)
  expect(await ui.find({ key: 'detail-Project Alpha-gate' })).toBeUndefined()
  await pressVerify(ui, 'Project Alpha')
  expect(verifyRuns(data)).toBe(1)
  await ui.unmount()
})

test('while a bound review turn still runs after the CARD dropped its gate, the row is free and the answer still lands', OPTIONS, async ($, on) => {
  const { data } = fixture(on)
  let submitted = ''
  data.submit = async e => { submitted = e.text; return { text: e.text } }
  on('turn.step', async function* (_: any, e: any) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' } })
  const ui = await open($)
  await ui.press({ key: 'detail-Project Alpha-gate' })
  await $.turn.start({ text: wrapped(submitted), turnId: 'running-review' })
  const step = $.turn.step({ turnId: 'running-review', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as any)
  for await (const _ of step) { /* the review turn is now running */ }

  data.cards[ALPHA] = '- 驗證：`node test.mjs`\n- 關卡：無'
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()
  expect(data.state.reviewRequests[ALPHA]?.turnId).toBe('running-review')
  expect(await ui.find({ key: 'detail-Project Alpha-gate' })).toBeUndefined()
  await pressVerify(ui, 'Project Alpha')
  expect(verifyRuns(data)).toBe(1)

  await $.turn.complete(done('running-review', '可上線'))
  expect(data.state.reviewRequests[ALPHA]).toBeUndefined()
  expect(data.state.feed.some((event: any) => event.text.includes('審核已回覆：可上線'))).toBe(true)
  await ui.unmount()
})

test('/console off lets go of a stuck review but not of a verify still running, and frees the lock of a submit that never returned', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on)
  const resolvers: ((value: any) => void)[] = []
  let submitted = ''
  data.submit = e => { submitted = e.text; return new Promise(resolve => { resolvers.push(resolve) }) }
  data.verifyDelay = 5000
  const ui = await open($)
  const pressing = ui.press({ key: 'detail-Project Alpha-gate' })
  await clock.settle()
  await ui.press({ key: 'df-Project Beta' })
  await ui.press({ key: 'detail-Project Beta-verify' })
  const verifying = ui.press({ key: 'detail-Project Beta-verify' })
  await clock.settle()
  expect(data.state.pendingActions[ALPHA]?.kind).toBe('gate')
  expect(data.state.pendingActions[BETA]?.kind).toBe('verify')

  await $.command.run({ command: 'console', args: 'off' } as any)
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()
  expect(data.state.pendingActions[BETA]?.kind).toBe('verify')
  expect(data.toasts.some(text => text.endsWith('：主控台已關閉，審核狀態已清除，按鈕已解鎖'))).toBe(true)
  await clock.advance(5000)
  await verifying
  expect(data.state.pendingActions[BETA]).toBeUndefined()
  await ui.unmount()

  // The lock the unanswered submit still held is gone too: the next press submits again (the detail view is still on).
  const again = await open($, false)
  await again.press({ key: 'df-Project Alpha' })
  const second = again.press({ key: 'detail-Project Alpha-gate' })
  await clock.settle()
  expect(resolvers.length).toBe(2)
  for (const resolve of resolvers) resolve({ text: submitted })
  await pressing
  await second
  await again.unmount()
})

test('the host\'s own slash commands and selecting a project leave no pending action behind', OPTIONS, async ($, on) => {
  const { data } = fixture(on)
  on('command.run', () => ({ text: '' }))
  const ui = await open($, false)
  await $.command.run({ command: 'model', args: '' } as any)
  await $.command.run({ command: 'effort', args: 'high' } as any)
  await ui.press({ key: 'sel-Project Alpha' })
  expect(data.state.selected).toBe('Project Alpha')
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(data.state.pendingActions ?? {}).toEqual({})
  await ui.press({ key: 'detail' })
  expect(await ui.find({ key: 'detail-Project Alpha-gate' })).toBeDefined()
  await pressVerify(ui, 'Project Alpha')
  expect(verifyRuns(data)).toBe(1)
  await ui.unmount()
})

const SLOW = { options: { ...OPTIONS.options, cacheHint: 'off', gitProbe: 'off' } }
const answered = (data: { state: Record<string, any> }, answer: string) => data.state.feed.filter((event: any) => event.text.includes(`審核已回覆：${answer}`)).length

test('a review whose turn starts only after GATE_PENDING_MS still reports its answer once; the row is free meanwhile', SLOW, async ($, on) => {
  const { data, clock } = fixture(on)
  let submitted = ''
  data.submit = async e => { submitted = e.text; return { text: e.text } }
  const ui = await open($)
  await ui.press({ key: 'detail-Project Alpha-gate' })
  await ui.unmount()

  // The console's own turn ran past the timeout, so the queued review has not started yet.
  await clock.advance(GATE_PENDING_MS + 60_000)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()
  const again = await $.ui.mount(PANE())
  await pressVerify(again, 'Project Alpha')
  expect(verifyRuns(data)).toBe(1)

  await $.turn.start({ text: wrapped(submitted), turnId: 'late-review' })
  await $.turn.complete(done('late-review', '可上線：晚到的答案'))
  expect(answered(data, '可上線：晚到的答案')).toBe(1)
  expect(data.state.reviewRequests[ALPHA]).toBeUndefined()
  await again.unmount()
})

test('the end of a review turn leaves a verify pressed meanwhile alone', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on)
  let submitted = ''
  data.submit = async e => { submitted = e.text; return { text: e.text } }
  data.verifyDelay = 5000
  on('turn.step', async function* (_: any, e: any) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' } })
  const ui = await open($)
  await ui.press({ key: 'detail-Project Alpha-gate' })
  await $.turn.start({ text: wrapped(submitted), turnId: 'running-review' })
  const step = $.turn.step({ turnId: 'running-review', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as any)
  for await (const _ of step) { /* the review turn is now running */ }
  // The review moves the CARD past its gate while it runs: the row is free again.
  data.cards[ALPHA] = '- 驗證：`node test.mjs`\n- 關卡：無'
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()

  await ui.press({ key: 'detail-Project Alpha-verify' })
  const verifying = ui.press({ key: 'detail-Project Alpha-verify' })
  await clock.settle()
  expect(data.state.pendingActions[ALPHA]?.kind).toBe('verify')
  await $.turn.complete(done('running-review', '可上線'))
  expect(answered(data, '可上線')).toBe(1)
  expect(data.state.pendingActions[ALPHA]?.kind).toBe('verify')
  expect(data.toasts.some(text => text.includes('失去追蹤'))).toBe(false)

  await clock.advance(5000)
  await verifying
  expect(data.state.pendingActions[ALPHA]).toBeUndefined()
  expect(verifyRuns(data)).toBe(1)
  await ui.unmount()
})
