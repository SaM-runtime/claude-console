// Which console dispatches which project. Every active console renews its heartbeat in console-lease.json
// (beside claude-sessions.json) on each refresh, and a dispatch records the console that sent it, per project.
// Pure logic, no I/O; register.tsx reads and writes the file.

/** A console whose heartbeat is older than this has stopped (closed, /console off, or crashed). */
export const ALIVE_MS = 150_000
/** After a dispatch, its project stays with that console this long, until the job shows up as running. */
export const CLAIM_MS = 120_000

export type Claim = { sessionId: string; at: number }
export type Lease = { consoles: Record<string, number>; projects: Record<string, Claim> }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The lease file's text as a Lease; anything else (missing, broken, the single-console 0.20.0 shape) is empty. */
export function parseLease(text: string | null): Lease {
  const lease: Lease = { consoles: {}, projects: {} }
  try {
    const data = JSON.parse((text ?? '').replace(/^﻿/, ''))
    if (record(data?.consoles)) for (const [id, at] of Object.entries(data.consoles)) if (typeof at === 'number') lease.consoles[id] = at
    if (record(data?.projects)) for (const [path, claim] of Object.entries(data.projects)) {
      if (record(claim) && typeof claim.sessionId === 'string' && typeof claim.at === 'number') lease.projects[path] = { sessionId: claim.sessionId, at: claim.at }
    }
  } catch { /* Missing or half-written: start empty. */ }
  return lease
}

const alive = (lease: Lease, id: string, now: number) => now - (lease.consoles[id] ?? -Infinity) < ALIVE_MS

/** This console's heartbeat renewed; stopped consoles and their claims dropped. */
export function heartbeat(lease: Lease, me: string, now: number): Lease {
  const consoles = Object.fromEntries(Object.entries(lease.consoles).filter(([id]) => id !== me && alive(lease, id, now)))
  consoles[me] = now
  const projects = Object.fromEntries(Object.entries(lease.projects).filter(([, claim]) => claim.sessionId in consoles))
  return { consoles, projects }
}

/** `/console off`: this console and its claims leave at once, so another console takes its projects over. */
export function leave(lease: Lease, me: string): Lease {
  const consoles = { ...lease.consoles }
  delete consoles[me]
  return { consoles, projects: Object.fromEntries(Object.entries(lease.projects).filter(([, claim]) => claim.sessionId !== me)) }
}

/** The other console that just dispatched this project, while its job may not show yet; null when free. */
export function claimBlocker(lease: Lease, me: string, path: string, now: number): string | null {
  const claim = lease.projects[path]
  return claim && claim.sessionId !== me && alive(lease, claim.sessionId, now) && now - claim.at < CLAIM_MS ? claim.sessionId : null
}

export function claim(lease: Lease, me: string, path: string, now: number): Lease {
  return { consoles: { ...lease.consoles, [me]: now }, projects: { ...lease.projects, [path]: { sessionId: me, at: now } } }
}

/** Auto-sync of a project is the job of the console that last dispatched it, or of any console once that one stopped. */
export function syncsHere(lease: Lease, me: string, path: string, now: number): boolean {
  const claim = lease.projects[path]
  return !claim || claim.sessionId === me || !alive(lease, claim.sessionId, now)
}
