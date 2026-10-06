import type { Snapshot } from '../types'
import { counts, displayWidth, next, ROTATE_PERCENT } from './logic'

/** `zero` marks a state count of 0: always shown so every state has a place, drawn dim. */
export type BandItem = { id: string; text: string; width: number; zero?: boolean }
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
  const add = (id: string, raw: string, zero = false): boolean => {
    const text = id === 'demo' ? raw.replace(/[\r\n\t]/g, ' ') : oneLine(raw)
    const width = displayWidth(text)
    if (!text || width > remaining()) return false
    if (items.length) used += 1
    items.push({ id, text, width, ...(zero ? { zero } : {}) })
    used += width
    return true
  }

  const candidates: Array<{ id: string; text: string; zero?: boolean } | { id: 'next'; nextText: string }> = []
  if (options.demo) candidates.push({ id: 'demo', text: ' 示範資料 ' })

  const stateCounts = counts(snapshot)
  // Every state keeps its slot (count 0 included) so the band reads the same from glance to glance.
  const state = (id: 'ACTION' | 'GATE' | 'RUNNING' | 'SYNC' | 'IDLE', mark: string, label: string) => {
    const count = stateCounts[id] ?? 0
    candidates.push({ id, text: compact ? `${mark}${count}` : `${mark} ${label} ${count}`, ...(count ? {} : { zero: true }) })
  }
  const context = snapshot.contextPercent !== null && snapshot.contextPercent >= ROTATE_PERCENT
  if (!compact) {
    const action = options.paneOpen ? null : next(snapshot)
    if (action) candidates.push({ id: 'next', nextText: action })
  }
  state('ACTION', '●', '需決策')
  state('GATE', '◆', '待審核')
  state('RUNNING', '▶', '執行中')
  state('SYNC', '↻', '待同步')
  // Open PRs whose CI failed: shown only when there are any, red, before the context warning.
  const ciFail = snapshot.projects.filter(p => p.pr?.state === 'OPEN' && p.pr.checks.fail > 0).length
  if (ciFail) candidates.push({ id: 'ci', text: compact ? `CI✕${ciFail}` : `CI 失敗 ${ciFail}` })
  if (context) candidates.push({ id: 'context', text: compact ? `${snapshot.contextPercent}%` : `上下文 ${snapshot.contextPercent}%` })
  state('IDLE', '○', '閒置')

  for (const candidate of candidates) {
    if ('nextText' in candidate) {
      const label = '下一步'
      const available = Math.min(28, remaining())
      if (available < displayWidth(label)) break
      const text = clipColumns(`${label} ${oneLine(candidate.nextText)}`, available)
      if (!add('next', text)) break
    } else if (!add(candidate.id, candidate.text, candidate.zero)) break
  }

  return { items, button, buttonWidth }
}
