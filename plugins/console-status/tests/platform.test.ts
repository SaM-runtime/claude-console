import { expect, test } from 'claude-code/testing'

import { parseCodexQuota } from '../hooks/logic'
import { verificationArgs } from '../hooks/actions'
import { tailArgs } from '../hooks/digest'
import { isWindowsOs, openFallbackArgs, preflightArgs, PS_UTF8, quotaArgs, tailLinesArgs } from '../hooks/platform'

test('Windows keeps the PowerShell probes and cmd start', () => {
  expect(isWindowsOs('Windows_NT')).toBe(true)
  // Every state root reaches the PowerShell preflight too, the Temp one as -CompanionStateDir and the rest joined by |.
  expect(preflightArgs('D:/plugin', true, 'D:/Tools/run.mjs', 'D:/Jobs', ['C:/state', 'D:/Jobs'])).toEqual(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/plugin/scripts/codex-preflight.ps1', '-CompanionScript', 'D:/Tools/run.mjs', '-CompanionStateDir', 'D:/Jobs', '-StateRoots', 'C:/state'])
  expect(preflightArgs('D:/plugin', true, '', 'D:/Jobs', ['D:/Jobs'])).toEqual(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/plugin/scripts/codex-preflight.ps1', '-CompanionStateDir', 'D:/Jobs'])
  expect(quotaArgs('D:/plugin', true)).toEqual(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:/plugin/scripts/codex-quota.ps1'])
  expect(openFallbackArgs('D:/p/STATUS.md', true)).toEqual(['cmd', '/c', 'start', '', 'D:\\p\\STATUS.md'])
  // A pull request's address is not a path.
  expect(openFallbackArgs('https://github.com/o/r/pull/7', true)).toEqual(['cmd', '/c', 'start', '', 'https://github.com/o/r/pull/7'])
})

test('PowerShell commands that print text print UTF-8', () => {
  // Left alone, Windows PowerShell prints in the console's code page (950 on a Traditional Chinese Windows).
  expect(PS_UTF8).toBe('try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}; ')
  for (const argv of [verificationArgs('npm test', true), tailArgs("D:/it's/a.jsonl", true, 100), tailLinesArgs("D:/it's/a.jsonl", true, 400)]) {
    expect(argv[0]).toBe('powershell')
    expect(argv.at(-1)!.startsWith(PS_UTF8)).toBe(true)
  }
  expect(tailLinesArgs("D:/it's/a.jsonl", true, 400).at(-1)).toBe(`${PS_UTF8}Get-Content -LiteralPath 'D:/it''s/a.jsonl' -Tail 400 -Encoding UTF8`)
  expect(tailLinesArgs('/p/a.jsonl', false, 400)).toEqual(['tail', '-n', '400', '/p/a.jsonl'])
})

test('macOS runs the sh probes, passes every state root once, and opens with open', () => {
  expect(isWindowsOs(undefined)).toBe(false)
  expect(preflightArgs('/plugin', false, '/c/codex-companion.mjs', '/tmp/codex-companion', ['/state', '/tmp/codex-companion'])).toEqual(['sh', '/plugin/scripts/codex-preflight.sh', '--companion-script', '/c/codex-companion.mjs', '--state-dir', '/tmp/codex-companion', '--state-dir', '/state'])
  expect(preflightArgs('/plugin', false, '', '', [])).toEqual(['sh', '/plugin/scripts/codex-preflight.sh'])
  expect(quotaArgs('/plugin', false)).toEqual(['sh', '/plugin/scripts/codex-quota.sh'])
  expect(openFallbackArgs('/p/STATUS.md', false)).toEqual(['open', '/p/STATUS.md'])
})

test('quota parses the reading codex-quota.ps1 prints', () => {
  const now = Date.parse('2026-10-06T05:00:00Z')
  const printed = '{"at":"2026-10-06T04:09:13.182Z","rate_limits":{"primary":{"used_percent":15,"window_minutes":300,"resets_at":1791274130},"secondary":{"used_percent":5,"window_minutes":10080,"resets_at":1791795161}}}\r\n'
  const quota = parseCodexQuota(printed, now)
  expect(quota?.at).toBe('2026-10-06T04:09:13.182Z')
  expect(quota?.limits.map(l => [l.label, l.percent])).toEqual([['Codex 5 小時', 15], ['Codex 週', 5]])
})

test('quota parses the raw rollout event printed by codex-quota.sh', () => {
  const now = Date.parse('2026-10-06T05:00:00Z')
  const event = JSON.stringify({ timestamp: '2026-10-06T04:09:13.182Z', type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: { primary: { used_percent: 15, window_minutes: 300, resets_at: 1791274130 }, secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1791795161 }, credits: { unlimited: false, balance: '0' } } } })
  const quota = parseCodexQuota(event, now)
  expect(quota?.at).toBe('2026-10-06T04:09:13.182Z')
  expect(quota?.limits.map(l => [l.label, l.percent])).toEqual([['Codex 5 小時', 15], ['Codex 週', 5]])
  const nested = JSON.stringify({ timestamp: 't', payload: { info: { rate_limits: { primary: { used_percent: 40, window_minutes: 300 } } } } })
  expect(parseCodexQuota(nested, now)?.limits[0].percent).toBe(40)
})
