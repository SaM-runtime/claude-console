// Client module: the project table rows. Pointer hover, click to select, right-click to copy the
// row menu, ↑/↓/Enter from the keyboard, and a shimmer on rows whose executor job is running.
// Pattern borrowed from data-goblin/claude-code-filetree (rows.tsx), rewritten for this table.
import type { ClientModule } from 'claude-code'

export type Cell = { t: string; c?: string; bg?: string; b?: boolean; w?: number; right?: boolean }
export type RowSpec = { id: string; cells: Cell[]; shimmer?: boolean }
export type RowsProps = {
  rows: RowSpec[]
  selected: string | null
  cursor: number
  selectedBg: string
  hoverBg: string
  shimmer: string[]
}
type Local = { hover: number; phase: number; ref: { stop?: () => void } }

const TICK_MS = 110
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function shade(i: number, phase: number, len: number, palette: string[]): string {
  const band = ((phase * 1.4) % (len + 8)) - 4
  const d = Math.abs(i - band)
  return palette[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? palette[0] ?? '#8BD5CA'
}

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { hover: -1, phase: 0, ref: {} }
    surface.setState(state)
  }
  const live = props.rows.some(r => r.shimmer)
  if (live && !state.ref.stop) {
    state.ref.stop = surface.every(TICK_MS, () => {
      const cur = surface.state
      if (cur) surface.setState({ ...cur, phase: cur.phase + 1 })
    })
  } else if (!live && state.ref.stop) {
    state.ref.stop()
    state.ref.stop = undefined
  }
  surface.onPointer(e => {
    const cur = surface.state ?? state
    if (e.type === 'leave' || e.y < 0 || e.y >= props.rows.length) {
      if (cur.hover !== -1) { surface.setState({ ...cur, hover: -1 }); surface.post({ hover: null }) }
      return
    }
    if ((e.type === 'move' || e.type === 'enter') && cur.hover !== e.y) {
      surface.setState({ ...cur, hover: e.y })
      surface.post({ hover: props.rows[e.y]?.id ?? null })
    }
    const row = props.rows[e.y]
    if (!row || e.type !== 'down') return
    if (e.button === 'right') surface.post({ copy: row.id })
    else surface.post({ press: row.id })
  })
  surface.onKey(e => surface.post({ key: e.key }))

  // The one flexible cell gets the room the fixed cells and gaps leave.
  const fixed = (props.rows[0]?.cells ?? []).reduce((n, c) => n + (c.w ?? 0) + 1, 0)
  const flex = Math.max(8, (surface.columns || 80) - fixed)
  const cell = (c: Cell, i: number, r: RowSpec) => {
    const body = c.w ? (c.right ? c.t.padStart(c.w) : c.t) : c.t
    if (r.shimmer && i === 0) {
      const chars = [...body]
      return (
        <Box width={c.w} flexShrink={0}>
          <Text bold backgroundColor={c.bg}>
            {chars.map((ch, k) => <Text color={shade(k, state.phase, chars.length, props.shimmer)}>{ch}</Text>)}
          </Text>
        </Box>
      )
    }
    const spin = r.shimmer && i === 2 ? ` ${SPIN[state.phase % SPIN.length]}` : ''
    return (
      <Box width={c.w ?? flex} flexShrink={0} overflow="hidden">
        <Text color={c.c} backgroundColor={c.bg} bold={c.b} wrap="truncate-end">{body + spin}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width="100%">
      {props.rows.map((r, i) => (
        <Box
          flexDirection="row"
          height={1}
          gap={1}
          overflow="hidden"
          backgroundColor={r.id === props.selected ? props.selectedBg : i === state.hover || i === props.cursor ? props.hoverBg : undefined}
        >
          {r.cells.map((c, k) => cell(c, k, r))}
        </Box>
      ))}
    </Box>
  )
}

export default Rows
