import { expect, test, mock } from 'claude-code/testing'
import { rows } from '../hooks/logic'
import { fixturePath } from './fixture-path'

const OPTIONS = { options: { registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/companion.mjs', companionStateRoots: '["D:/State"]' } }
const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const SETTINGS = 'C:/Users/example/.claude/handoffs/dispatch.json'
const SESSIONS = 'C:/Users/example/.claude/handoffs/claude-sessions.json'
const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
  props: { title: 'Console', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any

function fixture(on: any, source: 'claude' | 'codex') {
  mock.env(on, { USERPROFILE: 'C:/Users/example' })
  mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  const files: Record<string, string> = {
    [SETTINGS]: JSON.stringify({ executor: source, model: '', effort: '' }),
    [SESSIONS]: '{"version":1,"roots":{}}',
    'D:/State/Project Alpha-hash/state.json': '{"jobs":[]}',
    'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project Alpha | \`${STATUS}\` |`,
    [STATUS]: '<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：無\n- 下一步：Run tests\n<!-- /CARD -->',
  }
  const launches: any[] = []
  const agents: any[] = []
  const state: Record<string, any> = {}
  const toasts: string[] = []
  const publish = (status: string) => {
    const job = { id: 'owned-job', jobClass: 'task', root: 'D:/Project Alpha', prompt: 'work', status, phase: status, startedAt: '2030-01-05T11:00:00Z' }
    if (source === 'claude') files[SESSIONS] = JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', jobs: [job] } } })
    else files['D:/State/Project Alpha-hash/state.json'] = JSON.stringify({ jobs: [job] })
  }
  on('fs.read', (_: any, e: any) => ({ value: files[fixturePath(e.path)] ?? '' }))
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', (_: any, e: any) => ({ value: fixturePath(e.path) === 'D:/State' ? [{ name: 'Project Alpha-hash', kind: 'dir' }] : [] }))
  on('process.run', (_: any, e: any) => {
    if (e.argv.includes('--bg') || e.argv[0] === 'node') launches.push(e)
    return { value: { exitCode: 0, stdout: e.argv[1] === 'agents' ? JSON.stringify(agents) : e.argv[0] === 'node' ? '{"jobId":"new-job"}' : 'OK', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.toast', (_: any, e: any) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('state.set', async (_: any, e: any, next: any) => { const value = await next(e); state[e.key] = e.value; return value })
  return { files, launches, agents, state, publish, toasts }
}

for (const source of ['claude', 'codex'] as const) {
  const target = source === 'claude' ? 'codex' : 'claude'
  test(`${source} active work survives switch to ${target} and blocks dispatch`, OPTIONS, async ($, on) => {
    const h = fixture(on, source)
    h.publish('running')
    await $.command.run({ command: 'console', args: 'refresh' } as any)
    await $.command.run({ command: 'console', args: `executor ${target}` } as any)
    const ui = await $.ui.mount(PANE)
    await ui.press({ key: 'detail' })
    for (const status of ['running', 'queued', 'starting', 'unknown']) {
      h.publish(status)
      await $.command.run({ command: 'console', args: 'refresh' } as any)
      expect(rows(h.state.snapshot)[0].state).toBe('RUNNING')
      expect(rows(h.state.snapshot)[0].item).toContain(source)
      // Blocked dispatch is explained as text, not offered as a dead button.
      expect(await ui.find({ key: 'detail-Project Alpha-continue' })).toBeUndefined()
      const blocked = await ui.find({ type: 'Text', text: /^派工鎖定：/ })
      expect(blocked?.text).toContain(source)
      expect(blocked?.text).toContain('尚未結束')
      expect(h.launches).toEqual([])
    }
    h.publish('completed')
    await $.command.run({ command: 'console', args: 'refresh' } as any)
    expect(rows(h.state.snapshot)[0].state).toBe('IDLE')
    expect((await ui.find({ key: 'detail-Project Alpha-continue' }))?.text).toBe('⇢ 繼續下一步')
    await ui.unmount()
  })
}

test('dispatch rechecks both executors when workspace became busy after the last refresh', OPTIONS, async ($, on) => {
  const h = fixture(on, 'claude')
  await $.command.run({ command: 'console', args: 'executor codex' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  h.publish('running')
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches).toEqual([])
  expect(h.toasts.some(text => text.includes('claude') && text.includes('尚未結束'))).toBe(true)
  await ui.unmount()
})

test('a newly accepted Codex job remains protected after switching before state-file publication', OPTIONS, async ($, on) => {
  const h = fixture(on, 'codex')
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches.length).toBe(1)
  await $.command.run({ command: 'console', args: 'executor claude' } as any)
  expect(rows(h.state.snapshot)[0].state).toBe('RUNNING')
  expect((await ui.find({ type: 'Text', text: /^派工鎖定：/ }))?.text).toContain('codex 工作尚未結束')
  expect(await ui.find({ key: 'detail-Project Alpha-continue' })).toBeUndefined()
  expect(h.launches.length).toBe(1)
  // Terminal state can be published first; it must also release the local hold.
  h.files['D:/State/Project Alpha-hash/state.json'] = '{"jobs":[{"id":"new-job","jobClass":"task","status":"completed"}]}'
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(rows(h.state.snapshot)[0].state).toBe('IDLE')
  await ui.unmount()
})

test('a running Claude resume copy blocks Claude and Codex dispatch until the copy finishes', OPTIONS, async ($, on) => {
  const h = fixture(on, 'claude')
  const original = '11111111-2222-4333-8444-555555555555'
  const copy = '66666666-7777-4888-8999-000000000000'
  h.files[SESSIONS] = JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: original, jobs: [
    { id: 'pending', launchName: 'copy-launch', sessionId: original, root: 'D:/Project Alpha', prompt: 'sample work', startedAt: '2030-01-05T11:00:00Z', status: 'running', phase: 'unknown' },
  ] } } })
  const copiedAgent = { id: 'abc12345', name: 'copy-launch', sessionId: copy, cwd: 'D:/Project Alpha', kind: 'background', state: 'working' }
  // The original session is at work, so the resume is a copy, not a move.
  const old = { id: 'def67890', name: 'old-launch', sessionId: original, cwd: 'D:/Project Alpha', kind: 'background', state: 'working', status: 'busy', pid: 7, startedAt: '2030-01-05T10:00:00Z' }
  h.agents.push(old, copiedAgent)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  for (const executor of ['claude', 'codex']) {
    await $.command.run({ command: 'console', args: `executor ${executor}` } as any)
    expect(rows(h.state.snapshot)[0].state).toBe('RUNNING')
    expect((await ui.find({ type: 'Text', text: /^派工鎖定：/ }))?.text).toContain('claude 工作尚未結束')
    expect(await ui.find({ key: 'detail-Project Alpha-continue' })).toBeUndefined()
    expect(h.launches).toEqual([])
  }
  expect(h.state.feed.some((event: any) => event.text.includes('unmanaged'))).toBe(true)
  h.agents.splice(1, 1)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(rows(h.state.snapshot)[0].state).toBe('RUNNING')
  expect(JSON.parse(h.files[SESSIONS]).roots['d:/project alpha'].sessionId).toBe(original)
  h.agents.push({ ...copiedAgent, state: 'done' })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(rows(h.state.snapshot)[0].state).toBe('IDLE')
  const persisted = JSON.parse(h.files[SESSIONS]).roots['d:/project alpha']
  expect(persisted.sessionId).toBe(original)
  expect(persisted.jobs[0].sessionId).toBe(original)
  expect(persisted.jobs[0].status).toBe('completed')
  await ui.press({ key: 'detail-Project Alpha-continue' })
  await ui.press({ key: 'detail-Project Alpha-continue' })
  expect(h.launches.length).toBe(1)
  expect(h.launches[0].argv[0]).toBe('node')
  await ui.unmount()
})
