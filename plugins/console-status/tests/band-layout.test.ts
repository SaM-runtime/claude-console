import { expect, test } from 'claude-code/testing'

import { layoutBand } from '../hooks/band'
import { demoSnapshot, displayWidth } from '../hooks/logic'

const NOW = Date.parse('2030-01-05T12:00:00Z')

function occupied(layout: ReturnType<typeof layoutBand>) {
  const itemWidth = layout.items.reduce((sum, item) => sum + item.width, 0)
  const itemGaps = Math.max(0, layout.items.length - 1)
  const buttonGap = layout.items.length && layout.buttonWidth ? 1 : 0
  return itemWidth + itemGaps + buttonGap + layout.buttonWidth
}

test('39 columns uses compact numeric states, no next prose, and keeps strict order', () => {
  const layout = layoutBand(demoSnapshot(NOW), { columns: 39, demo: true, paneOpen: false })
  expect(layout.button).toBe('⌗')
  expect(layout.items.map(item => item.id)).toEqual(['demo', 'ACTION', 'GATE', 'RUNNING', 'SYNC', 'ci', 'context', 'IDLE'])
  expect(layout.items.map(item => item.text)).toEqual([' 示範資料 ', '●1', '◆1', '▶1', '↻1', 'CI✕1', '62%', '○1'])
  expect(occupied(layout) <= 39).toBe(true)
})

test('40 columns reserves the full button and keeps demo then a clipped one-item next action', () => {
  const layout = layoutBand(demoSnapshot(NOW), { columns: 40, demo: true, paneOpen: false })
  expect(layout.button).toBe('⌗ 面板')
  expect(layout.buttonWidth).toBe(6)
  expect(layout.items.map(item => item.id)).toEqual(['demo', 'next'])
  expect(layout.items[1].text.startsWith('下一步 ')).toBe(true)
  expect(layout.items[1].width <= 28).toBe(true)
  expect(occupied(layout) <= 40).toBe(true)
})

test('70 columns stops at the first state that cannot fit', () => {
  const layout = layoutBand(demoSnapshot(NOW), { columns: 70, demo: true, paneOpen: false })
  expect(layout.items.map(item => item.id)).toEqual(['demo', 'next', 'ACTION', 'GATE'])
  expect(occupied(layout) <= 70).toBe(true)
})

test('120 columns shows every candidate in priority order', () => {
  const layout = layoutBand(demoSnapshot(NOW), { columns: 120, demo: true, paneOpen: false })
  expect(layout.items.map(item => item.id)).toEqual(['demo', 'next', 'ACTION', 'GATE', 'RUNNING', 'SYNC', 'ci', 'context', 'IDLE'])
  expect(occupied(layout) <= 120).toBe(true)
  expect(layout.items.every(item => item.width === displayWidth(item.text) && !/[\r\n]/.test(item.text))).toBe(true)
})

test('an open pane omits next and tiny widths never overflow', () => {
  const open = layoutBand(demoSnapshot(NOW), { columns: 70, demo: true, paneOpen: true })
  expect(open.items.map(item => item.id)).toEqual(['demo', 'ACTION', 'GATE', 'RUNNING', 'SYNC'])
  const narrow = layoutBand(demoSnapshot(NOW), { columns: 40, demo: true, paneOpen: true })
  expect(narrow.items.map(item => item.id)).toEqual(['demo', 'ACTION', 'GATE'])
  for (let columns = 0; columns <= 5; columns += 1) {
    const tiny = layoutBand(demoSnapshot(NOW), { columns, demo: true, paneOpen: false })
    expect(occupied(tiny) <= columns).toBe(true)
  }
})

test('every state keeps its slot; zero counts are marked for dim drawing', () => {
  const now = NOW
  const s = { ...demoSnapshot(now), demo: false, projects: demoSnapshot(now).projects.filter(p => p.name === 'Sample-API') }
  const wide = layoutBand(s, { columns: 120, demo: false, paneOpen: true })
  expect(wide.items.map(i => [i.text, !!i.zero])).toEqual([
    ['● 需決策 0', true], ['◆ 待審核 0', true], ['▶ 執行中 0', true], ['↻ 待同步 0', true], ['上下文 62%', false], ['○ 閒置 1', false],
  ])
  const compact = layoutBand(s, { columns: 39, demo: false, paneOpen: true })
  expect(compact.items.map(i => i.text)).toEqual(['●0', '◆0', '▶0', '↻0', '62%', '○1'])
})
