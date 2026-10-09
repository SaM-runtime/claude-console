import { expect, test, mock } from 'claude-code/testing'
import { fixturePath } from './fixture-path'
import { codexDigestLines, digestSource } from '../hooks/digest'
import { reviewPrompt } from '../hooks/actions'

const OPTIONS = { options: { activation: 'always', autoSync: 'off', gitProbe: 'off', executor: 'codex', registryPath: 'D:/Fixtures/registry.md', companionScript: 'D:/Tools/companion.mjs', companionStateRoots: '["D:/State"]' } }
const STATUS = 'D:/Project Alpha/.console/STATUS.md'
const STATE = 'D:/State/Project Alpha-hash/state.json'
const SESSIONS = 'C:/Users/example/.claude/handoffs/claude-sessions.json'
const T = (iso: string) => Date.parse(iso)

const card = (next: string) => `<!-- CARD -->\n- 更新：2030-01-05 11:40\n- 狀態：驗收綠\n- 等使用者：無\n- 下一步：${next}\n- 關卡：無\n<!-- /CARD -->`
const CONTINUE = '依 STATUS CARD 的下一步繼續；遵守任務骨架；結束時更新 CARD（含關卡欄）\nSTATUS：x'
const WORK = { id: 'task-work', jobClass: 'task', status: 'completed', startedAt: '2030-01-05T03:00:00Z', completedAt: '2030-01-05T03:30:00Z', request: { prompt: CONTINUE } }
/** What claude-sessions.json still holds from the days the project ran on Claude. */
const OLD_CLAUDE = JSON.stringify({ version: 1, roots: { 'd:/project alpha': { root: 'D:/Project Alpha', sessionId: '11111111-2222-4333-8444-555555555555', jobs: [{ id: 'console-old:abcd1234', launchName: 'console-old', sessionId: '11111111-2222-4333-8444-555555555555', root: 'D:/Project Alpha', prompt: 'work', kind: 'continue', startedAt: '2030-01-01T08:00:00Z', completedAt: '2030-01-01T09:00:00Z', status: 'completed', phase: 'idle' }] } } })

function harness(on: any, next: string) {
  mock.clock(on, { now: T('2030-01-05T12:00:00Z') })
  mock.env(on, { USERPROFILE: 'C:/Users/example', LOCALAPPDATA: 'D:/Local' })
  const files: Record<string, string> = {
    'D:/Fixtures/registry.md': '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/.console/STATUS.md` |',
    [STATUS]: card(next),
    'C:/Users/example/.claude/handoffs/dispatch.json': JSON.stringify({ executor: 'codex', model: '', effort: '' }),
    [SESSIONS]: OLD_CLAUDE,
    'C:/Users/example/.claude/projects/D--Project-Alpha/11111111-2222-4333-8444-555555555555.jsonl': JSON.stringify({ type: 'assistant', timestamp: '2030-01-01T09:00:00Z', message: { content: [{ type: 'text', text: '舊的 Claude 工作已完成' }] } }),
  }
  const state = { jobs: [WORK] as any[] }
  const launches: string[][] = []
  on('fs.stat', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (!(path in files) || path.endsWith('.md') && path !== STATUS) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
    return { value: { size: files[path]!.length, mtimeMs: path === STATUS ? T('2030-01-05T03:40:00Z') : T('2030-01-01T09:00:00Z') } }
  })
  on('fs.exists', (_: any, e: any) => ({ value: fixturePath(e.path) in files }))
  on('fs.read', (_: any, e: any) => {
    const path = fixturePath(e.path)
    return { value: path === STATE ? JSON.stringify(state) : files[path] ?? '' }
  })
  on('fs.write', (_: any, e: any) => { files[fixturePath(e.path)] = e.text; return { value: undefined } })
  on('fs.list', (_: any, e: any) => {
    const path = fixturePath(e.path)
    if (path === 'D:/State') return { value: [{ name: 'Project Alpha-hash', kind: 'dir' }] }
    if (path === 'C:/Users/example/.claude/projects') return { value: [{ name: 'D--Project-Alpha', kind: 'dir' }] }
    return { value: [] }
  })
  on('process.run', (_: any, e: any) => {
    let stdout = e.argv[0] === 'claude' ? '[]' : 'OK codex=0.0.0-test'
    if (e.argv[0] === 'node' && e.argv.includes('task')) {
      launches.push([...e.argv])
      const id = `task-${launches.length}`
      state.jobs = [...state.jobs, { id, jobClass: 'task', status: 'running', startedAt: '2030-01-05T04:00:00Z', request: { prompt: e.argv.at(-1) } }]
      stdout = JSON.stringify({ jobId: id })
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({ value: null }))
  on('session.id', () => ({ value: 'console-session' }))
  on('ui.open', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  return { launches }
}

test('a Codex review task runs in a new thread, without the executor digest', OPTIONS, async ($, on) => {
  const h = harness(on, '.task/review-login.md（獨立審核）')
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  await $.command.run({ command: 'console', args: 'continue Project Alpha' } as any)
  expect(h.launches.length).toBe(1)
  expect(h.launches[0]!.includes('--fresh')).toBe(true)
  expect(h.launches[0]!.includes('--resume-last')).toBe(false)
  const prompt = h.launches[0]!.at(-1)!
  expect(prompt.startsWith('依 STATUS CARD 的下一步繼續')).toBe(true)
  expect(prompt.includes('這是獨立審核')).toBe(true)
  expect(prompt.includes('執行者摘要')).toBe(false)
})

test('a Codex continue carries the Codex job as its digest, not an old Claude session of the same root', OPTIONS, async ($, on) => {
  const h = harness(on, '依 .task/review-login.md 的意見修正')
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  await $.command.run({ command: 'console', args: 'continue Project Alpha' } as any)
  expect(h.launches.length).toBe(1)
  expect(h.launches[0]!.includes('--resume-last')).toBe(true)
  const prompt = h.launches[0]!.at(-1)!
  expect(prompt.includes('這是獨立審核')).toBe(false)
  expect(prompt.includes('執行者摘要：\n執行者：task-work · codex · completed')).toBe(true)
  expect(prompt.includes('console-old')).toBe(false)
  expect(prompt.includes('舊的 Claude 工作已完成')).toBe(false)
})

test('the digest comes from the executor that did the latest work', () => {
  const codex = { id: 'task-1', executor: 'codex' as const, status: 'completed', completedAt: '2030-01-05T11:50:00Z' }
  const claude = { id: 'console-a', executor: 'claude' as const, status: 'completed' }
  expect(digestSource('codex', [codex, claude])).toEqual({ kind: 'codex', task: codex })
  // A Codex project whose newest task fell back to Claude reads the Claude records.
  expect(digestSource('codex', [claude, codex])).toEqual({ kind: 'claude' })
  expect(digestSource('codex', [])).toEqual({ kind: 'codex', task: null })
  expect(digestSource('claude', undefined)).toEqual({ kind: 'claude' })
  expect(digestSource('manual', undefined)).toEqual({ kind: 'claude' })
  expect(codexDigestLines(codex, T('2030-01-05T12:00:00Z'))).toEqual([
    '執行者：task-1 · codex · completed',
    '最後活動：2030-01-05T11:50:00Z （10 分鐘前）',
    '最後動作：無（Codex 不提供）',
    '最後一句：無（Codex 沒有對話摘要，以 STATUS 與 git 為準）',
  ])
})

test('a review prompt is the continue prompt plus the independence rule', () => {
  const prompt = reviewPrompt({ name: 'A', statusPath: 'D:/A/.console/STATUS.md', next: '.task/review-a.md' } as any)
  expect(prompt.startsWith('依 STATUS CARD 的下一步繼續')).toBe(true)
  expect(prompt.includes('不參考執行者自己的結論')).toBe(true)
  expect(prompt.includes('執行者摘要')).toBe(false)
})
