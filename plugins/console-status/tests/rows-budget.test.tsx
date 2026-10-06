import { expect, test } from 'claude-code/testing'

import Rows, { fit, type RowSpec, type RowsProps } from '../hooks/rows'
import { displayWidth } from '../hooks/logic'

// The engine boundary only: a frame clock whose setState coalesces into one redraw per frame,
// as the surface does ("several calls before it coalesce into one redraw").
function surfaceHarness(columns = 100) {
  let dirty = false
  let renders = 0
  let writes = 0
  let rendering = false
  let props: RowsProps
  let tree: any
  let time = 0
  let sequence = 0
  const renderedAt: number[] = []
  const timers = new Map<number, { ms: number; due: number; fn: () => void }>()
  const surface: any = {
    elements: Object.fromEntries(['Box', 'Text'].map(type => [type, (p: any) => ({ type, props: p })])),
    state: undefined,
    columns,
    rows: 0,
    setState(value: any) {
      if (rendering) throw new Error('setState during render')
      surface.state = value
      writes += 1
      dirty = true
    },
    every(ms: number, fn: () => void) {
      const id = ++sequence
      timers.set(id, { ms, due: time + ms, fn })
      return () => { timers.delete(id) }
    },
    onPointer() { return () => {} },
    onKey() { return () => {} },
    post() {},
  }
  const render = () => {
    rendering = true
    renders += 1
    renderedAt.push(time)
    try { tree = Rows(props, surface) } finally { rendering = false }
    dirty = false
  }
  return {
    draw(next: RowsProps) { props = next; render() },
    /** Fires every timer the move crosses, then draws once if any of them wrote state. */
    advance(ms: number) {
      const end = time + ms
      while (true) {
        let next: { ms: number; due: number; fn: () => void } | undefined
        for (const t of timers.values()) if (t.due <= end && (!next || t.due < next.due)) next = t
        if (!next) break
        time = next.due
        next.due += next.ms
        next.fn()
      }
      time = end
      if (dirty) render()
    },
    intervals: () => [...timers.values()].map(t => t.ms),
    active: () => timers.size,
    renders: () => renders,
    writes: () => writes,
    renderedAt: () => renderedAt,
    tree: () => tree,
    unmount: () => timers.clear(),
  }
}

const AMBER = ['#3A3120', '#443925', '#4D412B']
const decision = (id: string, item = '等待選擇是否要合併這個分支'): RowSpec => ({
  id,
  breathe: AMBER,
  cells: [
    { t: ' 需決策 ', c: '#F0C674', bg: '#3A3120', b: true, w: 8 },
    { t: id, w: 13 },
    { t: item },
    { t: '12m', w: 4, right: true },
  ],
})

const table = (rows: RowSpec[], now = 10_000): RowsProps => ({
  rows,
  now,
  selected: null,
  cursor: -1,
  selectedBg: '#30465D',
  hoverBg: '#253446',
  shimmer: ['#4E8F87', '#6FB3AA', '#9EE0D6', '#E6FFFB'],
  changed: ['#2C3B4B', '#24303D', '#1C252F'],
})

// The 0.2.0 implementation, kept here as the reference the linear fit must match.
function oldFit(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (displayWidth(text) <= columns) return text
  let result = ''
  for (const char of text) {
    if (displayWidth(result + char) > columns - 1) break
    result += char
  }
  return result + '…'
}

test('linear fit matches the 0.2.0 output for ASCII, CJK, emoji and exact-width boundaries', () => {
  const samples = [
    '',
    'a',
    'Project Alpha',
    'needs a decision on the release branch',
    '需決策',
    '等待選擇是否要合併這個分支',
    'mixed 中文 and ascii 文字',
    '🚀 deploy 🎉 done ✅',
    '👍🏽 skin tone',
    'é combining accent',
    '全形ＡＢＣ半形abc',
    '한국어 텍스트',
  ]
  let checked = 0
  for (const text of samples) {
    const full = displayWidth(text)
    for (let columns = -1; columns <= full + 2; columns += 1) {
      const got = fit(text, columns)
      expect(got).toBe(oldFit(text, columns))
      if (columns > 0) expect(displayWidth(got)).toBeLessThanOrEqual(columns)
      checked += 1
    }
    // Exact width keeps the whole text; one column less clips with an ellipsis.
    expect(fit(text, full)).toBe(text)
    if (full > 1) expect(fit(text, full - 1).endsWith('…')).toBe(true)
  }
  expect(checked).toBeGreaterThan(100)
})

test('a breath-only table redraws at most once per 200 ms over ten seconds and only when a chip changes', () => {
  const ui = surfaceHarness()
  ui.draw(table([decision('Alpha'), decision('Beta'), decision('Gamma')]))
  expect(ui.intervals()).toEqual([200])
  const first = ui.renders()
  for (let step = 0; step < 100; step += 1) ui.advance(100)
  const at = ui.renderedAt().slice(first)
  for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(200)
  // Four colour moves per 1.6 s cycle: about 25 redraws in ten seconds, never 100.
  expect(at.length).toBeLessThanOrEqual(50)
  expect(at.length).toBeGreaterThanOrEqual(20)
  expect(ui.writes()).toBe(at.length)
  expect(ui.active()).toBe(1)
})

test('a burst of catch-up ticks after a suspend costs one redraw', () => {
  const ui = surfaceHarness()
  ui.draw(table([decision('Alpha'), decision('Beta')]))
  const before = ui.renders()
  const started = Date.now()
  ui.advance(60 * 60 * 1000)
  expect(Date.now() - started).toBeLessThan(1000)
  expect(ui.renders() - before).toBeLessThanOrEqual(1)
  expect(ui.active()).toBe(1)
})

test('thirty rows of long CJK cells render a hundred ticks well inside the 1000 ms budget', () => {
  const long = '請確認是否要把這個專案的發佈分支合併回主線並同步所有相關的狀態卡與工作紀錄，然後通知負責人'
  const rows: RowSpec[] = Array.from({ length: 30 }, (_, i) => {
    const r = decision(`專案名稱非常長的第${i}個專案`, long + long)
    if (i % 3 === 0) return { ...r, breathe: undefined, shimmer: true }
    if (i % 5 === 0) return { ...r, changedAt: 10_000 }
    return r
  })
  const ui = surfaceHarness(160)
  ui.draw(table(rows))
  let slowest = 0
  const started = Date.now()
  for (let tick = 0; tick < 100; tick += 1) {
    const t = Date.now()
    ui.advance(100)
    slowest = Math.max(slowest, Date.now() - t)
  }
  const total = Date.now() - started
  expect(ui.renders()).toBeGreaterThan(90)
  expect(slowest).toBeLessThan(250)
  expect(total).toBeLessThan(1000)
  expect(JSON.stringify(ui.tree())).toMatch('…')
})

test('the timer stops when rows stop being live, never leaks across row changes, and ends on unmount', () => {
  const ui = surfaceHarness()
  const live = table([decision('Alpha')])
  const still = table([{ ...decision('Alpha'), breathe: undefined }])
  for (let i = 0; i < 5; i += 1) {
    ui.draw(live)
    expect(ui.active()).toBe(1)
    ui.advance(450)
    ui.draw(still)
    expect(ui.active()).toBe(0)
  }

  // A change highlight runs the 100 ms clock and stops by itself once it has faded.
  const fading = surfaceHarness()
  fading.draw(table([{ ...decision('Alpha'), breathe: undefined, changedAt: 10_000 }]))
  expect(fading.intervals()).toEqual([100])
  fading.advance(1_600)
  expect(fading.active()).toBe(0)
  const settled = fading.renders()
  fading.advance(10_000)
  expect(fading.renders()).toBe(settled)

  // Highlight plus breath drops back to the slow breath clock after the fade.
  const both = surfaceHarness()
  both.draw(table([{ ...decision('Alpha'), changedAt: 10_000 }]))
  expect(both.intervals()).toEqual([100])
  both.advance(1_600)
  expect(both.intervals()).toEqual([200])

  ui.draw(live)
  ui.unmount()
  const rendered = ui.renders()
  ui.advance(5_000)
  expect(ui.renders()).toBe(rendered)
})
