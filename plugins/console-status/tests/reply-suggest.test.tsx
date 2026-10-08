import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { actionKinds, commandTarget, replyPrompt, suggestedPrompt } from '../hooks/actions'
import { buildProject } from '../hooks/logic'

const SETTINGS = 'C:/Users/example/.claude/handoffs/dispatch.json'
const SESSIONS = 'C:/Users/example/.claude/handoffs/claude-sessions.json'
const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const NOW = Date.parse('2030-01-05T12:00:00Z')
const OLD = '11111111-2222-4333-8444-555555555555'
const NEW = '66666666-7777-4888-8999-000000000000'
const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'terminal',
  props: { title: 'Console', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any
const BASE = { activation: 'always', registryPath: 'D:/Fixtures/registry.md', companionStateRoots: '["D:/State"]', gitProbe: 'off' }

const card = (next: string, ask = '無') => `<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：${ask}\n- 下一步：${next}\n<!-- /CARD -->`
/** A Claude job that finished its turn asking the person something, in the session it ran in. */
const askingJob = { id: 'ask-1111', launchName: 'console-old-0', nativeId: OLD.slice(0, 8), sessionId: OLD, root: 'D:/Project Alpha', prompt: 'work', kind: 'continue',
  startedAt: new Date(NOW - 3_600_000).toISOString(), completedAt: new Date(NOW - 60_000).toISOString(), status: 'completed', phase: 'idle: 等你回覆' }
const asker = { id: OLD.slice(0, 8), name: 'console-old-0', sessionId: OLD, cwd: 'D:/Project Alpha', kind: 'background', state: 'blocked', status: 'idle', pid: 4321, startedAt: NOW - 3_600_000 }

function fixture(on: any, opts: { asking?: boolean; next?: string } = {}) {
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    [SETTINGS]: '{"executor":"claude","model":"","effort":""}',
    [SESSIONS]: JSON.stringify({ version: 1, roots: opts.asking ? { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: OLD, jobs: [askingJob] } } : {} }),
    'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n| Project Alpha | \`${STATUS}\` |`,
    [STATUS]: card(opts.next ?? '無'),
  }
  const agents: any[] = opts.asking ? [asker] : []
  const launches: string[][] = []
  const suggests: string[] = []
  const fills: string[] = []
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in files)) throw Object.assign(new Error(`ENOENT: no such file ${path}`), { code: 'ENOENT' })
    return { value: files[path] }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = [...e.argv]
    let stdout = ''
    if (argv[1] === 'agents') stdout = JSON.stringify(agents)
    else if (argv[1] === 'logs') stdout = 'working\n'
    else if (argv.includes('--bg')) {
      launches.push(argv)
      // The resumed session comes back under a new id and takes over from the one that asked.
      agents.push({ id: NEW.slice(0, 8), sessionId: NEW, kind: 'background', cwd: 'D:/Project Alpha', state: 'working', status: 'busy', pid: 999, name: argv[argv.indexOf('--name') + 1], startedAt: NOW })
      stdout = NEW.slice(0, 8)
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.suggest', (_: any, e: any) => { suggests.push(e.text); return { isShown: true } })
  on('prompt.fill', (_: any, e: any) => { fills.push(e.text); return { isFilled: true } })
  return { files, launches, suggests, fills }
}

const ALPHA = { name: 'Project Alpha', statusPath: STATUS }
const snap = (projects: any[]) => ({ at: NOW, projects, blocked: [], codex: '', contextPercent: null, error: null }) as any
const askingProject = () => buildProject(ALPHA, card('無'), [{ id: 'j1', executor: 'claude', jobClass: 'task', status: 'completed', phase: 'idle: 等你回覆', sessionId: OLD, startedAt: '2030-01-05T09:00:00Z', completedAt: '2030-01-05T10:00:00Z', summary: 'work' }] as any, NOW)

test('an executor that stopped to ask can be replied to, before the sync, and only in the session that asked', () => {
  const p = askingProject()
  expect(actionKinds(p, 'ACTION').slice(0, 2)).toEqual(['reply', 'sync'])
  // Without the session it asked in, there is nothing to resume: sync and taking over stay.
  const lost = { ...p, jobs: p.jobs.map(j => ({ ...j, sessionId: undefined })) }
  expect(actionKinds(lost, 'ACTION')).not.toContain('reply')
  expect(actionKinds({ ...p, executor: 'manual' as const }, 'ACTION')).not.toContain('reply')
  const prompt = replyPrompt(p, '  用方案 B，先別動資料庫 ')
  expect(prompt.startsWith('使用者在主控台回覆你上一輪的提問：\n用方案 B，先別動資料庫\n')).toBe(true)
  expect(prompt).toContain(`STATUS：${STATUS}`)
  expect(prompt).toContain('不得執行正式環境變更或 release')
})

test('the Tab suggestion is the way on: decide, reply, gate, sync, then continue an idle project', () => {
  expect(suggestedPrompt(snap([buildProject(ALPHA, card('x', '選配色：A) 深 B) 淺'), [], NOW)]))).toBe('「Project Alpha」決策：')
  expect(suggestedPrompt(snap([askingProject()]))).toBe('/console reply Project Alpha ')
  expect(suggestedPrompt(snap([buildProject(ALPHA, card('x') + '\n', [], NOW)].map(p => ({ ...p, gate: 'review：看一下' }))))).toBe('/console gate Project Alpha')
  expect(suggestedPrompt(snap([buildProject(ALPHA, card('寫測試'), [], NOW)]))).toBe('/console continue Project Alpha')
  expect(suggestedPrompt(snap([buildProject(ALPHA, card('無'), [], NOW)]))).toBeNull()
  // An action already under way, demo data and a failed read propose nothing.
  expect(suggestedPrompt(snap([askingProject()]), { [STATUS]: { kind: 'reply', at: NOW } })).toBeNull()
  expect(suggestedPrompt({ ...snap([askingProject()]), demo: true })).toBeNull()
  expect(suggestedPrompt({ ...snap([askingProject()]), error: 'x' })).toBeNull()
})

test('a command names its project by the longest name it starts with, or by a unique first word', () => {
  const projects = [{ name: 'Project Alpha' }, { name: 'Project Alpha Two' }, { name: 'api' }]
  expect(commandTarget(projects, 'Project Alpha Two 好')).toEqual({ project: projects[1], text: '好' })
  expect(commandTarget(projects, 'project alpha 用 B')).toEqual({ project: projects[0], text: '用 B' })
  expect(commandTarget(projects, 'ap 繼續')).toEqual({ project: projects[2], text: '繼續' })
  // "Project" alone fits two projects: none is guessed.
  expect(commandTarget(projects, 'Proj 好')).toBeNull()
  expect(commandTarget(projects, '')).toBeNull()
})

test('↩ 回覆 fills the prompt box; /console reply resumes the session that asked with the words as its prompt', { options: BASE }, async ($, on) => {
  const h = fixture(on, { asking: true })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  // The way on is offered as the box's Tab suggestion.
  expect(h.suggests).toEqual(['/console reply Project Alpha '])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /執行者在等你回覆：↩ 回覆或同步/ })).toBeDefined()
  await ui.post({ menu: 'Project Alpha' }, { in: 'rows' } as any)
  expect(await ui.find({ type: 'Text', text: /r 回覆執行者/ })).toBeDefined()
  await ui.post({ key: 'r' }, { in: 'rows' } as any)
  // A key handler starts the action without waiting for it.
  for (let i = 0; i < 20 && !h.fills.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(h.fills).toEqual(['/console reply Project Alpha '])
  expect(h.launches).toEqual([])
  await ui.unmount()

  const result = JSON.stringify(await $.command.run({ command: 'console', args: 'reply Project Alpha 用方案 B，先別動資料庫' } as any))
  expect(result).toContain('Project Alpha：↩ 回覆執行者')
  expect(h.launches.length).toBe(1)
  const argv = h.launches[0]!
  expect(argv.slice(0, 2)).toEqual(['claude', '--bg'])
  expect(argv[argv.indexOf('--resume') + 1]).toBe(OLD)
  expect(argv.at(-1)!.startsWith('使用者在主控台回覆你上一輪的提問：\n用方案 B，先別動資料庫')).toBe(true)
  // The reply is work, so its result is synced like a continue's.
  const saved = JSON.parse(h.files[SESSIONS]!).roots['d:/project alpha']
  expect(saved.jobs.at(-1).kind).toBe('continue')
})

test('/console continue dispatches at once: sending the command is the confirmation', { options: BASE }, async ($, on) => {
  const h = fixture(on, { next: '寫測試' })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.suggests).toEqual(['/console continue Project Alpha'])
  await $.command.run({ command: 'console', args: 'continue Project Alpha' } as any)
  expect(h.launches.length).toBe(1)
  expect(h.launches[0]!.at(-1)!.startsWith('依 STATUS CARD 的下一步繼續')).toBe(true)
  const usage = JSON.stringify(await $.command.run({ command: 'console', args: 'reply Project Alpha' } as any))
  expect(usage).toContain('專案名稱後面接回覆內容')
  expect(JSON.stringify(await $.command.run({ command: 'console', args: 'sync Nope' } as any))).toContain('找不到專案「Nope」')
})

test('suggestNext: off leaves the prompt box alone', { options: { ...BASE, suggestNext: 'off' } }, async ($, on) => {
  const h = fixture(on, { asking: true })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(h.suggests).toEqual([])
})
