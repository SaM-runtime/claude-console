# Changelog

## Unreleased

- **Codex state format guard.** A companion `state.json` that parses but has no recognisable `jobs` list (the Codex plugin changed its internals) is now reported on the companion footer line with the file and what is missing, instead of silently showing no Codex jobs. Half-written files are still skipped quietly and read again on the next refresh.

## 0.2.1

- **Rows stay inside the client render budget.** The project table no longer redraws every 100 ms while a 需決策/review chip breathes: the frame clock runs at 200 ms for breath-only tables, and a tick calls `setState` only when the visible frame changed (shimmer phase, breath step, change-highlight step). Idle ticks, including a burst of catch-up ticks after a suspend, write nothing and coalesce into at most one redraw. Cell clipping (`fit`) is linear instead of quadratic, fitted cell text is cached per text/width, and the timer stops by itself once a change highlight fades. Fixes `console-status: Client hooks/rows.tsx: ran longer than its 1000ms budget` after the pane sat idle with several decision rows.

## 0.2.0

- **Per-project executor.** Registry tables accept an optional `Executor` column (`claude`, `codex`, `manual`, blank). The pane cycles a per-project override stored in `dispatch.json` under `projects`. Precedence: pane override > registry column > global. `manual` projects are never dispatched. Job listing merges both executors so RUNNING never misses a job. `/console project` lists and sets overrides.
- **Codex fallback.** New options `codexFallback` (`ask` default, `claude`, `off`) and `codexMinQuotaPercent` (default `10`). Low quota, a stale broker, a missing Codex app/broker, or a missing companion script either holds the dispatch and offers Claude (`ask`) or sends it to Claude with `fallbackFrom: "codex"` recorded (`claude`). Quota readings older than six hours count as unknown.
- **Companion auto-resolve.** An empty or stale `companionScript` resolves to the newest installed Codex plugin (semantic-version order, `installed_plugins.json` consulted); the footer shows the path in use and a warning when the configured path was stale.
- **Dispatch file.** `~/.claude/handoffs/dispatch.json` is canonical; the legacy `codex-dispatch.json` is read only when it is missing. The 0.1 flat file keeps working.
- **Workflow.** The `claude-console` skill is executor-agnostic and adds executable acceptance contracts, three gates, effort rules, review jobs, and reading limits. The STATUS template carries `rev` in the `更新` line and gate rules.

## 0.1.0

- Initial release.
