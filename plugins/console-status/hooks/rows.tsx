// Client module: the project table rows. Pointer hover, click to select, right-click to copy the
// row menu, ↑/↓/Enter from the keyboard, and a shimmer on rows whose executor job is running.
// Pattern borrowed from data-goblin/claude-code-filetree (rows.tsx), rewritten for this table.
import type { ClientModule } from 'claude-code'
import { displayWidth } from './logic'

export type Cell = { t: string; c?: string; bg?: string; b?: boolean; w?: number; right?: boolean }
export type RowSpec = {
  id: string
  cells: Cell[]
  shimmer?: boolean
  /** Background colours for the slow decision/review-chip breath. */
  breathe?: string[]
  /** Wall-clock time at which this row's semantic state last changed. */
  changedAt?: number
}
export type RowsProps = {
  rows: RowSpec[]
  now: number
  selected: string | null
  cursor: number
  selectedBg: string
  hoverBg: string
  shimmer: string[]
  /** Strong-to-weak row backgrounds used during the 1.5 s change highlight. */
  changed: string[]
}
type Local = { hover: number; phase: number; now: number }
type Runtime = { fallback: Local; latestPropNow: number; stop?: () => void }

const TICK_MS = 100
const CHANGE_MS = 1_500
const runtimes = new WeakMap<object, Runtime>()
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function shade(i: number, phase: number, len: number, palette: string[]): string {
  const band = ((phase * 1.4) % (len + 8)) - 4
  const d = Math.abs(i - band)
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? '#8BD5CA'
}

function breathColor(palette: string[], now: number): string | undefined {
  // Eight calm steps make one 1.6 s cycle: low → middle → high → middle → low.
  const step = Math.floor((now % 1_600) / 200)
  const index = [0, 0, 1, 2, 2, 1, 0, 0][step] ?? 0
  return palette[index] ?? palette[0]
}

function changedColor(changedAt: number | undefined, now: number, palette: string[]): string | undefined {
  if (changedAt === undefined) return undefined
  const age = now - changedAt
  if (age < 0 || age >= CHANGE_MS) return undefined
  return palette[Math.min(palette.length - 1, Math.floor(age / 500))]
}

function fit(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (displayWidth(text) <= columns) return text
  let result = ''
  for (const char of text) {
    if (displayWidth(result + char) > columns - 1) break
    result += char
  }
  return result + '…'
}

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let runtime = runtimes.get(surface)
  if (!runtime) {
    runtime = { fallback: { hover: -1, phase: 0, now: props.now }, latestPropNow: props.now }
    runtimes.set(surface, runtime)
  }
  runtime.latestPropNow = Math.max(runtime.latestPropNow, props.now)
  const state = surface.state ?? runtime.fallback
  const renderNow = Math.max(state.now, runtime.latestPropNow)
  const live = props.rows.some(r => r.shimmer || Boolean(r.breathe?.length) || changedColor(r.changedAt, renderNow, props.changed) !== undefined)
  if (live && !runtime.stop) {
    runtime.stop = surface.every(TICK_MS, () => {
      const cur = surface.state ?? runtime!.fallback
      const next = {
        ...cur,
        phase: cur.phase + 1,
        now: Math.max(cur.now, runtime!.latestPropNow) + TICK_MS,
      }
      runtime!.fallback = next
      surface.setState(next)
    })
  } else if (!live && runtime.stop) {
    runtime.stop()
    runtime.stop = undefined
  }
  surface.onPointer(e => {
    const cur = surface.state ?? runtime!.fallback
    if (e.type === 'leave' || e.y < 0 || e.y >= props.rows.length) {
      if (cur.hover !== -1) {
        const next = { ...cur, hover: -1 }
        runtime!.fallback = next
        surface.setState(next)
        surface.post({ hover: null })
      }
      return
    }
    if ((e.type === 'move' || e.type === 'enter') && cur.hover !== e.y) {
      const next = { ...cur, hover: e.y }
      runtime!.fallback = next
      surface.setState(next)
      surface.post({ hover: props.rows[e.y]?.id ?? null })
    }
    const row = props.rows[e.y]
    if (!row || e.type !== 'down') return
    if (e.button === 'right') surface.post({ copy: row.id })
    else surface.post({ press: row.id })
  })
  surface.onKey(e => surface.post({ key: e.key }))

  // Reserve the rightmost column; the item uses only the space left after fixed cells and gaps.
  const firstCells = props.rows[0]?.cells ?? []
  const available = Math.max(0, (surface.columns || 80) - 1)
  const gap = available >= firstCells.length - 1 ? 1 : 0
  const budget = Math.max(0, available - Math.max(0, firstCells.length - 1) * gap)
  const fixed = firstCells.reduce((n, c) => n + (c.w ?? 0), 0)
  const scale = fixed > budget ? budget / fixed : 1
  const widths = firstCells.map(c => Math.floor((c.w ?? 0) * scale))
  const flexible = firstCells.filter(c => c.w === undefined).length
  const flex = flexible ? Math.floor((budget - widths.reduce((sum, width) => sum + width, 0)) / flexible) : 0
  const cell = (c: Cell, i: number, r: RowSpec) => {
    const width = c.w === undefined ? flex : widths[i] ?? 0
    const spin = r.shimmer && i === 2 ? ` ${SPIN[state.phase % SPIN.length]}` : ''
    const clipped = fit(c.t + spin, width)
    const body = c.right ? ' '.repeat(Math.max(0, width - displayWidth(clipped))) + clipped : clipped
    const backgroundColor = i === 0 && r.breathe?.length ? breathColor(r.breathe, state.phase * TICK_MS) : c.bg
    if (r.shimmer && i === 0) {
      const chars = [...body]
      return (
        <Box width={width} flexShrink={0}>
          <Text bold backgroundColor={backgroundColor}>
            {chars.map((ch, k) => <Text color={shade(k, state.phase, chars.length, props.shimmer)}>{ch}</Text>)}
          </Text>
        </Box>
      )
    }
    return (
      <Box width={width} flexShrink={0} overflow="hidden">
        <Text color={c.c} backgroundColor={backgroundColor} bold={c.b} wrap="truncate-end">{body}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width="100%">
      {props.rows.map((r, i) => (
        <Box
          flexDirection="row"
          height={1}
          gap={gap}
          overflow="hidden"
          backgroundColor={changedColor(r.changedAt, renderNow, props.changed)
            ?? (r.id === props.selected
              ? props.selectedBg
              : i === state.hover || i === props.cursor
                ? props.hoverBg
                : undefined)}
        >
          {r.cells.map((c, k) => cell(c, k, r))}
        </Box>
      ))}
    </Box>
  )
}

export default Rows
