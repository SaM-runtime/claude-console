import { expect, test } from 'claude-code/testing'
import { meterCells, METER } from '../hooks/battery'

test('the meter fills from the left, shows a sliver for any amount, and has no cell past the track', () => {
  for (const percent of [0, 1, 3, 38, 50, 99, 100]) {
    const m = meterCells(percent)
    expect(m.full + (m.part ? 1 : 0) + m.empty).toBe(METER)
  }
  expect(meterCells(0)).toEqual({ full: 0, part: '', empty: METER })
  // 3% left is still drawn, on the left, rather than as an empty bar.
  expect(meterCells(3).full + (meterCells(3).part ? 1 : 0)).toBe(1)
  expect(meterCells(3).part).not.toBe('')
  expect(meterCells(100)).toEqual({ full: METER, part: '', empty: 0 })
  expect(meterCells(50)).toEqual({ full: 6, part: '', empty: 6 })
})
