import { expect, test } from 'claude-code/testing'
import { codexHealth } from '../hooks/logic'
import { resolveConfig } from '../hooks/config'
import { fixturePath } from './fixture-path'

test('preflight health never promotes unknown or missing companion data to healthy', () => {
  for (const [line, expected] of [
    ['OK codex=0.0.0-test companion=OK', 'ok'],
    ['OK* other workspace', 'ok'],
    ['STALE codex=0.0.0-test', 'stale'],
    ['unknown', 'unknown'],
    ['UNKNOWN codex=unavailable', 'unknown'],
    ['OK codex=0.0.0-test companion=UNKNOWN(unconfigured)', 'unknown'],
    ['OK codex=0.0.0-test companion=MISSING', 'unknown'],
  ]) expect(codexHealth(line)).toBe(expected)
})

test('config expands home paths, normalizes Windows paths and supplies state defaults', () => {
  expect(resolveConfig({ registryPath: '~/registry.md', companionScript: 'D:\\Tools\\run.mjs', companionStateDir: '~/jobs', executor: 'codex' }, 'C:/Users/example', 'D:/Local'))
    .toEqual({ registryPath: 'C:/Users/example/registry.md', companionScript: 'D:/Tools/run.mjs', companionStateDir: 'C:/Users/example/jobs', executor: 'codex', defaultModel: '', defaultEffort: '', dispatchSettingsPath: 'C:/Users/example/.claude/handoffs/dispatch.json', claudeSessionsPath: 'C:/Users/example/.claude/handoffs/claude-sessions.json', modelsCachePath: 'C:/Users/example/.codex/models_cache.json', companionStateRoots: ['C:/Users/example/.claude/plugins/data/codex-openai-codex/state', 'C:/Users/example/jobs'] })
  expect(resolveConfig({}, 'C:/Users/example', 'D:/Local').companionStateDir).toBe('D:/Local/Temp/codex-companion')
  expect(resolveConfig({}, 'C:/Users/example', 'D:/Local').executor).toBe('claude')
  expect(resolveConfig({ executor: 'invalid' }, 'C:/Users/example', 'D:/Local').executor).toBe('claude')
  const obsolete = resolveConfig({ dispatchModel: 'old-model', dispatchEffort: 'high' }, 'C:/Users/example', 'D:/Local')
  expect([obsolete.defaultModel, obsolete.defaultEffort]).toEqual(['', ''])
})

test('refresh consumes userConfig and plugin-relative scripts, then renders the configured project', {
  options: { registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/run.mjs', companionStateDir: 'D:/Jobs', companionStateRoots: '["D:/Jobs"]', executor: 'codex' },
}, async ($, on) => {
  const commands: string[][] = []
  const now = Date.parse('2030-01-05T04:00:00Z')
  on('clock.now', () => ({ value: now }))
  on('env.get', (_, e) => ({ value: e.name === 'LOCALAPPDATA' ? 'D:/Local' : 'C:/Users/example' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    commands.push([...e.argv])
    return { value: { exitCode: 0, stdout: e.argv[0] === 'claude' ? '[]' : 'unknown', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', (_, e) => {
    expect(fixturePath(e.path)).toBe('D:/Jobs')
    return { value: [{ name: 'Project Alpha-demo', kind: 'dir' }] }
  })
  on('fs.read', (_, e) => {
    const files: Record<string, string> = {
      'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
      'D:/Fixtures/registry.md': '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/STATUS.md` |',
      'D:/Project Alpha/STATUS.md': '<!-- CARD -->\n- 更新：2030-01-05 10:00\n- 狀態：範例狀態\n- 等使用者：無\n<!-- /CARD -->',
      'D:/Jobs/Project Alpha-demo/state.json': '{"jobs":[{"id":"demo-task","jobClass":"task","status":"running"}]}',
    }
    const path = fixturePath(e.path)
    if (!(path in files)) throw new Error('Unexpected read: ' + path)
    return { value: files[path] }
  })
  on('session.usage', () => ({ value: null } as any))
  on('session.id', () => ({ value: 'demo-session' }))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  expect(commands.length).toBe(3)
  expect(commands[0].join('|').replace(/\\/g, '/').includes('/scripts/codex-preflight.sh|--companion-script|D:/Tools/run.mjs|--state-dir|D:/Jobs')).toBe(true)
  expect(commands[1].join('|').replace(/\\/g, '/').endsWith('/scripts/codex-quota.sh')).toBe(true)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile', props: { bodyColumns: 80, scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  expect(await ui.find({ type: 'Text', text: /^ 執行中 $/ })).toBeDefined()
  expect((await ui.find({ key: 'sel-Project Alpha' }))?.text).toBe('Project Alpha')
  expect((await ui.find({ type: 'Text', text: /^● 未檢查$/ }))?.props.color).toBe('#6E7787')
  expect(await ui.find({ type: 'Text', text: /^  ・unknown$/ })).toBeDefined()
  await ui.unmount()
})
