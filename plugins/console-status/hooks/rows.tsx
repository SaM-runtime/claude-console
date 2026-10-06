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
type Runtime = {
  /** Authoritative local state; `surface.state` only mirrors it to schedule a redraw. */
  local: Local
  latestPropNow: number
  props: RowsProps
  /** Signature of the last frame handed to setState (or drawn), so idle ticks write nothing. */
  frame: string
  interval: number
  stop?: () => void
}

const TICK_MS = 100
/** Breath steps last 200 ms, so a breath-only table never needs a faster clock. */
const BREATH_TICK_MS = 200
const CHANGE_MS = 1_500
const runtimes = new WeakMap<object, Runtime>()
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BREATH = [0, 0, 1, 2, 2, 1, 0, 0]

function shade(i: number, phase: number, len: number, palette: string[]): string {
  const band = ((phase * 1.4) % (len + 8)) - 4
  const d = Math.abs(i - band)
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? '#8BD5CA'
}

function breathIndex(now: number): number {
  // Eight calm steps make one 1.6 s cycle: low → middle → high → middle → low.
  return BREATH[Math.floor((now % 1_600) / 200)] ?? 0
}

function breathColor(palette: string[], now: number): string | undefined {
  return palette[breathIndex(now)] ?? palette[0]
}

function changedIndex(changedAt: number | undefined, now: number, steps: number): number {
  if (changedAt === undefined) return -1
  const age = now - changedAt
  if (age < 0 || age >= CHANGE_MS) return -1
  return Math.min(steps - 1, Math.floor(age / 500))
}

function changedColor(changedAt: number | undefined, now: number, palette: string[]): string | undefined {
  const index = changedIndex(changedAt, now, palette.length)
  return index < 0 ? undefined : palette[index]
}

/** Clips `text` to `columns` display cells with a trailing ellipsis; linear in the text length. */
export function fit(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (displayWidth(text) <= columns) return text
  // displayWidth sums per code point, so a running total equals displayWidth(result + char).
  let result = ''
  let used = 0
  for (const char of text) {
    used += displayWidth(char)
    if (used > columns - 1) break
    result += char
  }
  return result + '…'
}

// Fitted cell bodies, shared by every instance: only colours change between ticks.
const FIT_CACHE_MAX = 512
const fitCache = new Map<string, string>()
export function fittedCell(text: string, width: number, right: boolean | undefined): string {
  const key = (right ? 'r' : 'l') + width + '|' + text
  const hit = fitCache.get(key)
  if (hit !== undefined) return hit
  const clipped = fit(text, width)
  const body = right ? ' '.repeat(Math.max(0, width - displayWidth(clipped))) + clipped : clipped
  if (fitCache.size >= FIT_CACHE_MAX) fitCache.clear()
  fitCache.set(key, body)
  return body
}

/** Which clock the rows need: 100 ms for shimmer or a change highlight, 200 ms for breath alone, none when still. */
function wantedInterval(rows: RowSpec[], now: number, changed: string[]): number {
  let breath = false
  for (const r of rows) {
    if (r.shimmer || changedIndex(r.changedAt, now, changed.length) >= 0) return TICK_MS
    if (r.breathe?.length) breath = true
  }
  return breath ? BREATH_TICK_MS : 0
}

/**
 * Everything a tick can change on screen, as a short string: shimmer moves every tick,
 * breath every 200 ms step, change highlights every 500 ms. Hover and props redraw on their own.
 */
function frameOf(props: RowsProps, local: Local, now: number): string {
  let frame = ''
  let breathe = false
  for (const r of props.rows) {
    if (r.shimmer) return 's' + local.phase
    if (r.breathe?.length) breathe = true
    if (r.changedAt !== undefined) frame += changedIndex(r.changedAt, now, props.changed.length) + ','
  }
  return (breathe ? 'b' + breathIndex(local.phase * TICK_MS) : '') + '|' + frame
}

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let runtime = runtimes.get(surface)
  if (!runtime) {
    runtime = { local: { hover: -1, phase: 0, now: props.now }, latestPropNow: props.now, props, frame: '', interval: 0 }
    runtimes.set(surface, runtime)
  }
  const rt = runtime
  rt.latestPropNow = Math.max(rt.latestPropNow, props.now)
  rt.props = props
  const state = rt.local
  const renderNow = Math.max(state.now, rt.latestPropNow)
  rt.frame = frameOf(props, state, renderNow)
  const interval = wantedInterval(props.rows, renderNow, props.changed)
  if (rt.stop && rt.interval !== interval) {
    rt.stop()
    rt.stop = undefined
  }
  if (interval && !rt.stop) {
    rt.interval = interval
    const steps = interval / TICK_MS
    rt.stop = surface.every(interval, () => {
      // A tick is O(rows) and allocation-free unless the visible frame moved, so a burst of
      // catch-up ticks after a suspend costs next to nothing and coalesces into one redraw.
      const cur = rt.local
      cur.phase += steps
      cur.now = Math.max(cur.now, rt.latestPropNow) + interval
      const frame = frameOf(rt.props, cur, cur.now)
      if (frame === rt.frame) return
      rt.frame = frame
      if (!wantedInterval(rt.props.rows, cur.now, rt.props.changed)) {
        rt.stop?.()
        rt.stop = undefined
      }
      surface.setState({ ...cur })
    })
  }
  surface.onPointer(e => {
    const cur = rt.local
    if (e.type === 'leave' || e.y < 0 || e.y >= props.rows.length) {
      if (cur.hover !== -1) {
        cur.hover = -1
        surface.setState({ ...cur })
        surface.post({ hover: null })
      }
      return
    }
    if ((e.type === 'move' || e.type === 'enter') && cur.hover !== e.y) {
      cur.hover = e.y
      surface.setState({ ...cur })
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
    const body = fittedCell(c.t + spin, width, c.right)
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
