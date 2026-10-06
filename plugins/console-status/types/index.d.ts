export type JobFlag = { executor?: 'claude' | 'codex'; kind: 'running' | 'newer'; id: string; status: string; summary: string; startedAt?: string; phase?: string; logFile?: string; last?: string }

/** One executor task of a project, as the console lists it. */
export type ExecutorTask = { id: string; executor?: 'claude' | 'codex'; fallbackFrom?: 'codex'; status: string; title: string; model: string; effort: string; startedAt?: string; completedAt?: string }

export type Project = {
  changedAt?: number
  /** Effective executor for this project (pane override > registry column > global); manual never dispatches. */
  executor?: 'claude' | 'codex' | 'manual'
  executorSource?: 'pane' | 'registry' | 'global'
  /** The registry `Executor` column, kept so a dispatch can recompute the effective executor. */
  registryExecutor?: 'claude' | 'codex' | 'manual'
  name: string
  statusPath: string
  hasCard: boolean
  state: string
  ask: string
  next: string
  gate?: string
  verify: string
  updated: string
  isStale: boolean
  jobs: JobFlag[]
  tasks?: ExecutorTask[]
}

export type FallbackOffer = { kind: 'sync' | 'continue'; reason: string; at: number }

export type FeedEvent = { at: number; text: string; tone: 'amber' | 'teal' | 'blue' | 'red' | 'green' }

export type ActionKind = 'verify' | 'sync' | 'continue' | 'decide' | 'gate' | 'open'
export type ContinueConfirmation = { at: number; signature: string }
export type VerificationResult = { command: string; at: number; ok: boolean; exitCode: number | null; lines: string[]; truncated: boolean }
export type PendingAction = { kind: ActionKind; at: number }
export type ReviewRequest = { text: string; projectName: string; at: number; turnId?: string }

export type Blocked = { name: string; why: string }

export type Snapshot = {
  demo?: boolean
  executor?: 'claude' | 'codex'
  at: number
  projects: Project[]
  blocked: Blocked[]
  codex: string
  contextPercent: number | null
  limits?: { kind: string; percent: number; resetsAt?: string }[]
  /** Codex quota from its newest session log: windows, credit balance, when it was read. */
  codexQuota?: { at: string; limits: { label: string; percent: number; resetsAt?: string }[]; credits?: string } | null
  /** Some project resolves to codex, so Codex probes, health and quota are shown. */
  codexInUse?: boolean
  /** Which codex-companion.mjs dispatch uses, and a warning when the configured one was stale. */
  companion?: { path: string; source: 'configured' | 'installed' | 'cache' | 'none'; warning?: string }
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'console-status': {
      snapshot: Snapshot | null
      isDemo: boolean
      isPaneOpen: boolean
      isBandHidden: boolean
      isDetail: boolean
      isPlain: boolean
      isRefreshing: boolean
      hovered: string | null
      menuFor: string | null
      selected: string | null
      cursor: number
      feed: FeedEvent[]
      dispatchRevision: number
      pendingActions: Record<string, PendingAction>
      continueConfirmations: Record<string, ContinueConfirmation>
      verificationResults: Record<string, VerificationResult>
      actionPulse: number
      reviewRequests: Record<string, ReviewRequest>
      fallbackOffers: Record<string, FallbackOffer>
    }
  }
}
