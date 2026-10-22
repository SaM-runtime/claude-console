import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { RETRY_REPLY, actionLabel, askingError, attachTabArgs, attachTarget, stopArgs, suggestedPrompt } from '../hooks/actions'
import { executorErrorText, transcriptApiError } from '../hooks/executors'
import { buildProject, jobResult, rows } from '../hooks/logic'

const SETTINGS = 'C:/Users/example/.claude/handoffs/dispatch.json'
const SESSIONS = 'C:/Users/example/.claude/handoffs/claude-sessions.json'
const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const NOW = Date.parse('2030-01-05T12:00:00Z')
const OLD = '11111111-2222-4333-8444-555555555555'
const NEW = '66666666-7777-4888-8999-000000000000'
const SHORT = OLD.slice(0, 8)
const RECORD = `C:/Users/example/.claude/jobs/${SHORT}/state.json`
const TRANSCRIPT = 'C:/Users/example/.claude/projects/D--Project-Alpha/11111111.jsonl'
const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'terminal',
  props: { title: 'Console', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any
const BASE = { activation: 'always', registryPath: 'D:/Fixtures/registry.md', companionStateRoots: '["D:/State"]', gitProbe: 'off' }

const card = (next: string) => `<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：無\n- 下一步：${next}\n<!-- /CARD -->`
const line = (entry: Record<string, unknown>) => JSON.stringify(entry)
const userTurn = line({ type: 'user', message: { role: 'user', content: '繼續' } })
const apiError = (text: string, error = 'authentication_failed', status = 401) =>
  line({ type: 'assistant', isApiErrorMessage: true, error, apiErrorStatus: status, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const reply = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

test('an API error that ended a turn is read from the transcript and said in words', () => {
  expect(transcriptApiError([userTurn, apiError('Invalid API key · Fix external API key')].join('\n')))
    .toEqual({ code: 'authentication_failed', message: 'Invalid API key · Fix external API key' })
  // Only the last assistant entry counts: an error the session got past is history.
  expect(transcriptApiError([apiError('Invalid API key'), userTurn, reply('要我先跑測試嗎？')].join('\n'))).toBeNull()
  expect(transcriptApiError('not json\n')).toBeNull()

  expect(executorErrorText({ code: 'authentication_failed', message: 'Invalid API key · Fix external API key' })).toBe('API key 無效（先檢查金鑰設定）')
  expect(executorErrorText({ code: 'authentication_failed', message: 'OAuth token has expired' })).toBe('登入失效（先在終端機重新登入）')
  expect(executorErrorText(null, 'login required: run /login')).toBe('登入失效（先在終端機重新登入）')
  expect(executorErrorText({ code: 'rate_limit', message: "You've hit your usage limit · resets 3pm (Asia/Taipei)" })).toBe('額度用完（3pm (Asia/Taipei) 重置）')
  expect(executorErrorText({ code: '429', message: 'Too many requests' })).toBe('額度用完')
  expect(executorErrorText({ code: 'server_error', message: 'Overloaded' })).toBe('服務出錯：Overloaded')
  // A real question, with nothing in the daemon's note either, is no error.
  expect(executorErrorText(null, '')).toBeNull()
  expect(executorErrorText(null, 'needs your answer')).toBeNull()
})

const ALPHA = { name: 'Project Alpha', statusPath: STATUS }
const asking = (extra: Record<string, unknown> = {}) => buildProject(ALPHA, card('無'), [{ id: 'console-a:tok1', executor: 'claude', nativeId: SHORT, jobClass: 'task', status: 'completed',
  phase: 'idle: 等你回覆', sessionId: OLD, startedAt: '2030-01-05T09:00:00Z', completedAt: '2030-01-05T10:00:00Z', summary: 'work', ...extra }] as any, NOW)
const snap = (projects: any[]) => ({ at: NOW, projects, blocked: [], codex: '', contextPercent: null, error: null }) as any

test('an executor an error stopped is not "waiting on you": the row, toast and Tab suggestion say what broke, and reply becomes retry', () => {
  const failed = asking({ error: '額度用完' })
  expect(askingError(failed)).toBe('額度用完')
  expect(rows(snap([failed]))[0]).toMatchObject({ state: 'ACTION', item: '執行者出錯：額度用完' })
  expect(actionLabel('reply', failed)).toBe('↻ 重試')
  expect(jobResult('completed', true, '額度用完')).toEqual({ label: '出錯：額度用完', followup: '', event: '出錯：額度用完', tone: 'red', kind: 'failed' })
  expect(suggestedPrompt(snap([failed]))).toBe(`/console reply Project Alpha ${RETRY_REPLY}`)
  // A real question keeps its words and its reply.
  const question = asking()
  expect(askingError(question)).toBeUndefined()
  expect(rows(snap([question]))[0]!.item).toContain('執行者在等你回覆')
  expect(actionLabel('reply', question)).toBe('↩ 回覆執行者')
  expect(suggestedPrompt(snap([question]))).toBe('/console reply Project Alpha ')
})

test('stop and attach name the right session: claude stop / attach by short id, Codex by the companion with its folder', () => {
  const running = (executor: 'claude' | 'codex', nativeId?: string) => ({ kind: 'running' as const, id: executor === 'codex' ? 'task-9' : 'console-a:tok2', executor, status: 'running', summary: '', ...(nativeId ? { nativeId } : {}) })
  expect(stopArgs(running('claude', 'abcd1234'), '', 'D:/Project Alpha')).toEqual(['claude', 'stop', 'abcd1234'])
  // A job the daemon has not named yet cannot be stopped by id.
  expect(stopArgs(running('claude'), '', 'D:/Project Alpha')).toBeNull()
  expect(stopArgs(running('codex'), 'D:/Tools/companion.mjs', 'D:/Project Alpha')).toEqual(['node', 'D:/Tools/companion.mjs', 'cancel', 'task-9', '--cwd', 'D:/Project Alpha', '--json'])
  expect(stopArgs(running('codex'), '', 'D:/Project Alpha')).toBeNull()

  const p = asking()
  expect(attachTarget(p)).toBe(SHORT)
  // A running Claude session comes first; Codex has no session to attach to.
  expect(attachTarget({ ...p, jobs: [running('claude', 'abcd1234'), ...p.jobs] })).toBe('abcd1234')
  expect(attachTarget({ ...p, jobs: [running('codex')] })).toBeUndefined()
  expect(attachTabArgs('D:/Project Alpha', 'abcd1234')).toEqual(['wt', '-w', '0', 'new-tab', '-d', 'D:\\Project Alpha', 'cmd', '/k', 'claude', 'attach', 'abcd1234'])
})

type Opts = { mode: 'error' | 'question' | 'running'; env?: Record<string, string>; stopFails?: boolean }

function fixture(on: any, opts: Opts) {
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local', ...opts.env })
  const job = opts.mode === 'running'
    ? { id: 'console-old-0:run1', launchName: 'console-old-0', nativeId: SHORT, sessionId: OLD, root: 'D:/Project Alpha', prompt: 'work', kind: 'continue', startedAt: new Date(NOW - 600_000).toISOString(), status: 'running', phase: 'running' }
    : { id: 'console-old-0:ask1', launchName: 'console-old-0', nativeId: SHORT, sessionId: OLD, root: 'D:/Project Alpha', prompt: 'work', kind: 'continue',
      startedAt: new Date(NOW - 3_600_000).toISOString(), completedAt: new Date(NOW - 120_000).toISOString(), status: 'completed', phase: 'idle: 等你回覆' }
  const files: Record<string, string> = {
    [SETTINGS]: '{"executor":"claude","model":"","effort":""}',
    [SESSIONS]: JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: OLD, jobs: [job] } } }),
    'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n| Project Alpha | \`${STATUS}\` |`,
    [STATUS]: card(opts.mode === 'running' ? '寫測試' : '無'),
    [RECORD]: JSON.stringify({ state: 'blocked', linkScanPath: TRANSCRIPT, needs: '' }),
    [TRANSCRIPT]: [userTurn, opts.mode === 'error' ? apiError('Invalid API key · Fix external API key') : reply('要用方案 A 還是 B？')].join('\n'),
  }
  const agents: any[] = [opts.mode === 'running'
    ? { id: SHORT, name: 'console-old-0', sessionId: OLD, cwd: 'D:/Project Alpha', kind: 'background', state: 'working', status: 'busy', pid: 4321, startedAt: NOW - 600_000 }
    : { id: SHORT, name: 'console-old-0', sessionId: OLD, cwd: 'D:/Project Alpha', kind: 'background', state: 'blocked', status: 'idle', pid: 4321, startedAt: NOW - 3_600_000 }]
  const runs: string[][] = []
  const launches: string[][] = []
  const copies: string[] = []
  const fills: string[] = []
  const toasts: string[] = []
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' })
    return { value: files[path] }
  })
  on('fs.stat', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    // The CARD was last written at 08:00, before the job: its work is not synced yet.
    return { value: { kind: 'file', size: files[path]!.length, mtimeMs: path === STATUS ? NOW - 4 * 3_600_000 : NOW - 120_000, isLink: false } }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = [...e.argv]
    let stdout = ''
    let exitCode = 0
    if (argv[1] === 'agents') stdout = JSON.stringify(agents)
    else if (argv[1] === 'logs') stdout = '● Bash(npm test)\n'
    else if (argv.includes('--bg')) {
      launches.push(argv)
      agents.push({ id: NEW.slice(0, 8), sessionId: NEW, kind: 'background', cwd: 'D:/Project Alpha', state: 'working', status: 'busy', pid: 999, name: argv[argv.indexOf('--name') + 1], startedAt: NOW })
      stdout = NEW.slice(0, 8)
    } else {
      runs.push(argv)
      if (argv[1] === 'stop') {
        if (opts.stopFails) { exitCode = 1; return { value: { exitCode, stdout: '', stderr: 'no such session', isStdoutTruncated: false, isStderrTruncated: false } } }
        agents[0] = { ...agents[0], state: 'stopped', status: 'stopped' }
      }
    }
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text ?? JSON.stringify(e)); return { value: undefined } })
  on('ui.copy', (_: any, e: any) => { copies.push(e.text); return { value: { isCopied: true } } })
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.fill', (_: any, e: any) => { fills.push(e.text); return { isFilled: true } })
  return { files, runs, launches, copies, fills, toasts }
}

const settle = async (done: () => boolean) => { for (let i = 0; i < 50 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10)) }

test('an executor whose turn hit an API error shows why; ↻ 重試 resumes its session after a second press', { options: BASE }, async ($, on) => {
  const h = fixture(on, { mode: 'error' })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /執行者出錯：API key 無效/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /執行者在等你回覆/ })).toBeUndefined()
  await ui.post({ menu: 'Project Alpha' }, { in: 'rows' } as any)
  expect(await ui.find({ type: 'Text', text: /r 重試/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /t 接手對話/ })).toBeDefined()
  // The first press only arms the retry, and says what it will do.
  await ui.post({ key: 'r' }, { in: 'rows' } as any)
  await settle(() => h.toasts.some(t => t.includes('再按一次重試')))
  expect(h.toasts.some(t => t.includes('上次API key 無效（先檢查金鑰設定）；6 秒內再按一次重試'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /再按一次將重試（上次API key 無效/ })).toBeDefined()
  expect(h.launches).toEqual([])
  await ui.post({ key: 'r' }, { in: 'rows' } as any)
  await settle(() => h.launches.length > 0)
  expect(h.fills).toEqual([])
  expect(h.launches.length).toBe(1)
  const argv = h.launches[0]!
  expect(argv[argv.indexOf('--resume') + 1]).toBe(OLD)
  expect(argv.at(-1)!).toContain(RETRY_REPLY)
  await ui.unmount()
})

test('a real question is still a question: no error read from a plain reply, ↩ 回覆 fills the box', { options: BASE }, async ($, on) => {
  const h = fixture(on, { mode: 'question' })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /執行者在等你回覆/ })).toBeDefined()
  await ui.post({ menu: 'Project Alpha' }, { in: 'rows' } as any)
  await ui.post({ key: 'r' }, { in: 'rows' } as any)
  await settle(() => h.fills.length > 0)
  expect(h.fills).toEqual(['/console reply Project Alpha '])
  expect(h.launches).toEqual([])
  await ui.unmount()
})

test('■ 停止工作 runs claude stop for the running job after a second press', { options: BASE }, async ($, on) => {
  const h = fixture(on, { mode: 'running' })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  expect((await ui.find({ key: 'detail-Project Alpha-stop' }))?.text).toBe('■ 停止工作')
  expect((await ui.find({ key: 'detail-Project Alpha-attach' }))?.text).toBe('↗ 接手對話')
  await ui.press({ key: 'detail-Project Alpha-stop' })
  expect(h.runs.filter(argv => argv[1] === 'stop')).toEqual([])
  expect((await ui.find({ key: 'detail-Project Alpha-stop' }))?.text).toBe('再按一次停止')
  expect(await ui.find({ type: 'Text', text: /再按一次將停止：claude 工作/ })).toBeDefined()
  await ui.press({ key: 'detail-Project Alpha-stop' })
  expect(h.runs.filter(argv => argv[1] === 'stop')).toEqual([['claude', 'stop', SHORT]])
  expect(h.toasts.some(t => t.includes('已停止工作'))).toBe(true)
  // Stopped, the job no longer locks the project.
  expect(await ui.find({ key: 'detail-Project Alpha-stop' })).toBeUndefined()
  await ui.unmount()
})

test('a stop that fails says so with what the command said', { options: BASE }, async ($, on) => {
  const h = fixture(on, { mode: 'running', stopFails: true })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.post({ menu: 'Project Alpha' }, { in: 'rows' } as any)
  expect(await ui.find({ type: 'Text', text: /x 停止工作/ })).toBeDefined()
  await ui.post({ key: 'x' }, { in: 'rows' } as any)
  await settle(() => h.toasts.some(t => t.includes('再按一次停止')))
  await ui.post({ key: 'x' }, { in: 'rows' } as any)
  await settle(() => h.toasts.some(t => t.includes('停止失敗')))
  expect(h.toasts.some(t => t.includes('停止失敗：claude（no such session）'))).toBe(true)
  await ui.unmount()
})

test('↗ 接手對話 copies claude attach outside Windows Terminal', { options: BASE }, async ($, on) => {
  const h = fixture(on, { mode: 'running' })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'detail' })
  await ui.press({ key: 'detail-Project Alpha-attach' })
  expect(h.copies).toEqual([`claude attach ${SHORT}`])
  expect(h.runs.some(argv => argv[0] === 'wt')).toBe(false)
  expect(h.toasts.some(t => t.includes(`已複製「claude attach ${SHORT}」`))).toBe(true)
  await ui.unmount()
})

test('↗ 接手對話 opens a Windows Terminal tab in the project folder when the console runs in one', { options: BASE }, async ($, on) => {
  const h = fixture(on, { mode: 'running', env: { OS: 'Windows_NT', WT_SESSION: 'abc' } })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount(PANE)
  await ui.post({ menu: 'Project Alpha' }, { in: 'rows' } as any)
  await ui.post({ key: 't' }, { in: 'rows' } as any)
  await settle(() => h.runs.some(argv => argv[0] === 'wt'))
  expect(h.runs.find(argv => argv[0] === 'wt')).toEqual(attachTabArgs('D:/Project Alpha', SHORT))
  expect(h.copies).toEqual([])
  await ui.unmount()
})
