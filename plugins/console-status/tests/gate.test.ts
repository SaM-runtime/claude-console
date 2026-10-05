import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import {
  STATE_ORDER,
  bandText,
  buildProject,
  counts,
  diffToasts,
  events,
  next,
  nextProject,
  parseGate,
  rows,
  selectionContext,
} from '../hooks/logic'

const NOW = new Date(2030, 0, 5, 12, 0).getTime()
const card = (name: string, gate = '無', ask = '無') => [
  '<!-- CARD -->',
  '- 更新：2030-01-05 09:40',
  `- 狀態：${name} ready`,
  `- 等使用者：${ask}`,
  '- 下一步：繼續',
  `- 關卡：${gate}`,
  '<!-- /CARD -->',
].join('\n')

const project = (name: string, gate = '無', ask = '無') =>
  buildProject({ name, statusPath: `C:/work/${name}/.console/STATUS.md` }, card(name, gate, ask), [], NOW)

const snap = (...projects: ReturnType<typeof project>[]): Snapshot => ({
  at: NOW,
  projects,
  blocked: [],
  codex: 'OK codex=0.0.0-test',
  contextPercent: 20,
  error: null,
})

test('parseGate accepts supported kinds, preserves detail, and treats none as absent', () => {
  expect(parseGate()).toBe(null)
  expect(parseGate('  無  ')).toBe(null)
  expect(parseGate('none')).toBe(null)
  expect(parseGate(' spec：確認需求範圍 ')).toEqual({ kind: 'spec', detail: '確認需求範圍' })
  expect(parseGate('review:  程式審查')).toEqual({ kind: 'review', detail: '程式審查' })
  expect(parseGate('release：正式環境')).toEqual({ kind: 'release', detail: '正式環境' })
  expect(parseGate('security：人工確認')).toEqual({ kind: 'unknown', detail: 'security：人工確認' })
})

test('buildProject keeps the raw gate and rows sort ACTION then GATE then RUNNING', () => {
  const action = project('Action', 'release：待上線', '請決定版本')
  const gate = project('Gate', 'review：檢查變更')
  const running = project('Running')
  running.jobs = [{ kind: 'running', id: 'task-run', status: 'running', summary: '' }]

  expect(action.gate).toBe('release：待上線')
  expect(STATE_ORDER.slice(0, 3)).toEqual(['ACTION', 'GATE', 'RUNNING'])
  expect(rows(snap(running, gate, action)).map(row => row.state)).toEqual(['ACTION', 'GATE', 'RUNNING'])
  expect(rows(snap(gate))[0].item).toBe('review：檢查變更')
  expect(counts(snap(gate)).GATE).toBe(1)
})

test('next treats GATE as a user item after ACTION and before SYNC', () => {
  const action = project('Action', '無', '請決定版本')
  const gate = project('Gate', 'spec：確認規格')
  const sync = project('Sync')
  sync.jobs = [{ kind: 'newer', id: 'task-done', status: 'completed', summary: '' }]

  expect(next(snap(sync, gate))).toBe('Gate・spec：確認規格')
  expect(nextProject(snap(sync, gate))).toBe('Gate')
  expect(nextProject(snap(gate, action))).toBe('Action')
})

test('gate appears in selection context and the summary band', () => {
  const s = snap(project('Gate Project', 'release：上線前核准'))
  expect(selectionContext(s, 'Gate Project')?.includes('關卡：release：上線前核准')).toBe(true)
  expect(bandText(s).includes('待審核 1')).toBe(true)
})

test('a new or changed gate produces a user notice and activity event', () => {
  const before = snap(project('Gate', '無'))
  const after = snap(project('Gate', 'review：程式審查'))
  expect(diffToasts(before, after)).toEqual(['Gate 待審核：review：程式審查'])
  expect(events(before, after).map(event => event.text)).toEqual(['Gate　新的審核關卡'])

  const release = snap(project('Gate', 'release：程式審查'))
  expect(diffToasts(after, release)).toEqual(['Gate 待審核：release：程式審查'])
})
