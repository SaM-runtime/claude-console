import { expect, test } from 'claude-code/testing'
import { parseSettings, effectiveDispatch, setProjectOverride, nextProjectExecutor, readSettingsFiles, projectKey, executorSignature } from '../hooks/dispatch'
import { resolveFallbackOptions, legacyDispatchPath } from '../hooks/config'
import { parseRegistry } from '../hooks/logic'
import { decideCodexDispatch, quotaReading, QUOTA_STALE_MS } from '../hooks/fallback'
import { compareSemver, newestVersion, installedPaths, resolveCompanion } from '../hooks/companion'
import { listWorkspaceJobs } from '../hooks/executors'

const DEFAULTS = { executor: 'claude' as const, model: '', effort: '' }

test('per-project overrides parse, ignore invalid entries and keep the flat 0.1 shape unchanged', () => {
  expect(parseSettings('{"executor":"codex","model":"m","effort":"high"}', DEFAULTS)).toEqual({ executor: 'codex', model: 'm', effort: 'high' })
  expect('projects' in parseSettings('{"executor":"codex","model":"","effort":"","projects":{}}', DEFAULTS)).toBe(false)
  const parsed = parseSettings(JSON.stringify({
    executor: 'claude', model: '', effort: '',
    projects: { 'D:/Alpha': { executor: 'codex', model: 'fiction-codex', effort: 'high' }, 'D:/Beta': { executor: 'manual' }, 'D:/Bad': { executor: 'robot', model: 7 }, 'D:/Junk': 'codex' },
  }), DEFAULTS)
  expect(parsed.projects).toEqual({ 'D:/Alpha': { executor: 'codex', model: 'fiction-codex', effort: 'high' }, 'D:/Beta': { executor: 'manual' } })
})

test('precedence is pane override > registry column > global, and model/effort follow it', () => {
  const settings = parseSettings(JSON.stringify({ executor: 'claude', model: 'opus', effort: 'high', projects: { 'd:/alpha': { executor: 'codex', model: 'fiction-codex' } } }), DEFAULTS)
  expect(effectiveDispatch(settings, 'D:/Alpha', 'manual')).toEqual({ executor: 'codex', source: 'pane', model: 'fiction-codex', effort: '' })
  expect(effectiveDispatch(settings, 'D:/Beta', 'manual')).toEqual({ executor: 'manual', source: 'registry', model: '', effort: '' })
  expect(effectiveDispatch(settings, 'D:/Beta', 'codex')).toEqual({ executor: 'codex', source: 'registry', model: '', effort: '' })
  expect(effectiveDispatch(settings, 'D:/Beta', 'claude')).toEqual({ executor: 'claude', source: 'registry', model: 'opus', effort: 'high' })
  expect(effectiveDispatch(settings, 'D:/Beta')).toEqual({ executor: 'claude', source: 'global', model: 'opus', effort: 'high' })
  // An override holding only model/effort keeps the inherited executor.
  const modelOnly = parseSettings('{"executor":"claude","model":"opus","effort":"","projects":{"/srv/gamma":{"effort":"low"}}}', DEFAULTS)
  expect(effectiveDispatch(modelOnly, '/srv/gamma/')).toEqual({ executor: 'claude', source: 'global', model: 'opus', effort: 'low' })
  expect(effectiveDispatch(modelOnly, '/SRV/gamma').source).toBe('global')
})

test('project overrides persist minimally, normalize Windows keys and keep global fields', () => {
  const base = { executor: 'codex' as const, model: 'fiction-global', effort: 'medium' }
  let next = setProjectOverride(base, 'D:\\Alpha\\', 'executor', 'claude')
  expect(next).toEqual({ ...base, projects: { 'D:/Alpha': { executor: 'claude' } } })
  next = setProjectOverride(next, 'd:/alpha', 'model', 'sonnet')
  expect(next.projects).toEqual({ 'D:/Alpha': { executor: 'claude', model: 'sonnet' } })
  next = setProjectOverride(next, 'D:/Alpha', 'executor', 'manual')
  expect(next.projects).toEqual({ 'D:/Alpha': { executor: 'manual' } })
  next = setProjectOverride(next, '/srv/beta', 'executor', 'codex')
  next = setProjectOverride(next, 'D:/ALPHA', 'executor', '')
  expect(next).toEqual({ ...base, projects: { '/srv/beta': { executor: 'codex' } } })
  next = setProjectOverride(next, '/srv/beta', 'executor', '')
  expect(next).toEqual(base)
  expect(() => setProjectOverride(base, 'D:/Alpha', 'executor', 'robot')).toThrow()
  expect(projectKey('D:\\Work\\Alpha\\')).toBe('d:/work/alpha')
  expect(projectKey('/srv/Alpha/')).toBe('/srv/Alpha')
  expect([undefined, 'claude', 'codex', 'manual'].map(value => nextProjectExecutor(value as any))).toEqual(['claude', 'codex', 'manual', ''])
  expect(executorSignature(base) === executorSignature({ ...base, model: 'other' })).toBe(true)
  expect(executorSignature(base) === executorSignature(setProjectOverride(base, 'D:/A', 'executor', 'manual'))).toBe(false)
})

test('registry Executor column is optional, order independent and blank means global', () => {
  const legacy = '## STATUS 卡位置\n| Project | STATUS path |\n| --- | --- |\n| Alpha | `~/a/STATUS.md` |'
  expect(parseRegistry(legacy, 'C:/Users/example')).toEqual([{ name: 'Alpha', statusPath: 'C:/Users/example/a/STATUS.md' }])
  const table = [
    '## STATUS 卡位置',
    '| Project | STATUS path | Scope | Executor |',
    '| --- | --- | --- | --- |',
    '| Alpha | `D:/a/STATUS.md` | API | codex |',
    '| Beta | `D:/b/STATUS.md` | UI | Manual |',
    '| Gamma | `D:/c/STATUS.md` | Docs |  |',
    '| Delta | `D:/d/STATUS.md` | Docs | `claude` |',
    '| Eps | `D:/e/STATUS.md` | Docs | robot |',
    '## Other',
    '| Ignored | `D:/x/STATUS.md` | x | codex |',
  ].join('\n')
  expect(parseRegistry(table, 'C:/Users/example')).toEqual([
    { name: 'Alpha', statusPath: 'D:/a/STATUS.md', executor: 'codex' },
    { name: 'Beta', statusPath: 'D:/b/STATUS.md', executor: 'manual' },
    { name: 'Gamma', statusPath: 'D:/c/STATUS.md' },
    { name: 'Delta', statusPath: 'D:/d/STATUS.md', executor: 'claude' },
    { name: 'Eps', statusPath: 'D:/e/STATUS.md' },
  ])
})

test('canonical dispatch file wins; legacy codex-dispatch.json is read only when canonical is missing', () => {
  expect(legacyDispatchPath('C:/Users/example/.claude/handoffs/dispatch.json')).toBe('C:/Users/example/.claude/handoffs/codex-dispatch.json')
  expect(legacyDispatchPath('C:\\cfg\\dispatch.json')).toBe('C:/cfg/codex-dispatch.json')
  const legacy = '{"model":"fiction-codex","effort":"high"}'
  expect(readSettingsFiles('{"executor":"claude","model":"","effort":""}', legacy, DEFAULTS)).toEqual({ settings: DEFAULTS, source: 'canonical' })
  expect(readSettingsFiles('{', legacy, DEFAULTS)).toEqual({ settings: DEFAULTS, source: 'canonical' })
  expect(readSettingsFiles(null, legacy, DEFAULTS)).toEqual({ settings: { executor: 'codex', model: 'fiction-codex', effort: 'high' }, source: 'legacy' })
  expect(readSettingsFiles(null, '{"executor":"claude","model":"opus"}', DEFAULTS).settings).toEqual({ executor: 'claude', model: 'opus', effort: '' })
  expect(readSettingsFiles(null, '{', DEFAULTS)).toEqual({ settings: DEFAULTS, source: 'defaults' })
  expect(readSettingsFiles(null, null, DEFAULTS)).toEqual({ settings: DEFAULTS, source: 'defaults' })
})

test('fallback options default to ask/10 and clamp the threshold', () => {
  expect(resolveFallbackOptions({})).toEqual({ codexFallback: 'ask', codexMinQuotaPercent: 10 })
  expect(resolveFallbackOptions({ codexFallback: 'Claude', codexMinQuotaPercent: '25' })).toEqual({ codexFallback: 'claude', codexMinQuotaPercent: 25 })
  expect(resolveFallbackOptions({ codexFallback: 'off', codexMinQuotaPercent: 150 })).toEqual({ codexFallback: 'off', codexMinQuotaPercent: 100 })
  expect(resolveFallbackOptions({ codexFallback: 'nope', codexMinQuotaPercent: 'x' })).toEqual({ codexFallback: 'ask', codexMinQuotaPercent: 10 })
})

test('fallback decision covers ask/claude/off, the threshold boundary, stale quota and preflight problems', () => {
  const now = Date.parse('2030-01-05T12:00:00Z')
  const fresh = (used: number[]) => ({ at: new Date(now - 60_000).toISOString(), limits: used.map((percent, i) => ({ label: `w${i}`, percent })) })
  const base = { minPercent: 10, preflight: 'OK codex=0.0.0-test companion=OK', companionPath: 'D:/Tools/companion.mjs', now }
  // Lowest window decides: 95% used leaves 5%.
  expect(decideCodexDispatch({ ...base, mode: 'ask', quota: fresh([20, 95]) })).toEqual({ action: 'ask', reason: 'Codex 額度剩 5%（低於 10%）' })
  expect(decideCodexDispatch({ ...base, mode: 'claude', quota: fresh([95]) }).action).toBe('claude')
  expect(decideCodexDispatch({ ...base, mode: 'off', quota: fresh([100]), preflight: 'STALE codex=1 brokers=1(x)' })).toEqual({ action: 'codex' })
  // Exactly at the threshold is enough.
  expect(decideCodexDispatch({ ...base, mode: 'claude', quota: fresh([90]) })).toEqual({ action: 'codex' })
  expect(decideCodexDispatch({ ...base, mode: 'claude', quota: fresh([91]) }).action).toBe('claude')
  // Stale or missing quota is unknown, never a trigger by itself.
  const stale = { at: new Date(now - QUOTA_STALE_MS - 1).toISOString(), limits: [{ label: 'w', percent: 100 }] }
  expect(quotaReading(stale, 10, now)).toEqual({ state: 'unknown', remaining: 0, ageMs: QUOTA_STALE_MS + 1 })
  expect(decideCodexDispatch({ ...base, mode: 'claude', quota: stale })).toEqual({ action: 'codex' })
  expect(decideCodexDispatch({ ...base, mode: 'claude', quota: { at: '', limits: [{ label: 'w', percent: 100 }] } })).toEqual({ action: 'codex' })
  expect(decideCodexDispatch({ ...base, mode: 'claude', quota: null })).toEqual({ action: 'codex' })
  // Preflight problems trigger regardless of quota.
  for (const preflight of ['STALE codex=1.2.3 brokers=42(alpha)', 'UNKNOWN codex=unavailable companion=OK', 'OK codex=1.2.3 companion=MISSING']) {
    expect(decideCodexDispatch({ ...base, mode: 'ask', quota: null, preflight }).action).toBe('ask')
    expect(decideCodexDispatch({ ...base, mode: 'claude', quota: null, preflight }).action).toBe('claude')
  }
  expect(decideCodexDispatch({ ...base, mode: 'claude', quota: null, companionPath: '' }).action).toBe('claude')
  // An unknown probe or another workspace's stale broker is not a reason.
  for (const preflight of ['unknown', '…', 'OK*（其他 workspace 有舊 broker，與本主控台無關）']) {
    expect(decideCodexDispatch({ ...base, mode: 'claude', quota: null, preflight })).toEqual({ action: 'codex' })
  }
  const both = decideCodexDispatch({ ...base, mode: 'ask', quota: fresh([99]), preflight: 'STALE codex=1 brokers=1(a)' })
  expect(both.action === 'ask' && both.reason.includes('broker') && both.reason.includes('1%')).toBe(true)
})

test('companion versions sort semantically, not lexically', () => {
  expect(compareSemver('1.0.10', '1.0.9')).toBe(1)
  expect(compareSemver('1.10.0', '1.9.99')).toBe(1)
  expect(compareSemver('2.0.0-beta.2', '2.0.0-beta.10')).toBe(-1)
  expect(compareSemver('2.0.0-rc.1', '2.0.0')).toBe(-1)
  expect(compareSemver('1.0.0', 'latest')).toBe(null)
  expect(newestVersion(['1.0.9', '1.0.10', '1.0.6', 'tmp', '1.0.10-rc.1'])).toBe('1.0.10')
  expect(newestVersion(['x', 'y'])).toBe(null)
  expect(installedPaths(JSON.stringify({ version: 2, plugins: { 'codex@openai-codex': [
    { installPath: 'C:\\plugins\\codex\\1.0.9', version: '1.0.9' }, { installPath: 'C:/plugins/codex/1.0.10' }, { installPath: '' },
  ] } }))).toEqual([{ path: 'C:/plugins/codex/1.0.10', version: '1.0.10' }, { path: 'C:/plugins/codex/1.0.9', version: '1.0.9' }])
  expect(installedPaths('{')).toEqual([])
})

function fakeFs(tree: Record<string, string[]>, files: Record<string, string> = {}) {
  const lists: string[] = []
  return {
    lists,
    read: async (path: string) => { if (path in files) return files[path]!; throw new Error('ENOENT ' + path) },
    list: async (path: string) => {
      lists.push(path)
      const entries = tree[path]
      if (!entries) throw new Error('ENOENT ' + path)
      return entries.map(name => name.endsWith('/') ? { name: name.slice(0, -1), kind: 'dir' } : { name, kind: 'file' })
    },
  }
}

test('companion auto-resolve picks the newest installed version and reports a stale configured path', async () => {
  const home = 'C:/Users/example'
  const cache = `${home}/.claude/plugins/cache/openai-codex/codex`
  const tree = {
    [cache]: ['1.0.9/', '1.0.10/', '1.0.11/', 'notes.txt', 'latest/'],
    [`${cache}/1.0.9/scripts`]: ['codex-companion.mjs'],
    [`${cache}/1.0.10/scripts`]: ['codex-companion.mjs'],
    [`${cache}/1.0.11/scripts`]: ['other.mjs'],
  }
  // A configured path that is not known to be missing is used without any I/O.
  const quiet = fakeFs(tree)
  expect(await resolveCompanion(quiet, home, 'D:\\Tools\\companion.mjs')).toEqual({ path: 'D:/Tools/companion.mjs', source: 'configured' })
  expect(quiet.lists).toEqual([])
  // Empty: newest version that actually has the script (1.0.11 lacks it; lexical order would pick 1.0.9).
  expect(await resolveCompanion(fakeFs(tree), home, '')).toEqual({ path: `${cache}/1.0.10/scripts/codex-companion.mjs`, source: 'cache', version: '1.0.10' })
  // Stale configured path: fall back with a warning.
  const stale = await resolveCompanion(fakeFs(tree), home, `${cache}/1.0.6/scripts/codex-companion.mjs`, true)
  expect(stale.path).toBe(`${cache}/1.0.10/scripts/codex-companion.mjs`)
  expect(stale.warning?.includes('1.0.6')).toBe(true)
  // installed_plugins.json installPath is consulted too, and wins a version tie.
  const installed = { [`${home}/.claude/plugins/installed_plugins.json`]: JSON.stringify({ plugins: { 'codex@openai-codex': [{ installPath: 'E:/codex-plugin/2.0.0', version: '2.0.0' }] } }) }
  expect(await resolveCompanion(fakeFs({ ...tree, 'E:/codex-plugin/2.0.0/scripts': ['codex-companion.mjs'] }, installed), home, '')).toEqual({ path: 'E:/codex-plugin/2.0.0/scripts/codex-companion.mjs', source: 'installed', version: '2.0.0' })
  const tie = { [`${home}/.claude/plugins/installed_plugins.json`]: JSON.stringify({ plugins: { 'codex@openai-codex': [{ installPath: `${cache}/1.0.10`, version: '1.0.10' }] } }) }
  expect((await resolveCompanion(fakeFs(tree, tie), home, '')).source).toBe('installed')
  // Nothing installed.
  expect(await resolveCompanion(fakeFs({}), home, '')).toEqual({ path: '', source: 'none', warning: 'companionScript is empty and no installed Codex plugin was found' })
  const kept = await resolveCompanion(fakeFs({}), home, 'D:/Tools/gone.mjs', true)
  expect([kept.path, kept.source, !!kept.warning]).toEqual(['D:/Tools/gone.mjs', 'configured', true])
})

test('job listing merges both executors so a project sees Claude and Codex jobs together', async () => {
  const sessions = { version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', jobs: [
    { id: 'claude-job', root: 'D:/Project Alpha', prompt: 'claude work', startedAt: '2030-01-05T11:00:00Z', status: 'running', phase: 'working', nativeId: 'abcd1234', launchName: 'console-x', fallbackFrom: 'codex', fallbackReason: 'quota' },
  ] } } }
  const files: Record<string, string> = {
    'C:/sessions.json': JSON.stringify(sessions),
    'D:/State/Project Alpha-hash/state.json': JSON.stringify({ jobs: [{ id: 'codex-job', jobClass: 'task', status: 'running' }] }),
  }
  const deps = {
    run: async (argv: readonly string[]) => ({ exitCode: 0, stdout: argv[1] === 'agents' ? JSON.stringify([{ id: 'abcd1234', name: 'console-x', sessionId: '12345678-1234-4234-8234-123456789abc', cwd: 'D:/Project Alpha', kind: 'background', state: 'working' }]) : '', stderr: '' }),
    files: {
      read: async (path: string) => { if (path in files) return files[path]!; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      list: async (path: string) => path === 'D:/State' ? [{ name: 'Project Alpha-hash', kind: 'dir' }] : [],
      write: async (path: string, text: string) => { files[path] = text },
    },
    now: () => Date.parse('2030-01-05T12:00:00Z'),
  }
  const config = { companionScript: 'D:/Tools/companion.mjs', companionStateRoots: ['D:/State'], claudeSessionsPath: 'C:/sessions.json' }
  for (const kind of ['claude', 'codex'] as const) {
    const jobs = await listWorkspaceJobs(kind, deps, config, 'D:/Project Alpha')
    expect(jobs.map(job => `${job.executor}:${job.id}`).sort()).toEqual(['claude:claude-job', 'codex:codex-job'])
    const claude = jobs.find(job => job.executor === 'claude')
    expect([claude?.fallbackFrom, claude?.fallbackReason]).toEqual(['codex', 'quota'])
  }
})
