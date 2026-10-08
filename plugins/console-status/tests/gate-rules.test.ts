import { expect, test } from 'claude-code/testing'
import { GATE_PENDING_MS, reviewTurnMatches, staleGate, stalePendingReason } from '../hooks/actions'
import { buildProject } from '../hooks/logic'

const NOW = Date.parse('2030-01-05T12:00:00Z')
const PROMPT = '依 claude-console skill 審核「Project Alpha」的 review 關卡。依證據判斷，指出結果與理由，更新關卡結論；不得執行 release 或正式環境變更。'
const request = (over: Partial<{ turnId: string; gate: string }> = {}) => ({ text: `${PROMPT}\n\n【主控台面板選取】…`, projectName: 'Project Alpha', at: NOW, gate: 'review：Inspect evidence', ...over })
const project = (gate: string) => buildProject({ name: 'Project Alpha', statusPath: 'D:/Project Alpha/.console/STATUS.md' },
  `<!-- CARD -->\n- 更新：2030-01-05 08:00\n- 狀態：Ready\n- 等使用者：無\n- 下一步：無\n- 驗證：node test.mjs\n- 關卡：${gate}\n<!-- /CARD -->`, [], NOW)

test('reviewTurnMatches: the exact prompt, the host-wrapped prompt and a rewritten one match; another prompt does not', () => {
  const r = request()
  expect(reviewTurnMatches(r, r.text)).toBe(true)
  expect(reviewTurnMatches(r, `The console-status plugin sent a message:\n${r.text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns; it starts this turn in the user's place. Address the message above.`)).toBe(true)
  expect(reviewTurnMatches(r, `${r.text}\n[rewritten beneath]`)).toBe(true)
  expect(reviewTurnMatches(r, '依 claude-console skill 審核「Project Beta」的 review 關卡。…')).toBe(false)
  expect(reviewTurnMatches(r, 'fix the tests')).toBe(false)
  // A request whose first line is too short to be a signature never matches by inclusion.
  expect(reviewTurnMatches({ text: 'review\n\nmore' }, 'please review this')).toBe(false)
})

test('staleGate: only a gate pending on a CARD without a gate', () => {
  expect(staleGate({ kind: 'gate', at: NOW }, project('無'))).toBe(true)
  expect(staleGate({ kind: 'gate', at: NOW }, project('review：Inspect evidence'))).toBe(false)
  expect(staleGate({ kind: 'verify', at: NOW }, project('無'))).toBe(false)
  expect(staleGate(undefined, project('無'))).toBe(false)
})

test('stalePendingReason: a review is dropped when its gate moved on or it timed out unbound; locked work is kept; a lock-less action from an earlier lifetime is dropped', () => {
  const gate = { kind: 'gate' as const, at: NOW }
  const still = project('review：Inspect evidence')
  // Alive: the gate is unchanged and the wait is young.
  expect(stalePendingReason(gate, request(), still, NOW + 1000, false, false)).toBe(null)
  // The CARD moved past the gate, whether cleared or replaced.
  expect(stalePendingReason(gate, request(), project('無'), NOW + 1000, false, false)).toBe('關卡已變更')
  expect(stalePendingReason(gate, request(), project('release：Ship it'), NOW + 1000, false, false)).toBe('關卡已變更')
  // A request from before the gate was recorded cannot be compared, so only time ends it.
  expect(stalePendingReason(gate, { ...request(), gate: undefined }, project('無'), NOW + 1000, false, false)).toBe(null)
  // Timed out with no turn bound, or bound but not running.
  expect(stalePendingReason(gate, request(), still, NOW + GATE_PENDING_MS, false, false)).toBe('審核狀態已逾時')
  expect(stalePendingReason(gate, request({ turnId: 't' }), still, NOW + GATE_PENDING_MS, false, false)).toBe('審核狀態已逾時')
  // Bound and running: wait for the answer, however long the turn takes.
  expect(stalePendingReason(gate, request({ turnId: 't' }), still, NOW + GATE_PENDING_MS, false, true)).toBe(null)
  // A gate pending with no request: alive only while its press still holds the lock.
  expect(stalePendingReason(gate, undefined, still, NOW, true, false)).toBe(null)
  expect(stalePendingReason(gate, undefined, still, NOW, false, false)).toBe('審核已失去追蹤')
  // Any other action lives exactly as long as its lock in this plugin lifetime.
  expect(stalePendingReason({ kind: 'verify', at: NOW }, undefined, still, NOW, true, false)).toBe(null)
  expect(stalePendingReason({ kind: 'sync', at: NOW }, undefined, still, NOW, true, false)).toBe(null)
  expect(stalePendingReason({ kind: 'verify', at: NOW }, undefined, still, NOW, false, false)).toBe('動作已失去追蹤')
  expect(stalePendingReason({ kind: 'continue', at: NOW }, undefined, undefined, NOW, false, false)).toBe('動作已失去追蹤')
})
