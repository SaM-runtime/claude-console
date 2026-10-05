import { expect, test } from 'claude-code/testing'
import Battery from '../hooks/battery'
import Feed from '../hooks/feed'
import Spinner from '../hooks/spinner'
import { trackRowChanges } from '../hooks/presentation'
import { demoSnapshot } from '../hooks/logic'

// Only the engine boundary is fake: production Client modules own timing, state and drawing.
function surfaceHarness() {
  let state: any
  let renders = 0
  let writes = 0
  let rendering = false
  const timers = new Map<number, { ms: number; due: number; fn: () => void }>()
  let sequence = 0
  let time = 0
  let render: () => any
  let tree: any
  const surface: any = {
    elements: Object.fromEntries(['Box', 'Text'].map(type => [type, (props: any) => ({ type, props, children: props.children })])),
    get state() { return state }, columns: 80, rows: 1,
    setState(value: any) { if (rendering) throw new Error('setState during render'); state = value; writes++; render() },
    every(ms: number, fn: () => void) { const id = ++sequence; timers.set(id, { ms, due: time + ms, fn }); return () => timers.delete(id) },
  }
  return {
    draw(module: any, props: any) { render = () => { rendering = true; renders++; try { tree = module(props, surface); return tree } finally { rendering = false } }; return render() },
    advance(ms: number) {
      const end = time + ms
      while (true) {
        const next = [...timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
        if (!next) break
        time = next[1].due
        next[1].due += next[1].ms
        next[1].fn()
      }
      time = end
    },
    active: () => timers.size, writes: () => writes, renders: () => renders,
    tree: () => tree,
    unmount: () => timers.clear(),
  }
}

test('battery stops after reaching its target and retargets without duplicate timers or render writes', () => {
  const ui = surfaceHarness()
  ui.draw(Battery, { percent: 38, tone: '#EF9F76' })
  ui.draw(Battery, { percent: 38, tone: '#EF9F76' })
  expect(ui.active()).toBe(1)
  expect(ui.writes()).toBe(0)
  ui.advance(400)
  expect(ui.active()).toBe(0)
  const rendered = ui.renders()
  ui.advance(3000)
  expect(ui.renders()).toBe(rendered)
  ui.draw(Battery, { percent: 70, tone: '#A6D189' })
  ui.advance(120)
  ui.draw(Battery, { percent: 0, tone: '#E78284' })
  expect(ui.active()).toBe(1)
  ui.advance(400)
  expect(ui.active()).toBe(0)
  const empty = surfaceHarness()
  empty.draw(Battery, { percent: 0, tone: '#E78284' })
  expect(empty.active()).toBe(0)
})

test('feed expires new-event emphasis at three seconds and sleeps until another event arrives', () => {
  const ui = surfaceHarness()
  const base = { now: 10_000, normal: '#CAD3E0', bright: '#E5EAF0', dim: '#6E7787' }
  ui.draw(Feed, { ...base, events: [{ at: 10_000, text: 'Sample event', color: '#A6D189' }] })
  expect(ui.active()).toBe(1)
  expect(ui.writes()).toBe(0)
  expect(JSON.stringify(ui.tree()).includes('"color":"#E5EAF0"')).toBe(true)
  ui.advance(2900)
  expect(ui.active()).toBe(1)
  ui.advance(100)
  expect(ui.active()).toBe(0)
  expect(JSON.stringify(ui.tree()).includes('"color":"#E5EAF0"')).toBe(false)
  expect(JSON.stringify(ui.tree()).includes('"color":"#CAD3E0"')).toBe(true)
  const rendered = ui.renders()
  ui.advance(2000)
  expect(ui.renders()).toBe(rendered)
  ui.draw(Feed, { ...base, now: 15_000, events: [{ at: 15_000, text: 'Second event', color: '#A6D189' }] })
  expect(ui.active()).toBe(1)
  ui.draw(Feed, { ...base, now: 15_000, events: [] })
  expect(ui.active()).toBe(0)
})

test('refresh spinner only starts once and its surface cancels it on unmount', () => {
  const ui = surfaceHarness()
  ui.draw(Spinner, { color: '#6E7787' })
  ui.draw(Spinner, { color: '#6E7787' })
  expect(ui.active()).toBe(1)
  expect(ui.writes()).toBe(0)
  ui.advance(220)
  expect(ui.writes()).toBe(2)
  ui.unmount()
  ui.advance(1000)
  expect(ui.writes()).toBe(2)
})

test('row transition timestamps survive refresh without restarting highlights', () => {
  const before = demoSnapshot(10_000)
  expect(trackRowChanges(null, before, 10_000).projects[0]?.changedAt).toBeUndefined()
  const current = { ...before, projects: before.projects.map((p, i) => i === 0 ? { ...p, ask: '無' } : p) }
  const changed = trackRowChanges(before, current, 11_000)
  expect(changed.projects[0]?.changedAt).toBe(11_000)
  expect(changed.projects[1]?.changedAt).toBeUndefined()
  const refreshed = trackRowChanges(changed, { ...current, at: 12_000 }, 12_000)
  expect(refreshed.projects[0]?.changedAt).toBe(11_000)
})
