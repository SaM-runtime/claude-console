import { expect, test } from 'claude-code/testing'

import { parseCodexQuota } from '../hooks/logic'
import { isWindowsOs, openFallbackArgs, preflightArgs, quotaArgs } from '../hooks/platform'

test('Windows keeps the PowerShell probes and cmd start', () => {
  expect(isWindowsOs('Windows_NT')).toBe(true)
  expect(preflightArgs('D:/plugin', true, 'D:/Tools/run.mjs', 'D:/Jobs', ['C:/state'])).toEqual(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/plugin/scripts/codex-preflight.ps1', '-CompanionScript', 'D:/Tools/run.mjs', '-CompanionStateDir', 'D:/Jobs'])
  expect(quotaArgs('D:/plugin', true)).toEqual(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/plugin/scripts/codex-quota.ps1'])
  expect(openFallbackArgs('D:/p/STATUS.md', true)).toEqual(['cmd', '/c', 'start', '', 'D:\\p\\STATUS.md'])
})

test('macOS runs the sh probes, passes every state root once, and opens with open', () => {
  expect(isWindowsOs(undefined)).toBe(false)
  expect(preflightArgs('/plugin', false, '/c/codex-companion.mjs', '/tmp/codex-companion', ['/state', '/tmp/codex-companion'])).toEqual(['sh', '/plugin/scripts/codex-preflight.sh', '--companion-script', '/c/codex-companion.mjs', '--state-dir', '/tmp/codex-companion', '--state-dir', '/state'])
  expect(preflightArgs('/plugin', false, '', '', [])).toEqual(['sh', '/plugin/scripts/codex-preflight.sh'])
  expect(quotaArgs('/plugin', false)).toEqual(['sh', '/plugin/scripts/codex-quota.sh'])
  expect(openFallbackArgs('/p/STATUS.md', false)).toEqual(['open', '/p/STATUS.md'])
})

test('quota parses the raw rollout event printed by codex-quota.sh', () => {
  const now = Date.parse('2026-10-06T05:00:00Z')
  const event = JSON.stringify({ timestamp: '2026-10-06T04:09:13.182Z', type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: { primary: { used_percent: 15, window_minutes: 300, resets_at: 1791274130 }, secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1791795161 }, credits: { unlimited: false, balance: '0' } } } })
  const quota = parseCodexQuota(event, now)
  expect(quota?.at).toBe('2026-10-06T04:09:13.182Z')
  expect(quota?.limits.map(l => [l.label, l.percent])).toEqual([['Codex 5h', 15], ['Codex 週', 5]])
  const nested = JSON.stringify({ timestamp: 't', payload: { info: { rate_limits: { primary: { used_percent: 40, window_minutes: 300 } } } } })
  expect(parseCodexQuota(nested, now)?.limits[0].percent).toBe(40)
})
