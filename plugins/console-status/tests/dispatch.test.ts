import { expect, test, mock } from 'claude-code/testing'
import { parseSettings, parseModels, nextOption, effortOptions, modelOptions } from '../hooks/dispatch'
import { resolveConfig } from '../hooks/config'

test('settings file round trip and failed write are observable through the filesystem API', async ($, on) => {
  const config = resolveConfig({}, 'C:/Users/example', '', '/tmp')
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? 'C:/Users/example' : undefined }))
  const files: Record<string, string> = {}
  let deny = false
  on('ui.toast', () => ({ value: undefined }) as any)
  on('fs.read', (_, e) => {
    const path = e.path.replace(/\\/g, '/')
    if (!(path in files)) throw new Error('missing')
    return { value: files[path] }
  })
  on('fs.write', (_, e) => {
    if (deny) throw new Error('read only')
    files[e.path.replace(/\\/g, '/')] = e.text
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
  expect(modelOptions('claude', models).map(option => option.model)).toEqual(['fable', 'opus', 'sonnet'])
  expect(effortOptions('codex', models, 'fiction-alpha')).toEqual(['high', 'max'])
  expect(effortOptions('codex', models, 'unknown')).toEqual(['low', 'medium', 'high', 'xhigh'])
  expect(effortOptions('claude', models, 'opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  for (const text of ['{', 'null', '{}', '{"models":{}}']) expect(parseModels(text)).toEqual([])
  expect(nextOption('fiction-alpha', models.map(m => m.model))).toBe('fiction-beta')
  expect(nextOption('fiction-beta', models.map(m => m.model))).toBe('fiction-alpha')
  expect(nextOption('', ['low', 'medium'])).toBe('low')
  expect(nextOption('custom', [])).toBe('custom')
})

test('terminal and mobile buttons cycle persisted settings, including model-specific efforts', {
  options: { executor: 'codex' },
}, async ($, on) => {
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
    await ui.press({ key: 'dispatch-model' })
    expect(JSON.parse(settings)).toEqual({ executor: 'codex', model: 'fiction-beta', effort: '' })
    expect(await ui.find({ type: 'Button', key: 'dispatch-model' } as any)).toBeDefined()
    await ui.press({ key: 'dispatch-effort' })
    expect(JSON.parse(settings).effort).toBe('medium')
    await ui.press({ key: 'dispatch-effort' })
    expect(JSON.parse(settings).effort).toBe('max')
    await ui.press({ key: 'dispatch-effort' })
    expect(JSON.parse(settings).effort).toBe('medium')
    await ui.press({ key: 'dispatch-model' })
    expect(JSON.parse(settings)).toEqual({ executor: 'codex', model: 'fiction-alpha', effort: '' })
    cache = '{'
    await ui.press({ key: 'dispatch-model' })
    expect(JSON.parse(settings).model).toBe('fiction-alpha')
    expect(toasts.some(t => t.includes('/console model'))).toBe(true)
    cache = JSON.stringify({ models: [{ slug: 'fiction-alpha', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }, { slug: 'fiction-beta', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }] }] })
    await ui.unmount()
  }
})

test('row sync trigger reads latest file and omits each empty dispatch flag independently', {
  options: { companionScript: 'D:/Tools/run.mjs', executor: 'codex' },
}, async ($, on) => {
  let settings = '{"executor":"codex","model":"fiction-current","effort":"high"}'
  let dispatched: string[] = []
  let completedJobs = '{"jobs":[]}'
  mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  on('env.get', () => ({ value: 'C:/Users/example' }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('state.json') ? completedJobs : e.path.endsWith('claude-sessions.json') ? '{"version":1,"roots":{}}' : e.path.endsWith('models_cache.json') ? '{}' : settings }))
  on('fs.list', () => ({ value: [{ name: 'demo-hash', kind: 'dir' }] }))
  on('ui.open', () => ({ value: {} }) as any)
  on('ui.toast', () => ({ value: undefined }) as any)
  on('process.run', (_, e) => {
    dispatched = [...e.argv]
    completedJobs = '{"jobs":[{"id":"new-job","jobClass":"task","status":"completed"}]}'
    return { value: { exitCode: 0, stdout: '{"jobId":"new-job"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'terminal',
    props: { title: 'Console', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  for (const [model, effort, flags] of [
    ['fiction-new', 'high', ['--model', 'fiction-new', '--effort', 'high']],
    ['', 'low', ['--effort', 'low']],
    ['fiction-new', '', ['--model', 'fiction-new']],
    ['', '', []],
  ] as [string, string, string[]][]) {
    settings = JSON.stringify({ executor: 'codex', model, effort })
    await $.command.run({ command: 'console', args: 'demo' } as any)
    await ui.pointer({ in: 'rows', type: 'down', button: 'right', x: 12, y: 2 } as any)
    await ui.press({ key: 'm-sync' })
    expect(dispatched.slice(0, -1)).toEqual(['node', 'D:/Tools/run.mjs', 'task', '--background', '--write', '--resume-last', '--cwd', 'demo', '--json', ...flags])
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
