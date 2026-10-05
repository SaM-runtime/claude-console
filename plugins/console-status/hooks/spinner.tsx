import type { ClientModule } from 'claude-code'

const started = new WeakSet<object>()
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// Mounted only while refreshing; the surface disposes its timer on unmount.
const Spinner: ClientModule<{ color: string }, number> = (props, surface) => {
  if (!started.has(surface)) {
    started.add(surface)
    surface.every(110, () => surface.setState(((surface.state ?? 0) + 1) % frames.length))
  }
  const { Text } = surface.elements
  return <Text color={props.color}>{frames[surface.state ?? 0]}</Text>
}
export default Spinner
