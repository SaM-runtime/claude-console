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
  /** What the CARD's 驗證 line records after its command, e.g. `→ PASS; verified …`. */
  verifyNote?: string
  updated: string
  isStale: boolean
  jobs: JobFlag[]
  tasks?: ExecutorTask[]
  /** `git status` of the project root; absent when it is not a repository or `gitProbe` is off. */
  git?: GitInfo
  /** The pull request of the current branch (`gh pr view`); absent without gh, a PR or `gitProbe: on`. */
  pr?: PrInfo
}

export type GitInfo = { branch: string; detached?: boolean; oid?: string; upstream?: string; ahead: number; behind: number; changed: number; untracked: number; conflicts: number }
export type PrInfo = {
  number: number; title: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; draft: boolean; url: string; review?: string
  checks: { pass: number; fail: number; pending: number; failing: string[] }
}

/** The console session's last main-thread request: when it started, its context size and model, the cache TTL in force. */
export type CacheClock = { at: number; tokens: number; model: string; ttl: '5m' | '1h'; source?: 'usage' | 'learned' | 'option' | 'default' }

export type FallbackOffer = { kind: 'sync' | 'continue'; reason: string; at: number }

export type FeedEvent = { at: number; text: string; tone: 'amber' | 'teal' | 'blue' | 'red' | 'green' }

export type ActionKind = 'verify' | 'sync' | 'continue' | 'decide' | 'gate' | 'open'
export type ContinueConfirmation = { at: number; signature: string }
export type VerificationResult = { command: string; at: number; ok: boolean; exitCode: number | null; lines: string[]; truncated: boolean }
export type PendingAction = { kind: ActionKind; at: number }
export type ReviewRequest = { text: string; projectName: string; at: number; turnId?: string }

/** This plugin's installed version, the marketplace's latest, and an update in progress. */
export type UpdateInfo = { current: string | null; latest: string | null; checkedAt: number; error?: string; phase: 'idle' | 'checking' | 'updating' | 'updated' | 'failed'; message?: string }

export type Blocked = { name: string; why: string }

export type Snapshot = {
  demo?: boolean
  executor?: 'claude' | 'codex'
  at: number
  projects: Project[]
  blocked: Blocked[]
  codex: string
  contextPercent: number | null
  /** What this console session has cost so far (USD at API prices), when the host keeps a ledger. */
  costUsd?: number
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
      trustedVerify: Record<string, string>
      modeOverride: 'auto' | 'console' | 'project'
      actionPulse: number
      reviewRequests: Record<string, ReviewRequest>
      fallbackOffers: Record<string, FallbackOffer>
      cacheClock: CacheClock | null
      cacheTick: number
      isTurnRunning: boolean
      updateInfo: UpdateInfo | null
    }
  }
}
