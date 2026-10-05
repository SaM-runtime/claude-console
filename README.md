# claude-console

`claude-console` is a local, multi-project Claude Code mod. One console session owns specification, supervision, and review gates across registered projects; the operator supplies decisions and performs the final release approval.

The `console-status` mod reads compact STATUS cards and managed executor state, then exposes trigger-style actions. Verification, dispatch, STATUS sync, and review start from one button and report their outcome in the activity feed. The panel never performs a release or formal-environment change.

Dispatch is selectable. `claude` is the default executor and uses Claude Code's native background agents, so it needs no Codex account. Choose `codex` to use Codex Companion when Claude quota is limited.

Panel refreshes query local files and CLIs, then update mod-owned managed-state records when observations change. Refresh itself does not request a model. A decision draft spends Claude quota only when the operator submits it. The current UI is Traditional Chinese.

## Requirements

- Windows; this is the currently verified operating system
- Claude Code 2.1.289 or later with mod support
- A project registry and one STATUS file per registered project
- For `executor: codex` only: Node.js, PowerShell, Codex Companion and a Codex account; the desktop app is needed for its broker preflight

## Install

```powershell
claude plugin marketplace add SaM-runtime/claude-console
claude plugin install console-status@claude-console
```

For this checkout:

```powershell
claude plugin marketplace add .
claude plugin install console-status@claude-console
```

Marketplace management is covered by the official [plugin marketplace documentation](https://code.claude.com/docs/en/plugins/cli-reference#plugin-marketplace-add).

## Configure

`claude plugin configure` accepts a JSON object whose values are single-line strings. Unspecified options retain their current values.

```powershell
@'
{
  "registryPath": "C:\\Projects\\console\\projects-scope.md",
  "dispatchSettingsPath": "~/.claude/handoffs/dispatch.json",
  "claudeSessionsPath": "~/.claude/handoffs/claude-sessions.json",
  "executor": "claude",
  "defaultModel": "",
  "defaultEffort": "",
  "companionScript": "",
  "companionStateDir": "",
  "companionStateRoots": "",
  "modelsCachePath": "~/.codex/models_cache.json"
}
'@ | claude plugin configure console-status@claude-console --values-stdin
```

| Key | Purpose | Default |
| --- | --- | --- |
| `registryPath` | Markdown registry mapping names to STATUS files | `~/.claude/handoffs/projects-scope.md` |
| `dispatchSettingsPath` | Shared executor, model, and effort file | `~/.claude/handoffs/dispatch.json` |
| `claudeSessionsPath` | Managed Claude session mapping | `~/.claude/handoffs/claude-sessions.json` |
| `executor` | Fallback executor when settings are missing or invalid | `claude` |
| `defaultModel` / `defaultEffort` | Fallback model settings; empty uses the executor's native default | Empty |
| `companionScript` | Codex Companion script used by `executor: codex` | Empty |
| `companionStateDir` | Legacy companion state root, also passed to Codex preflight | System Temp `codex-companion` directory |
| `companionStateRoots` | JSON array encoded as a string; overrides Codex job roots | Plugin data first, then legacy Temp |
| `modelsCachePath` | Codex model and effort cache | `~/.codex/models_cache.json` |

Paths beginning with `~` expand on Windows, macOS, and Linux. Run `/reload-plugins` or start another Claude Code session after plugin configuration changes. See [the registry example](workflow/projects-scope.example.md).

## Dispatch settings

The shared file contains three strings:

```json
{ "executor": "claude", "model": "", "effort": "" }
```

The executor, model, and effort controls beneath the panel title are plain Buttons. Each press cycles the available values, writes the file, and shows a toast. The same Buttons render on mobile without Client support. Settings apply to the next dispatch; each running task keeps its requested values.

Commands show or set the same values:

```text
/console executor
/console executor claude
/console model
/console model <name>
/console effort <level>
```

Use `/console model ""` or `/console effort ""` to restore the selected executor's default. A missing, malformed, or unreadable file falls back to `executor`, `defaultModel`, and `defaultEffort`.

### executor: claude

This is the default. It uses native Claude Code background agents and does not require Codex Companion or a Codex account.

The mod keeps a project-to-session mapping and the latest 20 managed job records per project in `claudeSessionsPath`. A first task starts in native background mode with the project as its working directory; later tasks resume the mapped full session ID. Local help from Claude Code 2.1.289 documents `--bg`, `--resume`, and `--continue`. The mod uses `--bg` with a unique `--name`, confirms the returned short ID through the agents list, and uses the saved full session ID for resume. It does not use `--continue --bg`, because that combination selects the most recent session for the working directory instead of the explicitly managed session.

`claude agents --json --all --cwd <project-root>` supplies active and completed agents. The mod accepts only background agents whose `cwd` exactly matches the project, uses their short `id`, full `sessionId`, `name`, `state`, `status`, and `waitingFor`, and reads output with `claude logs <id>`. A launch must resolve by its unique name to exactly one full session UUID (the existing UUID when resuming) before the mapping is saved; an ambiguous launch stays unresolved and blocks another dispatch. A later refresh can recover a uniquely named launch. Blocked or waiting agents remain running, and an absent agent does not imply completion. The local sample showed `working` and `blocked` states with `busy`, `idle`, and `waiting` statuses; the documented terminal states `done`, `failed`, and `stopped` end the managed job.

The sessions file is mod-owned state. Malformed content fails closed instead of discarding the saved session identity. Writes are serialized inside one mod process, so keep one console process as its writer; simultaneous writes from separate processes are not guaranteed atomic. Claude dispatch adds no permission-bypass flag and inherits the normal Claude Code permission flow. Attach to a blocked background agent in Claude Code to handle its approval or input.

Model Buttons offer the CLI aliases `fable`, `opus`, and `sonnet`; `/console model <name>` also accepts a free-form value. Effort options are `low`, `medium`, `high`, `xhigh`, and `max`. Empty values leave both choices to Claude Code.

Claude Code's [agent view](https://code.claude.com/docs/en/agent-view) is the upstream interface for inspecting and controlling background agents. The [CLI reference](https://code.claude.com/docs/en/cli-reference) owns current command and flag behavior; this mod stores only the managed session identity needed to continue a project.

### executor: codex

Use this optional executor when Claude quota is limited. Configure `companionScript` and ensure Codex Companion can reach its account before dispatching.

Codex model order comes from `models_cache.json` (`models[].slug`). Efforts use `supported_reasoning_levels[].effort`, falling back to `low`, `medium`, `high`, and `xhigh`. An unavailable cache leaves the current values visible; set a model with `/console model <name>`. Empty model or effort values omit their flags and use Codex defaults.

Jobs are read from `~/.claude/plugins/data/codex-openai-codex/state` before the legacy Temp root. Duplicate IDs use the newest `updatedAt`; the state timestamp is the fallback, and ties keep the first root. Override the list with, for example, `"companionStateRoots": "[\"~/jobs/current\",\"~/jobs/legacy\"]"`. This setting does not change the Codex quota or preflight probes.

With the Codex executor selected, refresh runs the bundled companion and broker preflight on its probe interval. Quota comes from the newest locally available Codex record and may be stale. Dispatch acceptance only means the companion accepted the job. Completion and review still require STATUS evidence and the configured local verification.

Copy this optional rule into the user `CLAUDE.md` when other tools also dispatch Codex:

```markdown
When dispatch.json selects executor "codex", read its model and effort.
Pass each nonempty value as one --model or --effort argument. Omit the flag for
an empty value. If the file is missing, use the executor's native defaults.
```

## STATUS cards

Each STATUS file has one machine-readable block delimited by `<!-- CARD -->` and `<!-- /CARD -->`. Keep it to ten lines or fewer. The parser recognizes the Traditional Chinese keys in [the template](workflow/STATUS-template.md), including `更新`, `狀態`, `驗證`, `等使用者`, `下一步`, and `關卡`.

Set `關卡` to `無`, `spec：…`, `review：…`, or `release：…`. Unknown nonempty gate text also blocks continuation. A practical local path for a Git project is `.console/STATUS.md`, excluded through that project's `.git/info/exclude` when it should remain local.

## Project actions

The right-click menu and expanded project cards expose the same actions. Mobile uses card Buttons. Every trigger shows an immediate toast, spins and rejects duplicate activation while running, then writes its result to the activity feed.

| Action | Availability | Behavior |
| --- | --- | --- |
| ▶ Run verification | CARD has `驗證` | Runs in the project root with a five-minute timeout; no model quota |
| ⇢ Sync STATUS | SYNC | Dispatches the selected executor to update only CARD and history |
| ⇢ Continue | IDLE, with a next step and no decision or gate | Requires a second press within three seconds, then dispatches the selected executor |
| ✎ Decide | `等使用者` is nonempty | Prefills a draft and one-shot project context; Claude runs only when submitted |
| ⚑ Review gate / final review | Recognized spec, review, or release gate | Sends evidence to the console Claude; release review cannot execute release |
| ↗ Open STATUS.md | Always | Requests the editor to open the file |

Verification stores the latest timestamp, exit status, and final three captured lines per project. Put only trusted local checks in `驗證`; the command runs through a shell and must not contain deployment or formal-environment operations.

A dispatch shows RUNNING optimistically until managed state is refreshed. Acceptance is not completion. GATE is purple, sorts after ACTION and before RUNNING, and remains busy until its matching Claude review turn ends. `prompt.fill` can refuse when no composer exists or a dialog owns it; the panel reports that failure without submitting a decision. Remote Control composer behavior still needs device acceptance testing.

## Commands

| Command | Behavior |
| --- | --- |
| `/console` | Open or close the panel |
| `/console refresh` | Refresh files and slow probes |
| `/console band` | Toggle the band above the prompt |
| `/console plain` | Toggle interactive and plain project rows |
| `/console demo` | Load fictional data; `refresh` returns to live state |
| `/console executor [claude|codex]` | Show or choose the executor |
| `/console model [name]` | Show choices or set a model |
| `/console effort [level]` | Show choices or set effort |

Selecting a project applies only to the next accepted prompt. A downstream rejection retains the selection for retry.

## Workflow

[The `claude-console` workflow](workflow/claude-console/SKILL.md) defines the console operating procedure. Normal console reads stay limited to the registry, CARD blocks, and short managed-task summaries.

## Limitations

- Bundled probes currently require Windows and PowerShell.
- The UI is currently Traditional Chinese.
- Project matching depends on the configured registry and STATUS contract.
- The panel reports local evidence and does not replace project-specific verification.
- Refresh runs every 60 seconds; process probes are cached for five minutes unless forced.
- Roots with the same final directory name can collide in companion-state matching.
- A selected project adds context to one prompt and does not change the active working directory.

## Development checks

```powershell
claude plugin validate .
claude plugin validate plugins/console-status
claude plugin test plugins/console-status
node .task/check-docs.mjs
```

## License

MIT. See [LICENSE](LICENSE).
