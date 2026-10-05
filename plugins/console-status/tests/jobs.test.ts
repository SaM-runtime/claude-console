import { expect, test } from 'claude-code/testing'

import { readJobs } from '../hooks/jobs'
import { jobTasks, shortModel, taskMeta } from '../hooks/logic'

function fakeFs(files: Record<string, string>, directories: Record<string, string[]>) {
  return {
    list: async (path: string) => (directories[path] ?? []).map(name => ({ name, kind: 'dir' })),
    read: async (path: string) => {
      if (!(path in files)) throw new Error('missing')
      return files[path]
    },
  }
}

test('companion roots merge matching workspaces and newest duplicate wins', async () => {
  const roots = ['D:/Plugin/state', 'D:/Temp/codex-companion']
  const dirs = {
    [roots[0]]: ['Project Alpha-a1', 'Other-a2'],
    [roots[1]]: ['project alpha-fixture'],
  }
  const files = {
    'D:/Plugin/state/Project Alpha-a1/state.json': JSON.stringify({ jobs: [
      { id: 'same', updatedAt: '2030-01-05T10:00:00Z', status: 'running', logFile: 'jobs/same.log' },
      { id: 'plugin-only', status: 'queued' },
    ] }),
    'D:/Temp/codex-companion/project alpha-fixture/state.json': JSON.stringify({ jobs: [
      { id: 'same', updatedAt: '2030-01-05T11:00:00Z', status: 'completed' },
      { id: 'temp-only', status: 'completed' },
    ] }),
  }
  const jobs = await readJobs(fakeFs(files, dirs), roots, 'C:/Work/Project Alpha')
  expect(jobs.map(j => j.id)).toEqual(['same', 'plugin-only', 'temp-only'])
  expect(jobs[0].status).toBe('completed')
  expect(jobs[1].status).toBe('queued')
})

test('state timestamp is a fallback, ties preserve root priority, relative logs resolve', async () => {
  const roots = ['D:/First', 'D:/Second']
  const dirs = { 'D:/First': ['demo-a'], 'D:/Second': ['demo-b'] }
  const files = {
    'D:/First/demo-a/state.json': JSON.stringify({ updatedAt: '2030-01-05T12:00:00Z', jobs: [{ id: 'same', status: 'running', logFile: 'jobs/same.log' }] }),
    'D:/Second/demo-b/state.json': JSON.stringify({ updatedAt: '2030-01-05T12:00:00Z', jobs: [{ id: 'same', status: 'failed' }] }),
  }
  const jobs = await readJobs(fakeFs(files, dirs), roots, 'C:/demo')
  expect(jobs[0].status).toBe('running')
  expect(jobs[0].logFile).toBe('D:/First/demo-a/jobs/same.log')
})

test('malformed states and malformed job entries are ignored', async () => {
  const roots = ['D:/State']
  const dirs = { 'D:/State': ['Demo-bad', 'Demo-shape', 'Demo-good'] }
  const files = {
    'D:/State/Demo-bad/state.json': '{half-written',
    'D:/State/Demo-shape/state.json': '{"jobs":{"id":"not-an-array"}}',
    'D:/State/Demo-good/state.json': '{"jobs":[null,{}, {"id":4}, {"id":"ok","jobClass":"task","status":"queued","summary":4,"request":{"model":6,"effort":"high"}}]}',
  }
  const jobs = await readJobs(fakeFs(files, dirs), roots, 'C:/Demo')
  expect(jobs).toEqual([{ id: 'ok', jobClass: 'task', status: 'queued', request: { effort: 'high' } }])
  expect(taskMeta(jobTasks(jobs)[0], 0).meta).toBe('排隊中 · high')
})

test('task metadata includes a generic shortened model id and effort', () => {
  expect(shortModel('provider/vendor-0.0-example-family-name')).toBe('example-famil…')
  expect(shortModel('custom-model')).toBe('custom-model')
  expect(shortModel(' custom\n model ')).toBe('custom model')
  const [task] = jobTasks([{ id: 'one', jobClass: 'task', status: 'running', startedAt: '2030-01-05T10:00:00Z', request: { prompt: 'work', model: 'vendor-0-sample', effort: 'high' } }])
  expect(task.model).toBe('vendor-0-sample')
  expect(taskMeta(task, Date.parse('2030-01-05T10:12:00Z')).meta).toBe('已跑 12m · sample · high')
})

test('refresh reads both configured roots and renders the newest job model', {
  options: {
    executor: 'codex',
    registryPath: 'D:/registry.md',
    companionStateRoots: '["D:/Plugin/state","D:/Temp/state"]',
  },
}, async ($, on) => {
  const now = Date.parse('2030-01-05T12:00:00Z')
  on('clock.now', () => ({ value: now }))
  on('env.get', (_, e) => ({ value: e.name === 'LOCALAPPDATA' ? 'D:/Local' : 'C:/Users/example' }))
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'claude' ? '[]' : 'unknown', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_, e) => ({ value: e.path.replace(/\\/g, '/') === 'D:/Plugin/state'
    ? [{ name: 'Project Alpha-first', kind: 'dir' }]
    : e.path.replace(/\\/g, '/') === 'D:/Temp/state' ? [{ name: 'Project Alpha-second', kind: 'dir' }] : [] }))
  on('fs.read', (_, e) => {
    const files: Record<string, string> = {
      'C:/Users/example/.claude/handoffs/claude-sessions.json': '{"version":1,"roots":{}}',
      'D:/registry.md': '## STATUS 卡位置\n| Project Alpha | `D:/Project Alpha/STATUS.md` |',
      'D:/Project Alpha/STATUS.md': '<!-- CARD -->\n- 更新：2030-01-05 10:00\n- 狀態：工作中\n- 等使用者：無\n<!-- /CARD -->',
      'D:/Plugin/state/Project Alpha-first/state.json': JSON.stringify({ jobs: [{ id: 'same', jobClass: 'task', status: 'running', updatedAt: '2030-01-05T10:00:00Z', request: { prompt: 'older', model: 'vendor-0-previous', effort: 'low' } }] }),
      'D:/Temp/state/Project Alpha-second/state.json': JSON.stringify({ jobs: [{ id: 'same', jobClass: 'task', status: 'running', updatedAt: '2030-01-05T11:00:00Z', request: { prompt: 'newer', model: 'vendor-0-sample', effort: 'high' } }] }),
    }
    const path = e.path.replace(/\\/g, '/')
    if (!(path in files)) throw new Error('missing')
    return { value: files[path] }
  })
  on('session.usage', () => ({ value: null } as any))
  on('session.id', () => ({ value: 'session' }))
  await $.command.run({ command: 'console', args: 'refresh' } as any)
  const ui = await $.ui.mount({ plugin: 'console-status', component: 'Pane', requestId: 'console-status', surface: 'mobile', props: { bodyColumns: 80, scroll: { offset: 0, total: 0, visible: 0 } } } as any)
  await ui.press({ key: 'detail' })
  expect(await ui.find({ type: 'Text', text: /newer/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sample · high/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /previous · low/ })).toBeUndefined()
  await ui.unmount()
})
