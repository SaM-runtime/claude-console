import { expect, test, mock } from 'claude-code/testing'
import { parseSettings, parseModels, nextOption, effortOptions, modelOptions, syncDispatch, setSyncSetting } from '../hooks/dispatch'
import { resolveConfig } from '../hooks/config'
import { fixturePath } from './fixture-path'

test('settings file round trip and failed write are observable through the filesystem API', async ($, on) => {
  const config = resolveConfig({}, 'C:/Users/example', '', '/tmp')
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? 'C:/Users/example' : undefined }))
  const files: Record<string, string> = {}
  let deny = false
  on('ui.toast', () => ({ value: undefined }) as any)
  on('fs.read', (_, e) => {
    const path = fixturePath(e.path)
    if (!(path in files)) throw new Error('missing')
    return { value: files[path] }
  })
  on('fs.write', (_, e) => {
    if (deny) throw new Error('read only')
    files[fixturePath(e.path)] = e.text
    return { value: undefined } as any
  })
  expect(JSON.stringify(await $.command.run({ command: 'console', args: 'model' } as any)).includes('claude · 預設')).toBe(true)
  await $.command.run({ command: 'console', args: 'model fiction-alpha' } as any)
  await $.command.run({ command: 'console', args: 'effort high' } as any)
  expect(JSON.parse(files[config.dispatchSettingsPath])).toEqual({ executor: 'claude', model: 'fiction-alpha', effort: 'high' })
  expect(JSON.stringify(await $.command.run({ command: 'console', args: 'model' } as any)).includes('fiction-alpha · high')).toBe(true)
  const invalid = await $.command.run({ command: 'console', args: 'effort impossible' } as any)
  expect(JSON.stringify(invalid).includes('effort 可選')).toBe(true)
  expect(JSON.parse(files[config.dispatchSettingsPath]).effort).toBe('high')
  deny = true
  const failure = await $.command.run({ command: 'console', args: 'effort low' } as any)
  expect(JSON.stringify(failure).includes('設定未儲存')).toBe(true)
  expect(JSON.parse(files[config.dispatchSettingsPath]).effort).toBe('high')
  deny = false
  await $.command.run({ command: 'console', args: 'model ""' } as any)
  await $.command.run({ command: 'console', args: 'effort ""' } as any)
  expect(JSON.parse(files[config.dispatchSettingsPath])).toEqual({ executor: 'claude', model: '', effort: '' })
})

test('dispatch settings recover malformed fields but preserve explicit empty defaults', () => {
  const defaults = { executor: 'claude' as const, model: 'fiction-alpha', effort: 'high' }
  expect(parseSettings('{', defaults)).toEqual(defaults)
  expect(parseSettings('null', defaults)).toEqual(defaults)
  expect(parseSettings('{"executor":"bad","model":"","effort":42}', defaults)).toEqual({ executor: 'claude', model: '', effort: 'high' })
  expect(parseSettings('{"executor":"codex","model":" fiction-beta ","effort":"low"}', defaults)).toEqual({ executor: 'codex', model: 'fiction-beta', effort: 'low' })
})

test('fictional cache preserves model and effort order, ignores malformed and duplicate entries', () => {
  const models = parseModels(JSON.stringify({ models: [null, {}, { slug: 'fiction-alpha', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }, null] }, { slug: 'fiction-beta' }, { slug: 'fiction-alpha' }] }))
  expect(models).toEqual([{ model: 'fiction-alpha', efforts: ['high', 'max'] }, { model: 'fiction-beta', efforts: [] }])
  expect(modelOptions('codex', models)).toEqual(models)
  expect(modelOptions('claude', models).map(option => option.model)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  expect(effortOptions('codex', models, 'fiction-alpha')).toEqual(['high', 'max'])
  expect(effortOptions('codex', models, 'unknown')).toEqual(['low', 'medium', 'high', 'xhigh'])
  expect(effortOptions('claude', models, 'opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  for (const text of ['{', 'null', '{}', '{"models":{}}']) expect(parseModels(text)).toEqual([])
  expect(nextOption('fiction-alpha', models.map(m => m.model))).toBe('fiction-beta')
  expect(nextOption('fiction-beta', models.map(m => m.model))).toBe('fiction-alpha')
  expect(nextOption('', ['low', 'medium'])).toBe('low')
  expect(nextOption('custom', [])).toBe('custom')
})

test('terminal and mobile labels spread out their choices and persist the one picked, including model-specific efforts', {
  options: { executor: 'codex' },
}, async ($, on) => {
  mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  let settings = '{"executor":"codex","model":"fiction-alpha","effort":"high"}'
  let cache = JSON.stringify({ models: [
    { slug: 'fiction-alpha', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    { slug: 'fiction-beta', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }] },
  ] })
  const toasts: string[] = []
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? 'C:/Users/example' : undefined }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('models_cache.json') ? cache : settings }))
  on('fs.write', (_, e) => { settings = e.text; return { value: undefined } as any })
  on('ui.toast', (_, e) => { toasts.push(JSON.stringify(e)); return { value: undefined } as any })
  on('ui.open', () => ({ value: {} }) as any)
  await $.command.run({ command: 'console', args: 'demo' } as any)
  for (const surface of ['terminal', 'mobile']) {
    settings = '{"executor":"codex","model":"fiction-alpha","effort":"high"}'
    const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface,
      props: { title: 'Console', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
    // Demo data shows default settings until a write reads the real file.
    await $.command.run({ command: 'console', args: 'effort high' } as any)
    // A label spreads its choices out; the current one is bracketed, 預設 is the executor's own default.
    await ui.press({ key: 'dispatch-model' })
    expect((await ui.find({ key: 'dispatch-model-fiction-alpha' }))?.text).toBe('[fiction-alpha]')
    expect((await ui.find({ key: 'dispatch-model-default' }))?.text).toBe('預設')
    await ui.press({ key: 'dispatch-model-fiction-beta' })
    expect(JSON.parse(settings)).toEqual({ executor: 'codex', model: 'fiction-beta', effort: '' })
    expect(await ui.find({ key: 'dispatch-picker' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'dispatch-model' } as any)).toBeDefined()
    // Efforts follow the chosen model.
    await ui.press({ key: 'dispatch-effort' })
    expect(await ui.find({ key: 'dispatch-picker' })).toBeDefined()
    expect(await ui.find({ key: 'dispatch-effort-high' })).toBeUndefined()
    await ui.press({ key: 'dispatch-effort-max' })
    expect(JSON.parse(settings).effort).toBe('max')
    // The chosen value, ✕ or the label again close the choices without writing.
    const before = settings
    await ui.press({ key: 'dispatch-effort' })
    await ui.press({ key: 'dispatch-effort-max' })
    expect(await ui.find({ key: 'dispatch-picker' })).toBeUndefined()
    await ui.press({ key: 'dispatch-effort' })
    await ui.press({ key: 'dispatch-picker-close' })
    expect(await ui.find({ key: 'dispatch-picker' })).toBeUndefined()
    await ui.press({ key: 'dispatch-effort' })
    await ui.press({ key: 'dispatch-effort' })
    expect(await ui.find({ key: 'dispatch-picker' })).toBeUndefined()
    expect(settings).toBe(before)
    await ui.press({ key: 'dispatch-effort' })
    await ui.press({ key: 'dispatch-effort-default' })
    expect(JSON.parse(settings).effort).toBe('')
    await ui.press({ key: 'dispatch-model' })
    await ui.press({ key: 'dispatch-model-default' })
    expect(JSON.parse(settings)).toEqual({ executor: 'codex', model: '', effort: '' })
    // Without a readable model cache: the default, a model typed with /console model, and how to type one.
    cache = '{'
    await $.command.run({ command: 'console', args: 'model custom-x' } as any)
    await ui.press({ key: 'dispatch-model' })
    expect((await ui.find({ key: 'dispatch-model-custom-x' }))?.text).toBe('[custom-x]')
    expect(await ui.find({ key: 'dispatch-model-fiction-alpha' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /\/console model/ })).toBeDefined()
    await ui.press({ key: 'dispatch-picker-close' })
    cache = JSON.stringify({ models: [{ slug: 'fiction-alpha', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }, { slug: 'fiction-beta', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }] }] })
    await ui.unmount()
  }
})

test('row sync trigger reads latest file and omits each empty dispatch flag independently', {
  options: { autoSync: 'off', companionScript: 'D:/Tools/run.mjs', executor: 'codex' },
}, async ($, on) => {
  let settings = '{"executor":"codex","model":"fiction-current","effort":"high"}'
  let dispatched: string[] = []
  let launched = 0
  let completedJobs = '{"jobs":[{"id":"fixture-result","jobClass":"task","status":"completed","completedAt":"2030-01-05T11:00:00Z"}]}'
  mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  on('env.get', () => ({ value: 'C:/Users/example' }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('projects-scope.md') ? '## STATUS 卡位置\n| Demo Fixture | `D:/demo/STATUS.md` |'
    : e.path.endsWith('STATUS.md') ? '<!-- CARD -->\n- 更新：2030-01-04 08:00\n- 等使用者：無\n<!-- /CARD -->'
    : e.path.endsWith('state.json') ? completedJobs : e.path.endsWith('claude-sessions.json') ? '{"version":1,"roots":{}}' : e.path.endsWith('models_cache.json') ? '{}' : settings }))
  on('fs.list', () => ({ value: [{ name: 'demo-hash', kind: 'dir' }] }))
  on('ui.open', () => ({ value: {} }) as any)
  on('ui.toast', () => ({ value: undefined }) as any)
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'fixture-session' }))
  on('process.run', (_, e) => {
    // Codex dispatch first asks whether there is a thread to resume; these tests count only the dispatch itself.
    if (e.argv.includes('task-resume-candidate')) return { value: { exitCode: 0, stdout: '{"available":true}', stderr: '' } }
    if (e.argv[0] !== 'node') return { value: { exitCode: 0, stdout: e.argv[0] === 'claude' ? '[]' : 'OK codex=0.0.0-test', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    dispatched = [...e.argv]
    // The sync itself never needs syncing; leave other finished work behind so the next round offers sync again.
    launched++
    completedJobs = `{"jobs":[{"id":"sync-${launched}","jobClass":"task","status":"completed","completedAt":"2030-01-05T11:00:00Z"},{"id":"other-${launched}","jobClass":"task","status":"completed","completedAt":"2030-01-05T11:00:00Z"}]}`
    return { value: { exitCode: 0, stdout: `{"jobId":"sync-${launched}"}`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'terminal',
    props: { title: 'Console', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  for (const [model, effort, flags] of [
    ['fiction-new', 'high', ['--model', 'fiction-new', '--effort', 'high']],
    ['', 'low', ['--effort', 'low']],
    ['fiction-new', '', ['--model', 'fiction-new']],
    ['', '', []],
  ] as [string, string, string[]][]) {
    settings = JSON.stringify({ executor: 'codex', model, effort })
    await $.command.run({ command: 'console', args: 'refresh' } as any)
    await ui.pointer({ in: 'rows', type: 'down', button: 'right', x: 12, y: 0 } as any)
    await ui.press({ key: 'm-sync' })
    expect(dispatched.slice(0, -1)).toEqual(['node', 'D:/Tools/run.mjs', 'task', '--background', '--write', '--resume-last', '--cwd', 'D:/demo', '--json', ...flags])
    expect(dispatched[dispatched.length - 1].includes('只改 CARD 與歷程')).toBe(true)
    await ui.press({ key: 'm-close' })
  }
  await ui.unmount()
})

test('path overrides expand home and roots preserve priority without changing preflight', () => {
  const config = resolveConfig({ executor: 'codex', companionStateRoots: '["~/first","~/second","~/first"]', dispatchSettingsPath: '~\\config\\dispatch.json', claudeSessionsPath: '~/sessions.json', modelsCachePath: '~/models.json', defaultModel: 'fiction-default', defaultEffort: 'low' }, '/home/example', '', '/var/tmp')
  expect(config.companionStateRoots).toEqual(['/home/example/first', '/home/example/second'])
  expect(config.companionStateDir).toBe('/var/tmp/codex-companion')
  expect(config.dispatchSettingsPath).toBe('/home/example/config/dispatch.json')
  expect(config.claudeSessionsPath).toBe('/home/example/sessions.json')
  expect(config.modelsCachePath).toBe('/home/example/models.json')
  expect(parseSettings(null, { executor: config.executor, model: config.defaultModel, effort: config.defaultEffort })).toEqual({ executor: 'codex', model: 'fiction-default', effort: 'low' })
  expect(resolveConfig({ companionStateRoots: '{' }, '/home/example', '', '/tmp').companionStateRoots).toEqual(['/home/example/.claude/plugins/data/codex-openai-codex/state', '/tmp/codex-companion'])
})

test('a sync uses its own model per executor, project over global, and Claude goes to a fresh session by default', () => {
  const defaults = { executor: 'claude' as const, model: '', effort: '' }
  const settings = parseSettings(JSON.stringify({
    executor: 'claude', model: 'opus', effort: 'high',
    sync: { claude: { model: 'haiku' }, codex: { model: 'luna', effort: 'low' }, session: 'bogus' },
    projects: { 'D:/Beta': { sync: { claude: { effort: 'low' }, session: 'resume' } } },
  }), defaults)
  expect(settings.sync).toEqual({ claude: { model: 'haiku' }, codex: { model: 'luna', effort: 'low' } })
  const base = { model: 'opus', effort: 'high' }
  expect(syncDispatch(settings, 'D:/Alpha', 'claude', base)).toEqual({ model: 'haiku', effort: 'high', fresh: true, custom: true })
  // Codex keeps resuming unless told: a fresh thread would become the one the next continue resumes.
  expect(syncDispatch(settings, 'D:/Alpha', 'codex', {})).toEqual({ model: 'luna', effort: 'low', fresh: false, custom: true })
  expect(syncDispatch(settings, 'd:/beta/', 'claude', base)).toEqual({ model: 'haiku', effort: 'low', fresh: false, custom: true })
  // Nothing set: exactly the normal dispatch.
  expect(syncDispatch(parseSettings('{}', defaults), 'D:/Alpha', 'claude', base)).toEqual({ model: 'opus', effort: 'high', fresh: false, custom: false })
  expect(syncDispatch({ ...defaults, sync: { session: 'fresh' } }, 'D:/Alpha', 'codex', {})).toEqual({ model: '', effort: '', fresh: true, custom: false })
})

test('sync settings are set and cleared field by field, leaving no empty objects', () => {
  let settings: any = { executor: 'codex', model: '', effort: '' }
  settings = setSyncSetting(settings, 'model', 'luna')
  settings = setSyncSetting(settings, 'model', 'haiku', 'claude')
  settings = setSyncSetting(settings, 'session', 'fresh')
  expect(settings.sync).toEqual({ codex: { model: 'luna' }, claude: { model: 'haiku' }, session: 'fresh' })
  expect(() => setSyncSetting(settings, 'session', 'later')).toThrow()
  settings = setSyncSetting(setSyncSetting(setSyncSetting(settings, 'model', ''), 'model', '', 'claude'), 'session', '')
  expect('sync' in settings).toBe(false)
})
