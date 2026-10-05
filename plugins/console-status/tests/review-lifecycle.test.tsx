import { expect, test, mock } from 'claude-code/testing'

const OPTIONS = { options: { registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/companion.mjs', companionStateRoots: '["D:/State"]' } }
const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const PANE = () => ({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
  props: { title: 'Console', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
const processResult = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function fixture(on: any, extra: string) {
  mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local', OS: 'Windows_NT' })
  const state: Record<string, any> = {}
  const toasts: string[] = []
  on('fs.list', () => ({ value: [{ name: 'Project Alpha-hash', kind: 'dir' }] }))
  on('fs.read', (_: any, e: any) => {
    const path = e.path.replace(/\\/g, '/')
    const files: Record<string, string> = {
      'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project Alpha | \`${STATUS}\` |`,
      [STATUS]: `<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 狀態：Ready\n- 等使用者：無\n- 下一步：Run local tests\n- 驗證：無\n- 關卡：無\n${extra}\n<!-- /CARD -->`,
      'D:/State/Project Alpha-hash/state.json': '{"jobs":[]}',
      'C:/Users/example/.claude/handoffs/dispatch.json': '{}',
      'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
      'C:/Users/example/.codex/models_cache.json': '{}',
    }
    return { value: files[path] ?? '' }
  })
  on('process.run', (_: any, e: any) => ({ value: processResult(e.argv[0] === 'claude' ? '[]' : 'OK codex=0.0.0-test') }))
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'fixture-session' }))
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('state.set', async (_: any, e: any, next: any) => {
    const answer = await next(e)
    state[e.key] = e.value
    return answer
  })
  return { state, toasts }
}

test('rewritten review prompt binds its early turn, completes, and keeps the release reminder', OPTIONS, async ($, on) => {
  const { state, toasts } = fixture(on, '- 關卡： Release：Inspect evidence')
  on('prompt.submit', async (_: any, e: any) => {
    const text = `${e.text}\n[rewritten beneath]`
    await $.turn.start({ text, turnId: 'review-rewritten' })
    return { text }
  })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))

  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'next-action' })
  expect(state.reviewRequests[STATUS].text.endsWith('[rewritten beneath]')).toBe(true)
  expect(state.reviewRequests[STATUS].turnId).toBe('review-rewritten')
  expect(toasts.some(text => text.includes('正式執行仍待你決定'))).toBe(true)

  await $.turn.complete({ turnId: 'review-rewritten', answer: '不可上線：缺證據', durationMs: 1, isAborted: false, reason: 'answer' })
  expect(state.reviewRequests[STATUS]).toBeUndefined()
  expect(state.pendingActions[STATUS]).toBeUndefined()
  expect(state.feed.some((event: any) => event.text.includes('不可上線：缺證據'))).toBe(true)
  await ui.unmount()
})

test('session start releases a review left pending by an interrupted plugin lifetime', OPTIONS, async ($, on) => {
  const { state } = fixture(on, '- 驗證：node test.mjs\n- 關卡：review：Inspect evidence')
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('command.register', (_: any, e: any) => ({ command: e.command }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-verify' })
  expect(state.verificationResults[STATUS]?.ok).toBe(true)
  await ui.press({ key: 'next-action' })
  expect(state.pendingActions[STATUS]?.kind).toBe('gate')
  expect(state.reviewRequests[STATUS]).toBeDefined()

  await $.session.start({ cwd: 'D:/Console', surface: 'terminal', isInteractive: true })
  expect(state.reviewRequests).toEqual({})
  expect(state.pendingActions[STATUS]).toBeUndefined()
  expect(state.continueConfirmations).toEqual({})
  expect(state.verificationResults[STATUS]?.ok).toBe(true)
  await ui.unmount()
})

test('a rejected user prompt retains one-shot project selection for the accepted retry', OPTIONS, async ($, on) => {
  const { state } = fixture(on, '- 等使用者：Choose colour')
  on('prompt.fill', () => ({ isFilled: true }))
  const submissions: any[] = []
  on('prompt.submit', (_: any, e: any) => {
    submissions.push(e)
    return submissions.length === 1 ? { drop: 'blocked once' } : { text: e.text, context: e.context }
  })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'next-action' })
  expect(state.selected).toBe('Project Alpha')

  const rejected = await $.prompt.submit({ text: 'Use blue' } as any)
  expect(rejected.drop).toBe('blocked once')
  expect(state.selected).toBe('Project Alpha')
  await $.prompt.submit({ text: 'Use blue' } as any)
  expect(submissions[1].context.join('\n').includes(STATUS)).toBe(true)
  expect(state.selected).toBe(null)
  await ui.unmount()
})
