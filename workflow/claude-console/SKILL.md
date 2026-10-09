---
name: claude-console
description: Run one Claude Code session as a compact multi-project console that writes specs, dispatches an executor (Claude or Codex) per project, verifies results, and holds review gates.
---

# Claude console workflow

One Claude Code session is the console for every registered project. It owns specs, acceptance contracts, review gates, and reports. Executors (Claude background agents or Codex) implement inside each project. The user supplies decisions and approves releases. Nothing in the console deploys or changes a formal environment.

## Role split

If a mistake needs judgment to see, the console decides. If tests would catch it, the executor implements.

| Role | Owns |
| --- | --- |
| Console (Claude) | Spec, acceptance contract, gate decisions, diagnosis after repeated failures, short reports |
| Executor | Acceptance tests (for big tasks), implementation until green, CARD updates |
| Review job | Independent automatic review of the executor's change |
| User | Business decisions, approvals, release authorization |

## Executor selection

Read `~/.claude/handoffs/dispatch.json` before every dispatch (if it is missing, read the legacy `codex-dispatch.json` beside it; never write the legacy file).

- Global `executor` (`claude` | `codex`), `model`, `effort`.
- Per project: `projects["<root>"]` may set `executor` (`claude` | `codex` | `manual`), `model`, `effort`.
- Precedence: `projects` entry > registry `Executor` column > global.
- `manual`: never dispatch that project. Prepare a handoff (task file plus acceptance) for the user; CARD, verification, and gates still apply.
- Pass each nonempty model/effort as one flag; omit empty ones.

## Every task has an executable contract

A task file states scope, an executable acceptance check, a done criterion, and the report format. Acceptance is one of: a test file, a parity command against a fixed baseline, or an expected output or exit code. "It works" is not acceptance.

Task file skeleton (`.task/<name>.md`):

```markdown
Scope: <files/modules in and out of scope>
Acceptance: `<command>` -> <expected output or exit code> (baseline: <ref>)
Done when: acceptance passes and CARD is updated (rev + 1; 關卡 stays 無 and 下一步 names the review task until an independent review has finished)
Report: .task/REPORT.md, at most 15 lines: result, acceptance output, changed files, open risks
```

## Order of work

1. Console writes the spec and acceptance.
2. Big tasks: the executor first writes the acceptance tests; the console reviews them (`spec` gate).
3. Executor implements until acceptance is green.
4. Independent automatic review job runs (see below).
5. Console clears the gate or the work is done.

Never relax acceptance silently. A contract change goes back to the spec step and its gate.

## Effort

- `medium` by default.
- `high` for complex specs, parity work, or hard bugs.
- `xhigh` only after medium or high has failed.
- Two consecutive failures: the console diagnoses the cause instead of raising effort again.

## Gates

The CARD `關卡` line holds exactly one value: `無`, `spec：…`, `review：…`, or `release：…`. These are the only three gates.

- `spec`: spec or acceptance contract needs approval, or changed.
- `review`: acceptance is green and the review job finished.
- `release`: ready to ship. Return **ready / not ready + reasons + one sentence for the user to confirm**. Release also needs the user's explicit approval of the exact scope.

A gate approval never substitutes for user authorization. Only the console clears a gate. The executor stops at a gate and returns evidence; it never releases.

## Reading discipline

- Normal reads: the registry, CARD blocks, and at most ~15 lines of `.task/REPORT*.md`.
- Spot-check only the diffs the report names; at most ~20 lines per read. Never pull raw logs or full diffs into the console.
- Refresh the console session when its context is about half full or after more than three project switches, after confirming every CARD is current.

## Codex executor

- Dispatch from a task file: `codex-companion task --background --write --resume-last --cwd <root> --prompt-file .task/<name>.md` plus `--model`/`--effort` when set.
- One main thread per project: continue with `--resume-last`. Do not start side tasks with `task --fresh`; resume picks the newest task, so a side task steals the main line.
- Codex reviews Codex: after acceptance passes, the review task (`.task/review-*.md`, same contract as for Claude) runs in a new thread (`--fresh`), so it does not carry the work's context. The panel does this when `下一步` starts with the review task path.
  - The fix-up after the review resumes the newest thread, which is the review's: it holds the findings. The work's progress is in STATUS, the task files and git, not in the old thread.
  - `codex-companion review` / `adversarial-review` can add a read-only second opinion by hand. They cannot write the CARD, so their verdict does not set the `review` gate by itself.
  - An unfinished or failed review never counts as passed.
  - Non-git project: record the limitation in STATUS; do not initialize git.
- Quota or broker trouble: the panel's `codexFallback` setting holds the dispatch (`ask`), sends it to Claude (`claude`, recorded as `fallbackFrom: codex`), or ignores it (`off`).

### Known failures

- A job ends after about a minute with `missing codex-windows-sandbox-setup.exe`: the Codex app auto-updated. The user stops only the stale companion brokers of the target workspace, by PID (the panel shows them), never by image name.
- A job marked running whose process PID no longer exists blocks resume. Back up, then mark `jobs/<id>.json` and the job in `state.json` as failed.

## Claude executor

- Native background agents in the project root; the mod keeps one managed session per project and resumes it. When a resume comes back as a new session and the original is gone (retired by the daemon, or finished), the new one becomes the project's session.
- A turn starts by re-reading the CARD; the rev it reads then is the one that counts. Stop only when the CARD changed again before the write, never because a rev remembered from an earlier turn differs.
- At a gate or a decision, the executor writes it into the CARD (`關卡`, `等使用者`) and ends its turn. It never asks a question and waits: nobody is attached to answer, and a blocked agent drifts out of step with the console. Attach to a blocked agent only for a permission prompt.
- Review: dispatch a separate review task (`.task/review-*.md`) with the same contract (acceptance output, diff named by the report). It starts in a fresh session, never resumes the project's, and its verdict goes to the `review` gate. It gets no executor digest: it judges from the task file, its own run of the acceptance and the diff, not from the worker's account. Until it finishes, `關卡` stays `無` and `下一步` names the review task, so the panel can dispatch it. A review's `下一步` starts with its task path (`.task/review-x.md（…）`); work that follows a review starts with a verb (`依 .task/review-x.md 的意見修正`) and resumes the project's session.

## Decisions

Use `等使用者` only for a decision the user must make. The panel's decide action prefills a draft and attaches the project to the next prompt.

Write one decision per `；` segment and its choices inline as `<question>：A) … B) …` (or `1) 2)`). The panel lists each decision and option on its own line as pressable rows; the user picks options there and fills the composer with the keys (`1A 2B`), or types them. Record the answer under `## Decisions` and reset `等使用者` to `無`.

## Add a project

1. Copy [the STATUS template](../STATUS-template.md) to the project (for git projects, `.console/STATUS.md`, optionally excluded via `.git/info/exclude`).
2. Fill in scope and the first CARD.
3. Add a row under `## STATUS 卡位置` in the registry ([example](../projects-scope.example.md)); set `Executor` if the project should not use the global one.

## Report

- State first, one line per project, at most five bullets, one next step.
- Report only what current evidence supports; never claim checks that were not run.
- Ask the user only for decisions, approvals, and actions that need them: commit, push, PR, merge, deploy, database writes, installs, security changes.
