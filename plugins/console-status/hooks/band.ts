import type { Snapshot } from '../types'
import { counts, displayWidth, next, ROTATE_PERCENT } from './logic'

export type BandItem = { id: string; text: string; width: number }
export type BandLayout = { items: BandItem[]; button: string; buttonWidth: number }

const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

/** Clip without splitting a Unicode code point or exceeding terminal display columns. */
function clipColumns(value: string, max: number): string {
  if (max <= 0) return ''
  let out = ''
  let width = 0
  for (const char of value) {
    const charWidth = displayWidth(char)
    if (width + charWidth > max) break
    out += char
    width += charWidth
  }
  return out.trimEnd()
}

/**
 * One-line band content in strict priority order. The caller renders the returned items with a
 * one-column gap, then a spacer and the reserved right-hand button.
 */
export function layoutBand(snapshot: Snapshot, options: { columns: number; demo: boolean; paneOpen: boolean }): BandLayout {
  const columns = Math.max(0, Math.floor(Number.isFinite(options.columns) ? options.columns : 0))
  const compact = columns < 40
  const fullButton = compact ? '⌗' : '⌗ 面板'
  const button = clipColumns(fullButton, columns)
  const buttonWidth = displayWidth(button)
  // Reserve one column between content and a visible button. It is reclaimed when no item fits.
  const itemBudget = Math.max(0, columns - buttonWidth - (buttonWidth > 0 && columns > buttonWidth ? 1 : 0))
  const items: BandItem[] = []
  let used = 0

  const remaining = () => itemBudget - used - (items.length ? 1 : 0)
  const add = (id: string, raw: string): boolean => {
    const text = id === 'demo' ? raw.replace(/[\r\n\t]/g, ' ') : oneLine(raw)
    const width = displayWidth(text)
    if (!text || width > remaining()) return false
    if (items.length) used += 1
    items.push({ id, text, width })
    used += width
    return true
  }

  const candidates: Array<{ id: string; text: string } | { id: 'next'; nextText: string }> = []
  if (options.demo) candidates.push({ id: 'demo', text: ' 示範資料 ' })

  const stateCounts = counts(snapshot)
  if (compact) {
    if (stateCounts.ACTION) candidates.push({ id: 'ACTION', text: `●${stateCounts.ACTION}` })
    if (stateCounts.GATE) candidates.push({ id: 'GATE', text: `◆${stateCounts.GATE}` })
    if (stateCounts.RUNNING) candidates.push({ id: 'RUNNING', text: `▶${stateCounts.RUNNING}` })
    if (stateCounts.SYNC) candidates.push({ id: 'SYNC', text: `↻${stateCounts.SYNC}` })
    if (snapshot.contextPercent !== null && snapshot.contextPercent >= ROTATE_PERCENT) candidates.push({ id: 'context', text: `${snapshot.contextPercent}%` })
    if (stateCounts.IDLE) candidates.push({ id: 'IDLE', text: `○${stateCounts.IDLE}` })
  } else {
    const action = options.paneOpen ? null : next(snapshot)
    if (action) candidates.push({ id: 'next', nextText: action })
    if (stateCounts.ACTION) candidates.push({ id: 'ACTION', text: `● 需決策 ${stateCounts.ACTION}` })
    if (stateCounts.GATE) candidates.push({ id: 'GATE', text: `◆ 待審核 ${stateCounts.GATE}` })
    if (stateCounts.RUNNING) candidates.push({ id: 'RUNNING', text: `▶ 執行中 ${stateCounts.RUNNING}` })
    if (stateCounts.SYNC) candidates.push({ id: 'SYNC', text: `↻ 待同步 ${stateCounts.SYNC}` })
    if (snapshot.contextPercent !== null && snapshot.contextPercent >= ROTATE_PERCENT) candidates.push({ id: 'context', text: `上下文 ${snapshot.contextPercent}%` })
    if (stateCounts.IDLE) candidates.push({ id: 'IDLE', text: `○ 閒置 ${stateCounts.IDLE}` })
  }

  for (const candidate of candidates) {
    if ('nextText' in candidate) {
      const label = '下一步'
      const available = Math.min(28, remaining())
      if (available < displayWidth(label)) break
      const text = clipColumns(`${label} ${oneLine(candidate.nextText)}`, available)
      if (!add('next', text)) break
    } else if (!add(candidate.id, candidate.text)) break
  }

  return { items, button, buttonWidth }
}
