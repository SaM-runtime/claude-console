---
name: claude-console
description: Run one Claude Code session as a compact multi-project console for specification, supervision, decisions, and review gates.
---

# Claude console workflow

The console owns cross-project specification, supervision, and review gates. It is an index rather than a project workspace: keep detailed implementation inside the managed project session. The operator supplies decisions and gives the final release approval. No panel action deploys or changes a formal environment.

| Role | Responsibility |
| --- | --- |
| Claude console | Own cross-project specification, supervision, decision drafts, and review gates |
| Selected executor | Implement and verify work inside the authorized project scope, then sync evidence to STATUS |
| Operator | Supply project decisions, handle required approvals or input, and give final release approval |

## Start the console

1. Read the configured registry.
2. Read only the `<!-- CARD -->` block of each registered STATUS file.
3. Reconcile each CARD with the selected executor's managed task or session state.
4. Do not dispatch when that project already has a running or queued action.
5. When completed work is newer than the CARD, use Sync STATUS before starting more work.

Keep normal reads to the registry, CARD blocks, and short task summaries. Run the CARD's one-line local verification command when checking a claim. Move detailed requirements, debugging, and design work to the project's managed session.

## Dispatch

The shared dispatch file selects one executor and optional model settings:

```json
{ "executor": "claude", "model": "", "effort": "" }
```

Use the panel's Sync STATUS or Continue action. Continue requires a second press within three seconds. Each task stays within the project's authorized local scope and updates the CARD, including `關卡`, when it ends.

### executor: claude

This is the default and uses Claude Code's native background agents. It does not require a Codex account or companion installation.

- Keep one managed full Claude session ID and the latest 20 managed job records per project in the configured sessions file. Treat it as mod-owned state and fail closed when it is malformed.
- Start new work with native background mode in the project root. Resume later work with the mapped full session ID.
- Do not substitute `--continue`: with background mode it copies the most recent session for the working directory instead of reliably selecting the managed session.
- Give every launch a unique `--name`. Reconcile exact-root background agents with `claude agents --json --all --cwd <project-root>` and read output with `claude logs <id>`. The returned `sessionId` is the full value used for resume.
- Require the launch name and returned short ID to resolve to exactly one new full session UUID. Keep ambiguous launches unresolved and block a duplicate dispatch while a launch is unresolved or its managed session is active; a later refresh may recover a uniquely named launch.
- Treat `done`, recognized failures, and recognized stopped states as terminal. Keep blocked or waiting agents running, and do not infer completion when an agent is absent from the query result. Attach to a blocked agent to handle its approval or input.
- Use one console process as the sessions-file writer. Writes are serialized within that process, but cross-process writes are not guaranteed atomic.
- Inherit normal Claude Code permissions; do not add a permission-bypass flag.
- Empty model or effort values use Claude Code's native defaults. The panel offers its verified aliases and also accepts a free-form model value.

See the official [agent view](https://code.claude.com/docs/en/agent-view) and [CLI reference](https://code.claude.com/docs/en/cli-reference) for the upstream interface.

### executor: codex

Use this optional route when Claude quota is limited. It requires Codex Companion, its configured script, and a Codex account.

1. Run the included Codex preflight before dispatching.
2. Read model choices from the configured Codex model cache; use the fallback effort list only when the cache has no per-model list.
3. Dispatch through the companion with the configured model and effort. Empty values omit their flags and use Codex defaults.
4. Read job state from the configured companion roots, with plugin data ahead of the legacy Temp root by default.
5. Treat dispatch acceptance and quota records as status evidence, never as proof that the task or its verification passed.
6. Resume the managed project task for follow-up. Use a fresh task history only when intentionally separating work, and record that decision in STATUS.

The console still owns decisions and review gates. The executor must stop at `spec`, `review`, or `release` and return evidence to the console; it never performs a release.

## Decisions and gates

Use `等使用者` only for a decision that needs the operator. The decision action prefills a draft and attaches the selected project to the next accepted prompt.

Every task writes `關卡` as `無`, `spec：<scope and evidence>`, `review：<changes and verification>`, or `release：<readiness evidence>`. A gate or decision blocks continuation.

- For spec and review, judge the selected project's evidence and state the result and reasons. Do not claim checks that were not run.
- For release, return **ready / not ready + reasons + one sentence asking the operator to confirm**. This does not authorize release, deployment, or a formal-environment change.
- Verification commands must be local checks. Never place deployment or formal-environment mutations in the CARD.

## Add a project

1. Copy [the STATUS template](../STATUS-template.md) to the project.
2. Fill in its scope and first CARD.
3. Add one row under `## STATUS 卡位置` using [the registry example](../projects-scope.example.md).
4. For a Git repository, a local `.console/STATUS.md` may be excluded through that repository's `.git/info/exclude`.

## Report results

- Lead with the current state, one short line per project.
- Report only results supported by current evidence.
- Ask for a decision only when work cannot proceed without it.
- Keep commit, publication, deployment, database writes, installations, and security changes behind their own authority and project procedure.
