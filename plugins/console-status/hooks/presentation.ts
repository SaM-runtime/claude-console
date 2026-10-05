import type { Snapshot } from '../types'
import { rows } from './logic'

/** Keep the original transition time through ordinary refreshes and selection redraws. */
export function trackRowChanges(previous: Snapshot | null, current: Snapshot, now: number): Snapshot {
  if (!previous) return current
  const before = new Map(rows(previous).map(row => [row.full, row.state]))
  const after = new Map(rows(current).map(row => [row.full, row.state]))
  const timestamps = new Map(previous.projects.map(project => [project.name, project.changedAt]))
  return { ...current, projects: current.projects.map(project => ({ ...project,
    changedAt: before.has(project.name) && before.get(project.name) !== after.get(project.name) ? now : timestamps.get(project.name),
  })) }
}
