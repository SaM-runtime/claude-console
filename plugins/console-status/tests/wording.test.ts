import { expect, test } from 'claude-code/testing'

import { relevantCodex } from '../hooks/logic'
import { codexNote, jobKindText, phaseText } from '../hooks/wording'

test('an old Codex background process is named in words, with its PID and the command that closes it', () => {
  const note = codexNote(relevantCodex('STALE codex=1.2.3 companion=OK brokers=4242(Project Alpha) 5151(other)', ['Project Alpha']))
  expect(note).toBe('Codex 已更新，但背景程式還是舊版（PID 4242 Project Alpha），派工會失敗；先關掉它：! for p in 4242; do taskkill //PID $p //T //F; done')
  expect(/STALE|broker/.test(note)).toBe(false)
  expect(codexNote('UNKNOWN codex=unavailable companion=OK')).toBe('找不到 Codex app，無法派工給 Codex')
  expect(codexNote('OK codex=1.2.3 companion=MISSING')).toContain('codex-companion.mjs')
  expect(codexNote('')).toBe('')
})

test('job phases and kinds read as Chinese; what it does not know stays as it came', () => {
  expect(phaseText('running')).toBe('執行中')
  expect(phaseText('blocked: Bash')).toBe('等批准：Bash')
  expect(phaseText('idle: 等你回覆')).toBe('等你回覆')
  expect(phaseText('等待任務狀態')).toBe('等待任務狀態')
  expect(phaseText('thinking')).toBe('thinking')
  expect(jobKindText('sync')).toBe('同步')
  expect(jobKindText('other')).toBe('other')
})
