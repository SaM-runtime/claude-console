# Changelog

## 0.9.2

- **A row no longer stays locked after `⚑ 審核關卡`.** When the console was busy, the host queued the plugin's review prompt and handed it to the model wrapped (`The console-status plugin sent a message:` above it, a note below), so the turn's text never equalled the submitted one, the review was never tied to its turn, and the project's buttons stayed grey until a reload (twice on 2026-10-07; the second time a reload did not help either). A turn now counts as the review when it carries the prompt's first line, bound at its start or, for a submit that returns late, recognised at its end.
- **Nothing pending is left forever.** After each refresh, at the end of every turn and before a press on a row that still shows a pending action, the console drops what nothing will finish: a review whose CARD gate was cleared or replaced (`關卡已變更`), one that waited ten minutes (`GATE_PENDING_MS`) with no turn running for it (`審核狀態已逾時`), and any action no lock in this plugin lifetime backs (`動作已失去追蹤`), each with a toast saying the buttons are unlocked. `/console off` lets go of every review not actually running, a submit that never returned included, while a verify or a dispatch in flight keeps its lock. A timeout lets go of the row only: a review still queued behind a long turn reports its answer when its turn finally runs, as does a review turn already bound when the CARD gate changes. The sweep walks pending actions only, so the review request a timeout keeps is not touched by a later gate change or `/console off`; it goes when its turn reports, when the row submits a new review, or at the next session start (a reload). It is never drawn. Ending a review drops only that review's own pending entry, so a `▶ 執行驗證` pressed while it ran keeps going, and the unlock toast appears only when something was actually dropped.
- **A stale `⚑ 審核關卡` is not shown.** When the CARD no longer carries a gate, a pending review neither puts the button back nor greys the rest of the row: `▶ 執行驗證` and the other buttons work.
- **Known.** A review that changes its own gate shows the red `關卡已變更` toast at the next refresh before its green answer. A timed-out review on a row whose CARD still has a gate unlocks at the next refresh, up to a minute later, not at the press. Pressing `⚑ 審核關卡` again while an earlier submit has not returned lets that late submit overwrite the newer request. Pressing `⚑ 審核關卡` again after a timeout, while the earlier review is still queued, lets that earlier turn's answer be reported as the new review's, and the new turn's answer is not reported; this was already so before these fixes. A review submit that returns late with an error deletes the row's review request and pending action without checking they are its own, so after a timeout it can drop a `▶ 執行驗證` pressed in between; to be fixed in the next version.

## 0.9.1

- **Every rate-limit window the host reports is drawn, and a per-model one is named after its model.** The usage pane kept only the first two windows from `session.usage()`, and the label matched `seven` before `opus`, so a weekly window scoped to one model (`seven_day_opus`, `seven_day_sonnet`, or a `seven_day_fable` should the host send one) was cut off or shown as a second `本週`. Each window now has its own row: `5 小時`, `本週`, `Fable 週`, `Opus 週`, `Sonnet 週`, and a gateway's `spend_limit` as `花費上限`. A model name without a known spelling is shown as sent (`mythos 週`), and a kind that is not a window keeps its full name instead of being swallowed. The label column widens to fit. Each row has its own hover help, naming the model for a per-model window. Demo mode shows one per-model weekly row (`Fable 週`).
- Note: Claude Code 2.1.292 hands plugins only `five_hour`, `seven_day` and, behind a gateway, `spend_limit`; its per-model windows are not exposed through `session.usage()`, so a Fable row appears once the host reports one.

## 0.9.0

- **Executor, model and effort are picked from a list.** Each press on a control under the pane title used to move to the next value, so reaching `max` from `low` meant pressing through every level and writing each one to `dispatch.json` on the way, and the model never came back to `預設`. A press now spreads the choices out on the next line (`模型  [預設]  fable  opus  sonnet  ✕`), with the current value in brackets. Pressing one saves it and closes the line; the current value, `✕` or the label again closes it without writing. `預設` hands the choice back to the executor. Efforts follow the chosen model. A model typed with `/console model <name>` is listed while it is chosen. Without a readable Codex model cache, the line says to use `/console model <name>` instead of showing a toast.
- **Hover help** for the project executor row says a press picks the value; it described cycling, which the row no longer does.

## 0.8.3

- **`下一步：無（…）` is nothing to continue.** A none word followed by a note in brackets (`無（等使用者決定）`, `無(等決策)`) was read as a real next step: the pipeline showed `待繼續：無（等使用者決定）` and `⇢ 繼續下一步` offered to dispatch it. The next step and `等使用者` now share one check, which already accepted brackets for the ask.
- **`0 fail` is not a failure.** A CARD 驗證 verdict that copies a test runner's summary, such as `214 pass, 0 fail` from `claude plugin test` or `874 passed, 0 failed`, showed the verify stage as `✕` because the word `fail` appeared. Zero counts (`0 fail`, `0 failed`, `0 errors`, `failures: 0`, `0 個失敗`) no longer count; `1 fail` and `10 failed` still do, and `failures: 2` now reads as failed too.

## 0.8.2

- **Update from a local folder.** When console-status is read from a local folder (a marketplace added from a directory, or `--plugin-dir`), `claude plugin update` only re-reads that folder, so `⬆ 更新` installed nothing and the pane stayed on `已安裝，重新載入中…`. The button now finds the folder (`claude plugin list --json`'s `readFromFolder`, or the loaded root outside the plugin cache) and runs `git pull --ff-only` there; a folder that is not a git clone, a pull that cannot fast-forward, or a branch still on the old version is shown in the pane. A marketplace update that installs nothing (`updateOutcome` other than `updated`) is reported instead of called installed.
- **The reload is applied.** `/reload-plugins` runs with `--force`, so it is not held over the prompt cache, and if the plugin has not reloaded 20 seconds later the pane says to run `/reload-plugins` instead of waiting forever.
- **Checks every 30 minutes** instead of every six hours.

## 0.8.1

- **Command guard sees past wrappers.** A wrapper's own options were read as the command, so `sudo -u root rm -rf /srv`, `sudo -E …`, `nice -n 10 rm -rf src`, `timeout 60 rm -rf src` and `xargs -0 rm -rf` ran without asking. The guard now skips `sudo`, `doas`, `env`, `nice`, `timeout`, `stdbuf`, `xargs`, `nohup`, `time`, `exec` and `command` with their options (and `timeout`'s duration, and `--`), and matches them by name when given as a path (`/usr/bin/sudo`).
- **Piped deletes ask.** `ls | xargs rm -rf` and `find . -print0 | xargs -0 rm -rf` name no target, and a recursive `rm` with no target was treated as harmless; through `xargs` it now asks, since it deletes whatever the pipe sends. A bare `rm -rf` and a non-recursive `xargs rm -f` still pass.
- **`eval`, `Invoke-Expression` and `-Recurse:$true`.** `eval "…"`, `Invoke-Expression "…"` and `iex "…"` are checked like `bash -c "…"`, and `Remove-Item -Recurse:$true` counts as `-Recurse` (`-Recurse:$false` does not).

## 0.8.0

- **Finished work no longer shows as 待同步 when it already updated the CARD.** A job counted as unsynced whenever it finished after the CARD's `更新` time. That time has minute precision and is written by the job just before it ends, and a Claude job's finish is stamped when the console next looks (up to a minute later), so nearly every continue, and every Codex sync, landed in 待同步 right after writing the CARD; syncing a Codex sync only produced another one. A finished job now counts as written back when `更新` is at or after the minute it started, and a sync job (Codex ones too, recognised by their prompt) never asks to be synced itself.
- **Auto sync.** With the new `autoSync` option at `on` (the default), finished work that really left the CARD behind gets one sync dispatched by the console itself, once per job (remembered across sessions). A sync that fails or writes nothing is not retried; it waits for the 同步 button. `autoSync: off` leaves it to you.
- **Sync progress you can follow.** A sync shows its steps on the project's `同步` line, `● 派工 ─ ◉ 執行 ─ ○ 寫回 STATUS`, with the executor, its phase and the elapsed time, and the band shows `↻ 同步：執行中 …` (`↻ 同步完成`, `↻ 同步未寫回`, `↻ 同步失敗` when it ends). A sync is done when the CARD's `更新` changes; one that ends without changing it says so instead of leaving 待同步 unexplained. Each outcome is also a toast.
- **Faster updates while work runs.** While a job or a sync is under way, the console refreshes every 20 seconds instead of every minute, so a finished job shows sooner.

## 0.7.1

- **An open pane no longer waits forever in a light session.** A pane left open across an upgrade and `/reload-plugins` (opened before 0.6.0, or in a session not remembered as a console session) came back in a light session, where nothing refreshes, and showed `讀取各專案狀態中…` for good. It now says the console is not running in this session and that `/console refresh` starts it.

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
