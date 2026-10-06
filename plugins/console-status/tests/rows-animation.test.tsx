import { expect, test } from 'claude-code/testing'

import Rows, { type RowSpec, type RowsProps } from '../hooks/rows'

const Box = (props: any) => ({ type: 'Box', props }) as any
const Text = (props: any) => ({ type: 'Text', props }) as any

function harness(props: RowsProps) {
  let callback: (() => void) | undefined
  let starts = 0
  let stops = 0
  let setStates = 0
  const surface: any = {
    elements: { Box, Text },
    state: undefined,
    columns: 60,
    rows: props.rows.length,
    setState(next: unknown) { setStates += 1; surface.state = next },
    every(_ms: number, fn: () => void) {
      starts += 1
      callback = fn
      return () => { stops += 1; callback = undefined }
    },
    onPointer() { return () => {} },
    onKey() { return () => {} },
    post() {},
  }
  return {
    surface,
    render(next = props) { return Rows(next, surface) as any },
    tick(count = 1) { for (let i = 0; i < count; i += 1) callback?.() },
    stats() { return { starts, stops, setStates, running: Boolean(callback) } },
  }
}

const row = (extra: Partial<RowSpec> = {}): RowSpec => ({
  id: 'alpha',
  cells: [
    { t: ' 需決策 ', c: '#F0C674', bg: '#3A3120', w: 8 },
    { t: 'Project Alpha', w: 13 },
    { t: '等待選擇' },
    { t: '12m', w: 4 },
  ],
  ...extra,
})

const props = (rows: RowSpec[], now = 10_000): RowsProps => ({
  rows,
  now,
  selected: null,
  cursor: -1,
  selectedBg: '#30465D',
  hoverBg: '#253446',
  shimmer: ['#4E8F87', '#6FB3AA', '#9EE0D6', '#E6FFFB'],
  changed: ['#3B4A47', '#303C3A', '#27312F'],
})

test('rows Client changes state only from a tick and stops when no animation remains', () => {
  const still = harness(props([row()]))
  still.render()
  still.render()
  expect(still.stats()).toEqual({ starts: 0, stops: 0, setStates: 0, running: false })

  const animated = harness(props([row({ breathe: ['#3A3120', '#51452D', '#67583A'] })]))
  animated.render()
  expect(animated.stats()).toEqual({ starts: 1, stops: 0, setStates: 0, running: true })
  // Breath-only rows tick every 200 ms and write state only when the chip colour moves:
  // the first tick stays on the low step, the second reaches the middle one.
  animated.tick()
  expect(animated.stats().setStates).toBe(0)
  animated.tick()
  expect(animated.stats().setStates).toBe(1)
  animated.render(props([row()], 10_110))
  expect(animated.stats()).toEqual({ starts: 1, stops: 1, setStates: 1, running: false })
})

test('rows Client breathes decision chips, keeps running motion, and expires changed-row highlight', () => {
  const initial = props([row({
    shimmer: true,
    breathe: ['#3A3120', '#51452D', '#67583A'],
    changedAt: 10_000,
  })])
  const client = harness(initial)
  const first = JSON.stringify(client.render())
  expect(first).toMatch('#3A3120')
  expect(first).toMatch('⠋')
  expect(first).toMatch('#3B4A47')

  client.tick(8)
  const middle = JSON.stringify(client.render())
  expect(middle).toMatch('#67583A')
  expect(middle).not.toMatch('⠋')

  const changedOnly = props([row({ changedAt: 10_000 })], 10_000)
  changedOnly.selected = 'alpha'
  const fading = harness(changedOnly)
  expect(JSON.stringify(fading.render())).toMatch('#3B4A47')
  fading.tick(14)
  expect(JSON.stringify(fading.render())).toMatch('#27312F')
  fading.tick()
  const done = JSON.stringify(fading.render())
  expect(done).not.toMatch('#3B4A47')
  expect(done).not.toMatch('#303C3A')
  expect(done).not.toMatch('#27312F')
  expect(done).toMatch('#30465D')
  expect(fading.stats().running).toBe(false)
})
