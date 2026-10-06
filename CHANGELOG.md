# Changelog

## Unreleased

- **Workflow pipeline per project.** 規格 → 實作 → 同步 → 驗證 → 審核 → 上線, derived from the CARD, executor jobs and the latest verification. A six-mark `流程` column in the project table, the full line with stage names on project cards and the action menu.
- **Project mode.** A session started inside a registered project shows that project's pipeline in the band and a project card at the top of the pane, adds the CARD contract to the system prompt as one stable section, and attaches progress to a prompt only when it changed. `projectMode` option (`auto`/`off`) and `/console mode auto|console|project`.
- **Faster refresh and drawing.** One `claude agents` query per refresh instead of one per project; projects are read four at a time; drawing no longer reads settings from disk; a running action redraws once a second (with elapsed seconds) instead of every 150 ms; unchanged Codex logs are not re-read, and a log over 4 MiB says so instead of showing nothing.
- **Keyboard and confirmations.** `m` opens the action menu for the row under the cursor (Esc closes it). Continue waits six seconds for the second press and the pane shows what it will dispatch or run while armed. A missing registry names its path and suggests `/console demo`. The status counts show only states that have projects.
- **Verify commands need approval.** The CARD's `驗證` command is written by background executors, so the pane now shows it in full and runs a new or changed command only after a second press within 10 seconds. Approved commands are remembered per project in the plugin store; a store failure still runs the confirmed command, it just asks again next session.
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
