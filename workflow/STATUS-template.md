# <Project name> STATUS

<!-- CARD: The console reads only this block. Keep it to 10 lines or fewer. The Chinese field names are the parser contract; do not rename them. -->
- 更新：YYYY-MM-DD HH:MM · rev <n> · job <job-id> · <executor> <model>/<effort>
- 狀態：<one-sentence current state>
- 驗證：`<one-line local command>` -> <actual result; verified YYYY-MM-DD HH:MM>
- 執行中：<job-id or 無>
- 等使用者：<decision or input; 無 if empty>
- 下一步：<one action for the console to dispatch>
- 關卡：無
<!-- /CARD -->

## CARD rules

- `rev` in `更新` counts CARD writes. Before writing: re-read the CARD; if `rev` is not the value you last read, stop and report the conflict instead of overwriting. Write `rev + 1`.
- `驗證` holds only one runnable local command in backticks (`` `pytest -q` `` -> result) or stays empty. Never put notes there: the console runs that field as a shell command. Put findings in `狀態` or `.task/REPORT.md`.
- `等使用者` lists each decision separated by `；`. When a decision has choices, write them inline as `<question>：A) <option> B) <option>` (or `1) 2)`); the console shows every decision and option on its own line. Keep commands inside parentheses so a `;` in them does not split the decision.
- `關卡` holds exactly one value: `無` | `spec：<scope and acceptance to approve>` | `review：<changes, acceptance result, review job>` | `release：<exact scope and readiness evidence>`.
- Set a gate only at these points: `spec` when the spec or acceptance contract needs console approval (or changed); `review` when acceptance is green and the independent review job finished; `release` when work is ready to ship.
- Only the console clears a gate (back to `無`) after it decides. `release` additionally needs the user's explicit approval of the exact scope; a gate approval never substitutes for user authorization.
- An unfinished or failed review job never counts as passed.

## Scope

- In scope:
- Out of scope:
- Related work owned elsewhere:

## Acceptance contract

- Test / parity command: `<command>` (baseline: `<fixed baseline>`)
- Expected: <output or exit code>

## Decisions

- D-01 YYYY-MM-DD <owner>: <decision and reason>

## Approaches that did not work

- YYYY-MM-DD <approach> -> <reason and evidence path>

## Open questions

- <question>: <current evidence and what is missing>

## Evidence index

- <name>: `<path>` (<hash or run identifier>)

## History

- YYYY-MM-DD rev <n> <job-id>: <work and result>
