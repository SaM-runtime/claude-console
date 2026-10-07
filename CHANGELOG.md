# Changelog

## 0.7.0

- **Usage meters fill from the left.** The Claude and Codex quota bars were drawn as a battery with a coloured cap on the right, so a nearly empty one (3%) showed only a red cell at the far right and the cap looked like a stray block. Each meter is now a 12-cell bar on a dark track that fills from the left in eighths, with no cap; anything above 0% shows at least a sliver, green, then amber when low, red when nearly out.
- **One usage table instead of two boxed frames.** Context, the 5-hour and weekly limits, the cache countdown, this session's cost and Codex's quota share one table under a `用量` heading: the tool name on its first row, the labels and meters lined up underneath, the reset time on the same line. The Codex and other-sessions health sit on the heading's right.
- **A tidier pane.** The header and the dispatch line sit together, and the dispatch values are labelled (`派工 codex · 模型 預設 · 強度 預設`) instead of a bare `預設 · 預設`. The state counters moved onto the project table's title line and use the band's glyphs (`● ◆ ▶ ↻ ○`), as do the table's state chips; only the states that wait on you (需決策, 待審核) keep a filled chip. The table has one rule under its header instead of two, the selection hint lives in the help strip instead of its own line, and the footer is one row with the version on the right. `12:00 更新` reads `更新於 12:00`, so it no longer looks like a button.
- **Band.** The next step starts with an amber `▸ 下一步` and its text in the normal colour, and a step cut to fit ends in `…` instead of mid-word.

## 0.6.0

- **Light sessions.** The console no longer takes over every session. With the new `activation` option at `auto` (the default), a session runs only the command guard until `/console` is used in it: no git, `gh`, `claude agents` or Codex probes every minute, no band, no project-mode system prompt or progress notes, no cache or update toasts. The first `/console` command starts the console in that session, and a resume or plugin reload of that session starts it again by itself; `/console off` returns a session to light. A non-interactive run (`claude -p`, the SDK) stays light even when it resumes a console session. `activation: always` keeps the earlier behaviour.
- **Command guard asks less for ordinary work.** These no longer ask: a commit message, `grep` or `echo` that only mentions `DROP TABLE`; PowerShell's `rm -Force file` (its `-Force` was read as `-r`); deletes inside a temp directory (`/tmp/…`, `$TMPDIR/…`, `$env:TEMP\…`, `%TEMP%\…`, not the directory itself, a bare `*` or a path with `..`); and dry runs (`git clean -n`, `git push -n`, `npm publish --dry-run`, `Remove-Item -WhatIf`).
- **Command guard catches what slipped past.** A command wrapped in `bash -c`, `sh -c`, `powershell -Command`, `pwsh -c` or `cmd /c` is checked like the command itself; a `+branch` refspec force-pushes; `git push --prune` deletes remote branches; `git checkout -f` and `git switch -f`/`--discard-changes` drop uncommitted work; `find -delete` and `find -exec rm -r`; `Remove-Item` with an abbreviated `-Rec`; `Format-Volume`, `Clear-Disk`, `Initialize-Disk`.

## 0.5.1

- **Shares the band with other plugins.** The band above the prompt is one row for every plugin, and the console used to draw its line whether or not another plugin had something there, so a plugin beneath it (paste-preview's image thumbnails, for one) never showed. Now what the plugins beneath draw stacks under the console's line; with nothing beneath, the band is as before. A plugin that draws above the console and does not pass the band on still hides it while it shows.

## 0.5.0

- **Update from the console.** The pane's footer shows the installed version against the newest one on `main` (the `plugin.json` that `claude plugin update` would install), checked at each load and every six hours; a new version toasts once. `⬆ 更新到 vX.Y.Z` runs `claude plugin marketplace update claude-console` and `claude plugin update console-status`, then `/reload-plugins`, so the new version runs without leaving the session; a failure shows its last output line and the button stays for a retry. `/console version` shows both versions, `/console update` does the same as the button.

## 0.4.2

- **The actual cache TTL.** With `cacheTtl: auto` the console reads the TTL the API used from the session transcript, where Claude Code records each response's `usage.cache_creation` split into `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, after every turn (a `classic.Stop` hook names the transcript; a transcript over 4 MiB is read by its tail). The pane labels the TTL `實際`, `設定`, `推測` or `預設`. Before this the TTL was 5 minutes until an idle gap proved one hour.
- **A reload resumes the countdown.** After an install or `/reload-plugins` the clock starts from the transcript's last response instead of waiting for the next one.
- **Seconds in the last minute.** The band and pane count the last minute in seconds (`快取 45s`), bold on an amber background, redrawn every second.

## 0.4.1

- **Cache row before the first response.** The countdown starts from the console session's next response, so right after installing or reloading the plugin nothing showed and the feature looked missing. The pane's Claude frame now shows `快取　下一則回應後開始倒數` until then, and `回應中，結束後重新倒數` while a turn runs.

## 0.4.0

- **Command guard.** An irreversible Bash or PowerShell command (recursive delete outside build output, force push, remote delete, `git reset --hard`, `git clean -f`, discarding all changes, `git branch -D`, history rewrites, `DROP`/`TRUNCATE TABLE`, disk formatting, `terraform destroy`, bulk `kubectl delete`, publishing) asks first in Claude Code's question dialog, whatever the permission mode allows; a refusal tells the model not to retry it another way, and the feed records each decision. `commandGuard`: `ask` / `deny` / `off`.
- **Prompt cache countdown and re-write cost.** The band shows how long the console's prompt cache stays warm and, once cold, what the next prompt costs to re-write it; a toast warns a minute before it expires and when a prompt goes out on a cold cache. The pane adds the cache line and this session's cost. The TTL is learned (`cacheTtl: auto`) or fixed; `cacheWritePrice` overrides the list price; `cacheHint: off` hides it.
- **Tests** answer `command.register` the way Claude Code 2.1.292 requires.

## 0.3.0

- **Git, PR and CI per project.** Each refresh reads every project's `git status` (without taking the index lock); with `gh` installed, the current branch's pull request and its checks are read every five minutes, every minute while checks run. The table gains a `Git` column (conflicts, failed CI, uncommitted, unpushed, behind, clean), the action menu and card show the branch, upstream and the PR with failing check names and a `↗ 開啟` button, the band shows `CI 失敗 n`, a new CI failure toasts, and a selected project's Git and PR lines ride along with the next prompt. `gitProbe` (`on` / `git` / `off`) controls it.
- **Action-menu hotkeys.** With the menu open, `v` verify, `s` sync, `c` continue, `d` decide, `g` gate, `o` open STATUS.md and `p` open the PR; the menu lists the keys that apply.
- **Demo data** shows Git state and a PR with a failing check.

## 0.2.9

- **Latest output shown once.** A running job with no task row (a review, or a job without a request) put its latest output line both in the elapsed-time meta and on the `›` line below it, in the action menu and the expanded card; the meta could also push the title off a narrow row. The meta now holds only the executor and elapsed time. A task row is matched by executor as well as id.

## 0.2.8

- **Executor choice fixed and direct.** Pressing the project executor waited for a full refresh (Codex probes, `claude agents`) before anything changed on screen, so it looked like nothing happened. The row now offers 沿用 / claude / codex / manual, one press picks one, and the pane and toast update at once while the refresh runs in the background.
- **Action menu shows what matters.** Full project name with its state, the pipeline, the running task with elapsed time and its latest output line, and the CARD's decision, gate and next step. A blocked dispatch is a `派工鎖定：…` note instead of a dead button; ✕ sits in the header.
- **Decisions in the new menu.** The menu and expanded card show the CARD's decisions and options one per line (from 0.2.3) inside the new running/CARD block.
- **Linux probes.** The `sh` preflight and quota probes called BSD `stat -f` first. GNU `stat -f` reports file-system status and prints it even when it fails, so on Linux the install time read as 0 and a stale broker was always reported OK. GNU `stat -c` is now tried first (BSD `stat` rejects `-c` without output).
- **State counts in the pane match the band.** Every state keeps its slot, zero counts drawn faint (0.2.6 did this for the band; 0.2.7 had hidden zeros in the pane).

## 0.2.7

Merged upstream #4 (workflow pipeline, project mode, verify approval, perf and CI) onto the macOS branch; Claude jobs in a project worktree also match the shared agents query.

- **Workflow pipeline per project.** 規格 → 實作 → 同步 → 驗證 → 審核 → 上線, derived from the CARD, executor jobs and the latest verification. A six-mark `流程` column in the project table, the full line with stage names on project cards and the action menu.
- **Project mode.** A session started inside a registered project shows that project's pipeline in the band and a project card at the top of the pane, adds the CARD contract to the system prompt as one stable section, and attaches progress to a prompt only when it changed. `projectMode` option (`auto`/`off`) and `/console mode auto|console|project`.
- **Faster refresh and drawing.** One `claude agents` query per refresh instead of one per project; projects are read four at a time; drawing no longer reads settings from disk; a running action redraws once a second (with elapsed seconds) instead of every 150 ms; unchanged Codex logs are not re-read, and a log over 4 MiB says so instead of showing nothing.
- **Keyboard and confirmations.** `m` opens the action menu for the row under the cursor (Esc closes it). Continue waits six seconds for the second press and the pane shows what it will dispatch or run while armed. A missing registry names its path and suggests `/console demo`. The status counts show only states that have projects.
- **Verify commands need approval.** The CARD's `驗證` command is written by background executors, so the pane now shows it in full and runs a new or changed command only after a second press within 10 seconds. Approved commands are remembered per project in the plugin store; a store failure still runs the confirmed command, it just asks again next session.
- **Codex state format guard.** A companion `state.json` that parses but has no recognisable `jobs` list (the Codex plugin changed its internals) is now reported on the companion footer line with the file and what is missing, instead of silently showing no Codex jobs. Half-written files are still skipped quietly and read again on the next refresh.

## 0.2.6

- **Band always shows every state.** 需決策, 待審核, 執行中, 待同步 and 閒置 keep their slot with a count of 0 included; zero counts are drawn faint so the states that need you still stand out. The context chip still appears only at 50% or more, and the strict priority order still drops trailing items on narrow terminals.

## 0.2.5

- **An agent waiting for your reply is finished, not running.** `status: idle` with `state: blocked` (the turn ended with a question) completes the job with phase `idle: 等你回覆`, so the project moves to 待同步 and dispatch is no longer held. Only `status: waiting` (a permission prompt mid-turn) keeps a blocked agent running.

## 0.2.4

- **Finished Claude jobs no longer stick as RUNNING.** A background agent that reports `status: idle` after its turn counts as completed (phase `idle`) once it is past a 60-second launch grace, even while `state` still says `working`; blocked agents stay running. The same rule decides whether the project's session is still active before a new dispatch. Agents working inside a Claude Code worktree of the project (`<root>/.claude/worktrees/…`) now reconcile their job instead of leaving it running forever.

## 0.2.3

- **Decisions shown in full, one per line.** A CARD `等使用者` is split into decisions on top-level `；`/`;`/newlines (bracketed commands stay whole), and each decision's `A) … B) …`, `1) 2)`, `(A)` or `①②` choices become one line each. The detail card, the action menu and a new "需要你決定" box under a selected project show them wrapped, never truncated; the hover strip and table keep a one-line summary (`2 項決策：…｜…`). The STATUS template and workflow skill ask executors to write choices in that format. The demo's first project shows two decisions with options.

## 0.2.2

- **macOS support.** Codex preflight and quota probes run as POSIX `sh` scripts (`scripts/codex-preflight.sh`, `scripts/codex-quota.sh`) on non-Windows hosts; Windows keeps the PowerShell scripts. The macOS preflight resolves the `codex` CLI (adding Homebrew prefixes to `PATH`), reads its version from the npm package, and reports a companion broker STALE when its `codex app-server` started before the CLI was last installed; it scans every configured companion state root for `broker.json` owners. The quota parser also accepts the raw rollout event line. `open STATUS.md` falls back to `open` instead of `cmd /c start` off Windows. Test fixtures use POSIX paths so the suite runs on macOS.

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
