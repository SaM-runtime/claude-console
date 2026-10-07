import { expect, test, mock } from 'claude-code/testing'
import { compareVersions, hasUpdate, manifestVersion, marketplaceUpdateArgs, updateArgs, versionLine, LATEST_MANIFEST_URL } from '../hooks/updater'

const OPTIONS = { options: { registryPath: 'D:/Fixtures/registry.md' } }
const PANE = { plugin: 'console-status', component: 'Pane', requestId: 'console-status',
  props: { title: '主控台', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, total: 0, visible: 0 } } } as any
const result = (stdout = '', exitCode = 0, stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

test('versions compare numerically and a manifest gives its version', () => {
  expect(compareVersions('0.4.10', '0.4.9')).toBeGreaterThan(0)
  expect(compareVersions('0.4.2', '0.4.2')).toBe(0)
  expect(compareVersions('v1.0.0', '0.9.9')).toBeGreaterThan(0)
  expect(compareVersions('0.5.0-rc.1', '0.5.0')).toBeLessThan(0)
  expect(manifestVersion('{"name":"console-status","version":"0.4.3"}')).toBe('0.4.3')
  expect(manifestVersion('<html>404</html>')).toBeNull()
  expect(manifestVersion('{"version":7}')).toBeNull()
  expect(hasUpdate({ current: '0.4.2', latest: '0.4.3', checkedAt: 0, phase: 'idle' })).toBe(true)
  expect(hasUpdate({ current: '0.4.3', latest: '0.4.3', checkedAt: 0, phase: 'idle' })).toBe(false)
  expect(hasUpdate({ current: null, latest: '0.4.3', checkedAt: 0, phase: 'idle' })).toBe(false)
  expect(updateArgs()).toEqual(['claude', 'plugin', 'update', 'console-status'])
  expect(marketplaceUpdateArgs()).toEqual(['claude', 'plugin', 'marketplace', 'update', 'claude-console'])
  expect(versionLine({ current: '0.4.2', latest: '0.4.3', checkedAt: 0, phase: 'idle' })).toBe('v0.4.2　有新版 v0.4.3')
  expect(versionLine({ current: '0.4.3', latest: '0.4.3', checkedAt: 0, phase: 'idle' })).toBe('v0.4.3　已是最新版')
  expect(versionLine({ current: '0.4.2', latest: null, checkedAt: 0, phase: 'idle', error: 'HTTP 503' })).toBe('v0.4.2　無法檢查最新版（HTTP 503）')
})

function fixture(on: any, latest: string | null, update = result('✔ Updated console-status')) {
  const clock = mock.clock(on, { now: Date.parse('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const data = { refuseReload: false, fetched: [] as string[], ran: [] as string[][], commands: [] as string[], toasts: [] as string[], state: {} as Record<string, any> }
  on('fs.read', (_: any, e: any) => ({ value: e.path.endsWith('/.claude-plugin/plugin.json') ? '{"name":"console-status","version":"0.4.2"}' : e.path.includes('claude-sessions') ? '{"version":1,"roots":{}}' : '' }))
  on('fs.list', () => ({ value: [] }))
  on('http.fetch', (_: any, e: any) => {
    data.fetched.push(e.url)
    return { value: latest === null ? { status: 503, ok: false, headers: {}, text: '' } : { status: 200, ok: true, headers: {}, text: JSON.stringify({ name: 'console-status', version: latest }) } }
  })
  on('process.run', (_: any, e: any) => {
    if (e.argv.join(' ').startsWith('claude plugin ')) { data.ran.push([...e.argv]); return { value: e.argv[2] === 'update' ? update : result() } }
    return { value: result(e.argv[0] === 'claude' ? '[]' : '') }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console' }))
  const store: Record<string, unknown> = {}
  on('store.get', (_: any, e: any) => ({ value: store[e.key] ?? null }))
  on('store.set', (_: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('ui.toast', (_: any, e: any) => { data.toasts.push(e.text); return { value: undefined } })
  on('state.set', async (_: any, e: any, next: any) => { const r = await next(e); data.state[e.key] = e.value; return r })
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', (_: any, e: any) => {
    data.commands.push(e.command)
    if (e.command === 'reload-plugins' && data.refuseReload) throw new Error('refused')
    return { text: '' }
  })
  return Object.assign(data, { clock })
}

test('a session start finds a newer version on main and toasts it once per version', OPTIONS, async ($, on) => {
  const data = fixture(on, '0.4.3')
  await $.session.start({ cwd: 'C:/console' } as any)
  const out: any = await $.command.run({ command: 'console', args: 'version' } as any)
  expect(data.fetched[0]).toBe(LATEST_MANIFEST_URL)
  expect(out.text).toMatch(/v0\.4\.2　有新版 v0\.4\.3/)
  expect(data.state.updateInfo).toMatchObject({ current: '0.4.2', latest: '0.4.3', phase: 'idle' })
  expect(data.toasts.filter(t => t.includes('有新版 v0.4.3')).length).toBe(1)
  await $.session.start({ cwd: 'C:/console' } as any)
  await $.command.run({ command: 'console', args: 'version' } as any)
  expect(data.toasts.filter(t => t.includes('有新版 v0.4.3')).length).toBe(1)
  await data.clock.settle() // the session start's background refresh
})

test('/console update runs claude plugin update, then /reload-plugins', OPTIONS, async ($, on) => {
  const data = fixture(on, '0.4.3')
  const out: any = await $.command.run({ command: 'console', args: 'update' } as any)
  expect(data.ran).toEqual([['claude', 'plugin', 'marketplace', 'update', 'claude-console'], ['claude', 'plugin', 'update', 'console-status']])
  expect(out.text).toMatch(/已更新到 v0\.4\.3/)
  expect(data.state.updateInfo.phase).toBe('updated')
  // The reload runs once the slash command's own turn is over.
  expect(data.commands).not.toContain('reload-plugins')
  await data.clock.advance(1500)
  expect(data.commands).toContain('reload-plugins')
})

test('a refused /reload-plugins tells the person to run it', OPTIONS, async ($, on) => {
  const data = fixture(on, '0.4.3')
  data.refuseReload = true
  await $.command.run({ command: 'console', args: 'update' } as any)
  await data.clock.advance(1500)
  expect(data.state.updateInfo).toMatchObject({ phase: 'failed', message: '已安裝，請輸入 /reload-plugins 套用' })
  expect(data.toasts.some(t => t.includes('請輸入 /reload-plugins 套用'))).toBe(true)
})

test('/console update does nothing when already on the latest version', OPTIONS, async ($, on) => {
  const data = fixture(on, '0.4.2')
  const out: any = await $.command.run({ command: 'console', args: 'update' } as any)
  expect(out.text).toMatch(/已是最新版，不需要更新/)
  expect(data.ran).toEqual([])
  expect(data.commands).not.toContain('reload-plugins')
})

test('an unreachable main says so and still names the terminal command', OPTIONS, async ($, on) => {
  const data = fixture(on, null)
  const out: any = await $.command.run({ command: 'console', args: 'update' } as any)
  expect(out.text).toMatch(/無法檢查最新版（HTTP 503）.*claude plugin update console-status/)
  expect(data.ran).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the pane shows both versions; ⬆ updates, a failure is shown with a retry`, OPTIONS, async ($, on) => {
    const data = fixture(on, '0.4.3', result('', 1, 'Plugin "console-status" not found'))
    on('ui.open', () => ({ value: {} }) as any)
    await $.command.run({ command: 'console', args: 'demo' } as any)
    await $.command.run({ command: 'console', args: 'version' } as any)
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: /v0\.4\.2　有新版 v0\.4\.3/ })).toBeDefined()
    expect(await ui.find({ key: 'update-check' })).toBeUndefined()
    await ui.press({ key: 'update' })
    expect(data.ran.length).toBe(2)
    expect(await ui.find({ type: 'Text', text: /更新失敗：Plugin "console-status" not found/ })).toBeDefined()
    expect(await ui.find({ key: 'update' })).toBeDefined()
    expect(data.commands).not.toContain('reload-plugins')
    await ui.unmount()
  })
}
