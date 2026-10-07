import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { cardVerdict, pipeline, projectForCwd, progressContext, projectModeSection } from '../hooks/pipeline'
import { buildProject, projectRoot, verifyNote } from '../hooks/logic'
import type { Project } from '../types'

const base: Project = { name: 'Alpha', statusPath: 'D:/Alpha/.console/STATUS.md', hasCard: true, state: '', ask: '無', next: '', gate: '無', verify: '', verifyNote: '', updated: '', isStale: false, jobs: [] }
const at = (p: Partial<Project>, local?: any) => {
  const pl = pipeline({ ...base, ...p }, local)
  return { current: pl.current, strip: pl.stages.map(stage => stage.status[0]).join(''), note: pl.note }
}
const running = { kind: 'running' as const, id: 'j', status: 'running', summary: '' }
const newer = { kind: 'newer' as const, id: 'j', status: 'completed', summary: '' }

test('each workflow position maps to one current stage; earlier stages are done', () => {
  // strip letters: d done · a active · w wait · f fail · t todo  (spec build sync verify review release)
  expect(at({ hasCard: false })).toEqual({ current: null, strip: 'tttttt', note: 'STATUS 卡不存在' })
  expect(at({ gate: 'spec：approve acceptance' })).toEqual({ current: 'spec', strip: 'wttttt', note: '待主控台審核 spec 關卡' })
  expect(at({ gate: 'spec：tests', jobs: [running] }).strip).toBe('attttt')
  expect(at({ next: 'Implement parser', jobs: [running] })).toEqual({ current: 'build', strip: 'datttt', note: '執行者實作中' })
  expect(at({ jobs: [newer] }).strip).toBe('ddwttt')
  expect(at({ gate: 'review：diff + tests green' }).strip).toBe('ddddwt')
  expect(at({ gate: 'review：x', jobs: [running] })).toEqual({ current: 'review', strip: 'ddddat', note: '審核任務執行中' })
  expect(at({ gate: 'release：v1 scope' })).toEqual({ current: 'release', strip: 'dddddw', note: '待使用者核准上線範圍' })
  expect(at({ next: 'Write the importer' })).toEqual({ current: 'build', strip: 'dwtttt', note: '待繼續：Write the importer' })
  expect(at({ next: '無' })).toEqual({ current: null, strip: 'tttttt', note: '閒置' })
  // A none word with a note in brackets is still nothing to continue.
  for (const next of ['無（等使用者決定）', '無(等決策)', '沒有（暫停）', 'none (waiting)'])
    expect([next, at({ next }).current]).toEqual([next, null])
})

test('verification is evidence: a failure shows wherever the work stands, a pass completes the build side', () => {
  expect(at({ verify: 'npm test', verifyNote: 'FAIL 2 tests' })).toEqual({ current: 'verify', strip: 'dddftt', note: '驗證未通過' })
  expect(at({ verify: 'npm test', verifyNote: 'PASS', next: '無' }).strip).toBe('ddddtt')
  expect(at({ verify: 'npm test', verifyNote: 'PASS', gate: 'review：x' }).strip).toBe('ddddwt')
  expect(at({ verify: 'npm test', verifyNote: 'FAIL', gate: 'review：x' }).strip).toBe('dddfwt')
  // The console's own latest run of the same command wins over what the CARD says.
  expect(at({ verify: 'npm test', verifyNote: 'PASS', next: 'x' }, { command: 'npm test', ok: false }).current).toBe('verify')
  expect(at({ verify: 'npm test', verifyNote: 'FAIL' }, { command: 'npm test', ok: true }).current).toBe(null)
  expect(at({ verify: 'npm test', verifyNote: 'FAIL' }, { command: 'old cmd', ok: true }).current).toBe('verify')
})

test('a decision for the user holds the current stage', () => {
  expect(at({ ask: 'Pick a colour', next: 'x' })).toEqual({ current: 'build', strip: 'dwtttt', note: '需決策：Pick a colour' })
  expect(at({ ask: 'Ship it?', gate: 'release：v1' }).current).toBe('release')
})

test('CARD verdict text and the 驗證 line parse', () => {
  expect(verifyNote('`php tests/run.php` → PASS')).toBe('PASS')
  expect(verifyNote('`a -> b` -> FAIL; verified 2030-01-01')).toBe('FAIL; verified 2030-01-01')
  expect(verifyNote('`npm test` ok')).toBe('ok')
  expect(verifyNote('npm test')).toBe('')
  expect(cardVerdict('3 passed, 1 failed')).toBe('fail')
  expect(cardVerdict('PASS; verified 2030-01-01 10:00')).toBe('pass')
  expect(cardVerdict('通過')).toBe('pass')
  expect(cardVerdict('not run yet')).toBe(null)
  // Zero counts are not failures; any other count still is.
  for (const note of ['214 pass, 0 fail', '874 passed, 0 failed', 'PASS (failures: 0)', '12 passed, 0 errors', '全部通過，0 個失敗'])
    expect([note, cardVerdict(note)]).toEqual([note, 'pass'])
  for (const note of ['213 pass, 1 fail', '3 passed, 10 failed', 'failures: 2', '0 skipped, 1 failed'])
    expect([note, cardVerdict(note)]).toEqual([note, 'fail'])
  expect(buildProject({ name: 'A', statusPath: 'D:/A/STATUS.md' } as any, '<!-- CARD -->\n- 驗證：`npm test` → FAIL\n<!-- /CARD -->', [], 0).verifyNote).toBe('FAIL')
})

test('project mode finds the deepest registered root containing the session directory', () => {
  const projects = [{ statusPath: 'D:/Work/.console/STATUS.md' }, { statusPath: 'D:/Work/Alpha/.console/STATUS.md' }, { statusPath: '/home/me/beta/STATUS.md' }]
  expect(projectForCwd(projects, 'd:\\work\\alpha\\src', projectRoot)).toBe(projects[1])
  expect(projectForCwd(projects, 'D:/Work', projectRoot)).toBe(projects[0])
  expect(projectForCwd(projects, 'D:/Workshop', projectRoot)).toBe(null)
  expect(projectForCwd(projects, '/home/me/beta', projectRoot)).toBe(projects[2])
  expect(projectForCwd(projects, '/home/me/Beta', projectRoot)).toBe(null)
  expect(projectForCwd(projects, null, projectRoot)).toBe(null)
})

test('the system prompt section depends only on the project identity; progress carries the live state', () => {
  const p = { ...base, next: 'Write tests', gate: 'review：x' }
  expect(projectModeSection(p)).toBe(projectModeSection({ ...base, next: 'Something else', jobs: [running] } as Project))
  expect(projectModeSection(p)).toContain('STATUS：D:/Alpha/.console/STATUS.md')
  const text = progressContext(p, pipeline(p))
  expect(text).toContain('審核◆')
  expect(text).toContain('CARD 下一步：Write tests')
  expect(text).toContain('關卡：review：x')
})

// ── UI: project mode in a session opened inside a registered project ──

const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const OPTIONS = { options: { activation: 'always', executor: 'claude', registryPath: 'D:/Fixtures/registry.md' } }
const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile',
  props: { title: 'Console', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any
const BAND = { plugin: 'console-status', component: 'AbovePrompt', surface: 'mobile', props: { bodyColumns: 120 } } as any

function fixture(on: any) {
  const clock = mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', OS: 'Windows_NT' })
  const card = { text: '- 狀態：Parser half done\n- 下一步：Finish the parser\n- 驗證：`node test.mjs` → PASS\n- 關卡：無' }
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    const files: Record<string, string> = {
      'D:/Fixtures/registry.md': `## STATUS 卡位置\n| Project Alpha | \`${STATUS}\` |\n| Project Beta | \`D:/Project Beta/STATUS.md\` |`,
      [STATUS]: `<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：無\n${card.text}\n<!-- /CARD -->`,
      'D:/Project Beta/STATUS.md': '<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 等使用者：Choose a name\n<!-- /CARD -->',
      'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
    }
    if (!(path in files)) throw new Error('missing')
    return { value: files[path] }
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', () => ({ value: null } as any))
  on('session.id', () => ({ value: 'session' }))
  on('ui.toast', () => ({ value: undefined }) as any)
  on('store.get', () => ({ value: null }))
  on('command.register', () => ({ value: undefined }) as any)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [{ id: 'engine', text: 'base', scope: 'shared' }] }))
  const submitted: any[] = []
  on('prompt.submit', (_: any, e: any) => { submitted.push(e); return { text: e.text, context: e.context } })
  return { card, submitted, clock }
}

test('inside a registered project the band and pane follow that project\'s pipeline', OPTIONS, async ($, on) => {
  const { clock } = fixture(on)
  await $.session.start({ cwd: 'D:/Project Alpha/src', surface: 'terminal', isInteractive: true } as any)
  await clock.settle()
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'Project Alpha ' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /待繼續：Finish the parser/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /其他 1 個專案待處理/ })).toBeDefined()
  await band.unmount()
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /專案模式/ })).toBeDefined()
  expect(await pane.find({ key: 'pm-continue' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '◆ 實作' })).toBeDefined()
  await pane.unmount()
  // /console mode console turns it off for this session.
  expect(JSON.stringify(await $.command.run({ command: 'console', args: 'mode console' } as any))).toContain('主控台模式')
  const back = await $.ui.mount(BAND)
  expect(await back.find({ type: 'Text', text: /待繼續/ })).toBeUndefined()
  await back.unmount()
})

test('project mode adds a stable system prompt section and attaches progress only when it changes', OPTIONS, async ($, on) => {
  const { card, submitted, clock } = fixture(on)
  await $.session.start({ cwd: 'D:/Project Alpha', surface: 'terminal', isInteractive: true } as any)
  await clock.settle()
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const composed = await $.prompt.compose({ model: 'test-model', promptModel: 'test-model', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any) as any
  expect(composed.sections.map((section: any) => section.id)).toEqual(['engine', 'console-status:project'])
  expect(composed.sections[1].scope).toBe('session')
  await $.prompt.submit({ text: 'go on' } as any)
  await $.prompt.submit({ text: 'and more' } as any)
  expect(submitted[0].context?.some((c: string) => c.includes('【專案進度｜console-status】Project Alpha'))).toBe(true)
  expect(submitted[1].context ?? []).toEqual([])
  card.text = '- 狀態：Ready for review\n- 下一步：無\n- 驗證：`node test.mjs` → PASS\n- 關卡：review：parser done'
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(JSON.stringify((await $.prompt.compose({ model: 'test-model', promptModel: 'test-model', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any) as any).sections[1])).toBe(JSON.stringify(composed.sections[1]))
  await $.prompt.submit({ text: 'status?' } as any)
  expect(submitted[2].context?.some((c: string) => c.includes('關卡：review：parser done'))).toBe(true)
})

test('outside any registered project nothing is added to prompts', OPTIONS, async ($, on) => {
  const { submitted, clock } = fixture(on)
  await $.session.start({ cwd: 'D:/Console', surface: 'terminal', isInteractive: true } as any)
  await clock.settle()
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect((await $.prompt.compose({ model: 'test-model', promptModel: 'test-model', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any) as any).sections.map((section: any) => section.id)).toEqual(['engine'])
  await $.prompt.submit({ text: 'hello' } as any)
  expect(submitted[0].context ?? []).toEqual([])
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /專案模式/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '流程' })).toBeDefined()
  await pane.unmount()
})
