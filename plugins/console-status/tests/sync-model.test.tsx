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

function harness(on: any, jobs: any[], cardMs: number, dispatch: object, failModel?: string) {
  const statusMtime: number | undefined = undefined
  const clock = mock.clock(on, { now: T('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/.console/STATUS.md` |',
    [STATUS]: card(cardMs),
    'C:/Users/example/.claude/handoffs/dispatch.json': JSON.stringify({ executor: 'codex', model: '', effort: '', ...dispatch }),
    'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
  }
  const state = { jobs }
  const mtimes: Record<string, number> = statusMtime === undefined ? {} : { [STATUS]: statusMtime }
  on('fs.stat', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in mtimes)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
    return { value: { size: (files[path] ?? '').length, mtimeMs: mtimes[path] } }
  })
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
      if (failModel && e.argv.includes(failModel)) return { value: { exitCode: 1, stdout: '', stderr: `model ${failModel} is not available`, isStdoutTruncated: false, isStderrTruncated: false } }
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
  return { clock, files, state, launches, toasts, mtimes }
}


const WORK = () => [job('work-1', CONTINUE, 'completed', '2030-01-05T11:00:00Z', '2030-01-05T11:30:00Z')]
const model = (argv: string[]) => argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : ''

test('with no sync setting a sync dispatches exactly like before', OPTIONS, async ($, on) => {
  const h = harness(on, WORK(), T('2030-01-05T10:00:00Z'), {})
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.launches.length).toBe(1)
  expect(model(h.launches[0]!)).toBe('')
  expect(h.launches[0]!.includes('--resume-last')).toBe(true)
  expect(h.launches[0]!.at(-1)!.includes('這是新的 session')).toBe(false)
})

test('a Codex sync model is used for the sync only, resuming the session, and the notice names it', OPTIONS, async ($, on) => {
  const h = harness(on, WORK(), T('2030-01-05T10:00:00Z'), { model: 'big', sync: { codex: { model: 'luna', effort: 'low' } } })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.launches.length).toBe(1)
  expect(model(h.launches[0]!)).toBe('luna')
  expect(h.launches[0]![h.launches[0]!.indexOf('--effort') + 1]).toBe('low')
  expect(h.launches[0]!.includes('--resume-last')).toBe(true)
  expect(h.toasts.some(text => text.includes('（用 luna）'))).toBe(true)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  expect(await ui.find({ type: 'Text', text: /^自動同步・codex（luna） 寫回中/ })).toBeTruthy()
  await ui.unmount()
})

test('sync session fresh starts a new thread whose prompt says how to find the work and carries the digest', OPTIONS, async ($, on) => {
  const h = harness(on, WORK(), T('2030-01-05T10:00:00Z'), { sync: { session: 'fresh', codex: { model: 'luna' } } })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.launches[0]!.includes('--fresh')).toBe(true)
  const prompt = h.launches[0]!.at(-1)!
  expect(prompt.includes('只改 CARD 與歷程')).toBe(true)
  expect(prompt.includes('這是新的 session')).toBe(true)
  expect(prompt.includes('執行者摘要')).toBe(true)
})

test('a sync model that will not launch falls back to the normal model now and for later syncs', OPTIONS, async ($, on) => {
  const h = harness(on, WORK(), T('2030-01-05T10:00:00Z'), { sync: { codex: { model: 'luna' } } }, 'luna')
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.launches.map(model)).toEqual(['luna', ''])
  expect(h.toasts.some(text => text.includes('同步模型 luna 無法啟動'))).toBe(true)
  // The normal-model sync ends; the work still waits on a sync, and a manual one skips luna and says why.
  h.state.jobs = h.state.jobs.map((item: any) => item.id === 'sync-2' ? { ...item, status: 'completed', completedAt: '2030-01-05T12:01:00Z' } : item)
  await h.clock.advance(60_000)
  await $.command.run({ command: 'console', args: 'sync Project Alpha' } as any)
  expect(h.launches.map(model)).toEqual(['luna', '', ''])
  expect(h.toasts.some(text => text.includes('上次無法啟動，這次改用原本的模型'))).toBe(true)
  // Setting the sync model again gives it another try.
  await $.command.run({ command: 'console', args: 'sync-model codex luna' } as any)
  expect(JSON.parse(h.files['C:/Users/example/.claude/handoffs/dispatch.json']!).sync).toEqual({ codex: { model: 'luna' } })
})

test('a cheap sync that writes nothing warns, and later syncs use the normal model', OPTIONS, async ($, on) => {
  const h = harness(on, WORK(), T('2030-01-05T10:00:00Z'), { sync: { codex: { model: 'luna' } } })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  h.state.jobs = h.state.jobs.map((item: any) => item.id === 'sync-1' ? { ...item, status: 'completed', completedAt: '2030-01-05T12:01:00Z' } : item)
  await h.clock.advance(60_000)
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.toasts.some(text => text.includes('用 luna 同步沒寫回 STATUS，之後的同步改回原本的模型'))).toBe(true)
  await h.clock.advance(60_000)
  await $.command.run({ command: 'console', args: 'sync Project Alpha' } as any)
  expect(h.launches.map(model)).toEqual(['luna', ''])
})

test('/console sync-model, sync-effort and sync-session write dispatch.json and clear with ""', OPTIONS, async ($, on) => {
  const h = harness(on, [], T('2030-01-05T10:00:00Z'), { executor: 'claude' })
  const path = 'C:/Users/example/.claude/handoffs/dispatch.json'
  await $.command.run({ command: 'console', args: 'sync-model haiku' } as any)
  await $.command.run({ command: 'console', args: 'sync-effort codex low' } as any)
  await $.command.run({ command: 'console', args: 'sync-session resume' } as any)
  expect(JSON.parse(h.files[path]!).sync).toEqual({ claude: { model: 'haiku' }, codex: { effort: 'low' }, session: 'resume' })
  const shown = await $.command.run({ command: 'console', args: 'sync-model' } as any) as any
  expect(String(shown?.text ?? shown)).toContain('claude haiku｜codex low｜session resume')
  await $.command.run({ command: 'console', args: 'sync-model ""' } as any)
  await $.command.run({ command: 'console', args: 'sync-effort codex ""' } as any)
  await $.command.run({ command: 'console', args: 'sync-session ""' } as any)
  expect(JSON.parse(h.files[path]!).sync).toBeUndefined()
  const bad = await $.command.run({ command: 'console', args: 'sync-session sometimes' } as any) as any
  expect(String(bad?.text ?? bad)).toContain('設定未儲存')
})

test('the pane names the sync model, whose executor it belongs to, and when it runs in a new session', { options: { ...OPTIONS.options, autoSync: 'off' } }, async ($, on) => {
  const h = harness(on, WORK(), T('2030-01-05T10:00:00Z'), { executor: 'claude', sync: { claude: { model: 'haiku' } } })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: '同步模型' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '新 session' })).toBeTruthy()
  await ui.press({ key: 'dispatch-sync' })
  expect(await ui.find({ type: 'Text', text: '同步模型（claude）' })).toBeTruthy()
  await ui.press({ key: 'dispatch-sync-sonnet' })
  expect(JSON.parse(h.files['C:/Users/example/.claude/handoffs/dispatch.json']!).sync).toEqual({ claude: { model: 'sonnet' } })
  await ui.unmount()
})
