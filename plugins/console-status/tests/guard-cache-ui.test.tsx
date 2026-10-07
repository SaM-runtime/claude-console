import { expect, test, mock } from 'claude-code/testing'

const OPTIONS = { options: { registryPath: 'D:/Fixtures/registry.md' } }
const BAND = { plugin: 'console-status', component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: 160 } } as any
const result = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function fixture(on: any, answer: string | null) {
  const clock = mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const data = { ran: [] as string[], asked: [] as string[], toasts: [] as string[], state: {} as Record<string, any> }
  on('fs.read', (_: any, e: any) => ({ value: e.path.includes('registry') ? '## STATUS 卡位置\n| Alpha | `D:/Alpha/.console/STATUS.md` |' : e.path.includes('claude-sessions') ? '{"version":1,"roots":{}}' : '' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_: any, e: any) => ({ value: result(e.argv[0] === 'claude' ? '[]' : '') }))
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console' }))
  const store: Record<string, unknown> = {}
  on('store.get', (_: any, e: any) => ({ value: store[e.key] ?? null }))
  on('store.set', (_: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('ui.toast', (_: any, e: any) => { data.toasts.push(e.text); return { value: undefined } })
  on('state.set', async (_: any, e: any, next: any) => { const r = await next(e); data.state[e.key] = e.value; return r })
  on('tool.call', (_: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      data.asked.push(e.questions[0].question)
      if (answer === null) return { deny: 'dismissed' }
      return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } }
    }
    data.ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return { data, clock, store }
}

test('a force push asks first; "執行一次" runs it, an ordinary command never asks', OPTIONS, async ($, on) => {
  const { data } = fixture(on, '執行一次')
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
  expect(data.asked).toEqual([])
  const answer: any = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' } as any)
  expect(answer.deny).toBeUndefined()
  expect(data.asked[0]).toMatch(/強制推送會覆寫遠端歷史[\s\S]*git push --force origin main/)
  expect(data.ran).toEqual(['npm test', 'git push --force origin main'])
  expect(data.state.feed[0].text).toBe('指令護欄放行：強制推送會覆寫遠端歷史')
})

test('a refusal or a dismissed question denies the command and tells the model not to retry it', OPTIONS, async ($, on) => {
  const { data } = fixture(on, '拒絕')
  const refused: any = await $.tool.call({ tool: 'Bash', command: 'rm -rf src' } as any)
  expect(refused.deny).toMatch(/指令護欄攔下這個指令（遞迴刪除 src）：使用者沒有同意/)
  expect(data.ran).toEqual([])
  expect(data.toasts.some(t => t.includes('指令護欄攔下：遞迴刪除 src'))).toBe(true)
})

test('commandGuard deny refuses without asking; off lets everything through', { options: { ...OPTIONS.options, commandGuard: 'deny' } }, async ($, on) => {
  const { data } = fixture(on, '執行一次')
  const answer: any = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' } as any)
  expect(answer.deny).toMatch(/commandGuard 設為 deny/)
  expect(data.asked).toEqual([])
})

test('commandGuard off never asks', { options: { ...OPTIONS.options, commandGuard: 'off' } }, async ($, on) => {
  const { data } = fixture(on, null)
  await $.tool.call({ tool: 'Bash', command: 'git reset --hard' } as any)
  expect(data.asked).toEqual([])
  expect(data.ran).toEqual(['git reset --hard'])
})

async function step($: any, on: any, cacheRead: number) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as any)
  for await (const _ of s) { /* drain */ }
  return s.result
}

test('the band counts the cache down, warns a minute before it goes cold and prices the re-write after', OPTIONS, async ($, on) => {
  const { data, clock } = fixture(on, null)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 2_000, output_tokens: 3_000, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 45_000 } }
  })
  await $.session.start({ cwd: 'D:/Console', surface: 'terminal', isInteractive: true } as any)
  await clock.settle()
  await step($, on, 150_000)
  const band = await $.ui.mount(BAND)
  // While the turn runs the cache is being refreshed: no chip.
  expect(await band.find({ type: 'Text', text: /^快取/ })).toBeUndefined()
  await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as any)
  expect(data.state.cacheClock).toEqual({ at: clock.now(), tokens: 200_000, model: 'claude-opus-5-5', ttl: '5m' })
  await clock.advance(15_000)
  expect(await band.find({ type: 'Text', text: '快取 4m' })).toBeDefined()
  await clock.advance(4 * 60_000)
  expect(data.toasts.some(t => /^主控台快取 <?1m 後過期：之後送出的提示會重寫約 200k tokens（約 \$1\.00）$/.test(t))).toBe(true)
  await clock.advance(2 * 60_000)
  expect(await band.find({ type: 'Text', text: '快取已冷 $1.00' })).toBeDefined()
  await $.prompt.submit({ text: 'next question' } as any).catch(() => {})
  expect(data.toasts.some(t => /^主控台快取已過期 1m：這則提示會重寫約 200k tokens/.test(t))).toBe(true)
  await band.unmount()
  const pane = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
    props: { title: 'Console', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  expect(await pane.find({ type: 'Text', text: /^已冷 1m　200k tokens・下則重寫約 \$1\.00$/ })).toBeDefined()
  await pane.unmount()
})
