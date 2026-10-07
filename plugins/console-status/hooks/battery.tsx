import type { ClientModule } from 'claude-code'

export type BatteryProps = { percent: number; tone: string }
type Local = { target: number; from: number; value: number; elapsed: number; stop?: () => void }
const instances = new WeakMap<object, Local>()
const STEP = 40
const DURATION = 400
const bounded = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0

/** Cells in the meter: 12 cells of eighths, so 1% still shows as a sliver on the left. */
export const METER = 12
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const TRACK = '#2A313C'

/**
 * A remaining-amount meter that fills from the left on a dark track, with the value beside it.
 * Anything above zero shows at least a sliver, so a nearly empty meter still reads as "low", not "blank".
 */
export function meterCells(percent: number, width = METER): { full: number; part: string; empty: number } {
  const value = bounded(percent)
  const eighths = value > 0 ? Math.max(1, Math.round((value / 100) * width * 8)) : 0
  const full = Math.min(width, Math.floor(eighths / 8))
  const part = full < width ? EIGHTHS[eighths % 8]! : ''
  return { full, part, empty: width - full - (part ? 1 : 0) }
}

export function batteryBody(percent: number, tone: string, elements: any) {
  const { Box, Text } = elements
  const value = bounded(percent)
  const m = meterCells(value)
  return <Box gap={1}>
    <Text><Text color={tone} backgroundColor={TRACK}>{'█'.repeat(m.full)}{m.part}</Text><Text backgroundColor={TRACK}>{' '.repeat(m.empty)}</Text></Text>
    <Box width={4} justifyContent="flex-end"><Text bold color={tone}>{`${value}%`}</Text></Box>
  </Box>
}

const Battery: ClientModule<BatteryProps, number> = (props, surface) => {
  let local = instances.get(surface)
  const target = bounded(props.percent)
  if (!local) {
    local = { target, from: 0, value: 0, elapsed: 0 }
    instances.set(surface, local)
  } else if (local.target !== target) {
    local.from = local.value
    local.target = target
    local.elapsed = 0
  }
  const current = local
  if (current.value !== current.target && !current.stop) {
    current.stop = surface.every(STEP, () => {
      current.elapsed = Math.min(DURATION, current.elapsed + STEP)
      const ease = 1 - (1 - current.elapsed / DURATION) ** 3
      current.value = current.elapsed === DURATION ? current.target : current.from + (current.target - current.from) * ease
      if (current.elapsed === DURATION) { current.stop?.(); current.stop = undefined }
      surface.setState(current.value)
    })
  }
  return batteryBody(current.value, props.tone, surface.elements)
}

export default Battery
