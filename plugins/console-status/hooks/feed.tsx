import type { ClientModule } from 'claude-code'

export type FeedProps = { events: { at: number; text: string; color: string }[]; now: number; normal: string; bright: string; dim: string }
type Local = { now: number; props: FeedProps; stop?: () => void }
const instances = new WeakMap<object, Local>()
const recent = (at: number, now: number) => now >= at && now - at < 3000

export function feedBody(props: FeedProps, now: number, elements: any, animate: boolean) {
  const { Box, Text } = elements
  return <Box flexDirection="column">{props.events.map((ev, i) => <Text key={'ev' + i} wrap="truncate-end">
    <Text color={props.dim}>{new Date(ev.at).toTimeString().slice(0, 5)}　</Text>
    <Text color={ev.color}>• </Text>
    <Text color={animate && recent(ev.at, now) ? props.bright : props.normal}>{ev.text}</Text>
  </Text>)}</Box>
}

const Feed: ClientModule<FeedProps, number> = (props, surface) => {
  let local = instances.get(surface)
  if (!local) { local = { now: props.now, props }; instances.set(surface, local) }
  local.now = Math.max(local.now, props.now)
  local.props = props
  const current = local
  const live = () => current.props.events.some(ev => recent(ev.at, current.now))
  if (live() && !current.stop) {
    current.stop = surface.every(100, () => {
      current.now += 100
      if (!live()) { current.stop?.(); current.stop = undefined }
      surface.setState(current.now)
    })
  } else if (!live() && current.stop) { current.stop(); current.stop = undefined }
  return feedBody(props, current.now, surface.elements, true)
}

export default Feed
