import { expect, test } from 'claude-code/testing'
import { limitPace, spanText, windowMs } from '../hooks/pace'
import { LOOP_NOTE, LoopMemory, loopKey, loopMode } from '../hooks/loop'
import { hitRate, hitText } from '../hooks/cache'

const H = 3_600_000
const now = Date.parse('2030-01-05T12:00:00Z')
const resetIn = (ms: number) => new Date(now + ms).toISOString()

test('pace: a window used faster than it refills says when it runs out; a steady one or a young one says nothing', () => {
  expect(windowMs('five_hour')).toBe(5 * H)
  expect(windowMs('seven_day_opus')).toBe(7 * 24 * H)
  expect(windowMs('spend_limit')).toBe(null)
  // 2 of 5 hours gone, 60% used: 30%/h, 40% left lasts 1h20m, reset is 3h away.
  expect(limitPace('five_hour', 60, resetIn(3 * H), now)).toEqual({ lasts: false, emptyInMs: 80 * 60_000, text: '照目前速度約 1 小時 20 分後用完', tone: 'amber' })
  // 4 of 5 hours gone, 90% used: 22.5%/h, 10% left lasts under an hour.
  expect(limitPace('five_hour', 90, resetIn(H), now)).toMatchObject({ lasts: false, tone: 'red', text: '照目前速度約 27 分後用完' })
  expect(limitPace('five_hour', 30, resetIn(3 * H), now)).toEqual({ lasts: true })
  expect(limitPace('five_hour', 50, resetIn(5 * H - 5 * 60_000), now)).toBe(null)
  expect(limitPace('five_hour', 0, resetIn(H), now)).toBe(null)
  expect(limitPace('five_hour', 100, resetIn(H), now)).toBe(null)
  expect(limitPace('spend_limit', 60, resetIn(H), now)).toBe(null)
  expect(limitPace('seven_day', 80, resetIn(4 * 24 * H), now)).toMatchObject({ lasts: false, text: '照目前速度約 18 小時後用完'.replace('18 小時', '18 小時 0 分') })
  expect(spanText(26 * H)).toBe('1 天 2 小時')
})

test('hit rate: cache reads over all input, toned by how much the cache served', () => {
  expect(hitRate({ input_tokens: 2, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 19_998 })).toBe(0.9)
  expect(hitRate({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(null)
  expect(hitText(0.9)).toEqual({ text: '命中 90%', tone: 'dim' })
  expect(hitText(0.5).tone).toBe('amber')
  expect(hitText(0.1).tone).toBe('red')
})

test('loop guard: the second identical failure is flagged once; a different error, a success or a volatile error is not', () => {
  const m = new LoopMemory()
  const key = loopKey({ tool: 'Bash', command: 'npm test', description: 'run', tool_use_id: 'a' })
  expect(loopKey({ tool: 'Bash', description: 'other words', command: 'npm test', tool_use_id: 'b' })).toBe(key)
  expect(loopKey({ tool: 'Bash', command: 'npm test', agentId: 'sub' })).not.toBe(key)
  expect(m.record(key, 'Exit code 1\nFAIL  x.test.ts')).toBe(false)
  expect(m.record(key, 'Exit code 1\n FAIL x.test.ts')).toBe(true)
  expect(m.record(key, 'Exit code 1\nFAIL x.test.ts')).toBe(false)
  m.record(key, null)
  expect(m.record(key, 'A')).toBe(false)
  expect(m.record(key, 'B')).toBe(false)
  expect(m.record(key, 'A')).toBe(false)
  expect(m.record(key, 'A')).toBe(true)
  const t = loopKey({ tool: 'Bash', command: 'curl x' })
  m.record(t, 'failed at 12:00:01')
  expect(m.record(t, 'failed at 12:00:01')).toBe(false)
  expect(loopMode(undefined)).toBe('on')
  expect(loopMode(' OFF ')).toBe('off')
  expect(LOOP_NOTE.includes('不要第三次')).toBe(true)
})
