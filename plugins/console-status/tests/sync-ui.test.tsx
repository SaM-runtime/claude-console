import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'

const OPTIONS = { options: { activation: 'always', executor: 'codex', registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/companion.mjs', companionStateRoots: '["D:/State"]' } }
const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const STATE = 'D:/State/Project Alpha-hash/state.json'
const T = (iso: string) => Date.parse(iso)
const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'terminal',
  props: { title: 'Console', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any
const BAND = { plugin: 'console-status', component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: 120 } } as any

/** A CARD whose 更新 is `ms` in local time, as an executor writes it. */
const card = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `<!-- CARD -->\n- 更新：${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}\n- 狀態：進行中\n- 等使用者：無\n- 下一步：無\n<!-- /CARD -->`
}
const job = (id: string, prompt: string, status: string, startedAt: string, completedAt?: string) =>
  ({ id, jobClass: 'task', status, startedAt, ...(completedAt ? { completedAt } : {}), request: { prompt } })
const CONTINUE = '依 STATUS CARD 的下一步繼續；遵守任務骨架；結束時更新 CARD（含關卡欄）\nSTATUS：x'

function harness(on: any, jobs: any[], cardMs: number) {
  const clock = mock.clock(on, { now: T('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/.console/STATUS.md` |',
    [STATUS]: card(cardMs),
    'C:/Users/example/.claude/handoffs/dispatch.json': '{"executor":"codex","model":"","effort":""}',
    'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
  }
  const state = { jobs }
  const launches: string[][] = []
  const toasts: string[] = []
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    return { value: path === STATE ? JSON.stringify(state) : files[path] ?? '' }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', (_: any, e: any) => ({ value: fixturePath(e.path) === 'D:/State' ? [{ name: 'Project Alpha-hash', kind: 'dir' }] : [] }))
  on('process.run', (_: any, e: any) => {
    let stdout = e.argv[0] === 'claude' ? '[]' : 'OK codex=0.0.0-test'
    if (e.argv[0] === 'node' && e.argv.includes('task')) {
      launches.push([...e.argv])
      const id = `sync-${launches.length}`
      state.jobs = [...state.jobs, job(id, e.argv[e.argv.length - 1], 'running', new Date(clock.now()).toISOString())]
      stdout = JSON.stringify({ jobId: id })
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.open', () => ({ value: {} }))
  on('ui.toast', (_: any, e: any) => { toasts.push(String(e.text ?? JSON.stringify(e))); return { value: undefined } })
  return { clock, files, state, launches, toasts }
}

test('a Codex continue that wrote the CARD is not 待同步 and nothing is auto-synced', OPTIONS, async ($, on) => {
  // Started 11:00, wrote the CARD at 11:20, finished at 11:20:40: the old check (finished after 更新) called this unsynced.
  const h = harness(on, [job('work-1', CONTINUE, 'completed', '2030-01-05T11:00:00Z', '2030-01-05T11:20:40Z')], T('2030-01-05T11:20:00Z'))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /↻ 待同步 0/ })).toBeTruthy()
  expect(h.launches).toEqual([])
  await band.unmount()
})

test('finished work the CARD missed is synced once by itself, and the pane shows each step', OPTIONS, async ($, on) => {
  const h = harness(on, [job('work-1', CONTINUE, 'completed', '2030-01-05T11:00:00Z', '2030-01-05T11:30:00Z')], T('2030-01-05T10:00:00Z'))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.launches.length).toBe(1)
  expect(h.launches[0]!.at(-1)!.includes('只改 CARD 與歷程')).toBe(true)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  expect(await ui.find({ type: 'Text', text: '● 派工 ─ ◉ 執行 ─ ○ 寫回 STATUS' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^自動同步・codex 寫回中/ })).toBeTruthy()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^↻ 同步：執行中/ })).toBeTruthy()

  // Still running: no second dispatch.
  await h.clock.advance(20_000)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.launches.length).toBe(1)

  // The sync writes the CARD and finishes.
  h.files[STATUS] = card(T('2030-01-05T12:00:30Z'))
  h.state.jobs = h.state.jobs.map((item: any) => item.id === 'sync-1' ? { ...item, status: 'completed', completedAt: '2030-01-05T12:01:00Z' } : item)
  await h.clock.advance(60_000)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(await ui.find({ type: 'Text', text: '● 派工 ─ ● 執行 ─ ● 寫回 STATUS' })).toBeTruthy()
  expect(h.toasts.some(text => text.includes('自動同步・已寫回 STATUS'))).toBe(true)
  expect(await band.find({ type: 'Text', text: '↻ 同步完成' })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: /↻ 待同步 0/ })).toBeTruthy()
  expect(h.launches.length).toBe(1)
  await ui.unmount()
  await band.unmount()
})

test('a sync that ends without touching the CARD says so and is not sent again', OPTIONS, async ($, on) => {
  const h = harness(on, [job('work-1', CONTINUE, 'completed', '2030-01-05T11:00:00Z', '2030-01-05T11:30:00Z')], T('2030-01-05T10:00:00Z'))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.launches.length).toBe(1)
  h.state.jobs = h.state.jobs.map((item: any) => item.id === 'sync-1' ? { ...item, status: 'completed', completedAt: '2030-01-05T12:01:00Z' } : item)
  await h.clock.advance(60_000)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  expect(await ui.find({ type: 'Text', text: '● 派工 ─ ● 執行 ─ ✕ 寫回 STATUS' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /CARD 的「更新」沒有變/ })).toBeTruthy()
  await h.clock.advance(60_000)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.launches.length).toBe(1)
  await ui.unmount()
})

test('autoSync off leaves 待同步 for the person', { options: { ...OPTIONS.options, autoSync: 'off' } }, async ($, on) => {
  const h = harness(on, [job('work-1', CONTINUE, 'completed', '2030-01-05T11:00:00Z', '2030-01-05T11:30:00Z')], T('2030-01-05T10:00:00Z'))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.launches).toEqual([])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /↻ 待同步 1/ })).toBeTruthy()
  await band.unmount()
})
