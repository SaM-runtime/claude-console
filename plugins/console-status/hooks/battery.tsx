import type { ClientModule } from 'claude-code'

export type BatteryProps = { percent: number; tone: string }
type Local = { target: number; from: number; value: number; elapsed: number; stop?: () => void }
const instances = new WeakMap<object, Local>()
const STEP = 40
const DURATION = 400
const bounded = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0

/** A fixed-width value beside the battery never straddles the fill boundary. */
export function batteryBody(percent: number, tone: string, elements: any) {
  const { Box, Text } = elements
  const value = bounded(percent)
  const filled = Math.round(value / 10)
  return <Box gap={1}>
    <Text><Text backgroundColor={tone}>{' '.repeat(filled)}</Text><Text backgroundColor="#2A313C">{' '.repeat(10 - filled)}</Text><Text backgroundColor={tone}> </Text></Text>
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
