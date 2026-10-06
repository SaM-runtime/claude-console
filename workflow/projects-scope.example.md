# Project registry

This example uses fictional projects. Replace every sample path with an absolute path on your machine.

## STATUS 卡位置

| Project | STATUS path | Scope | Out of scope | Executor |
| --- | --- | --- | --- | --- |
| Project Alpha | `C:\Projects\project-alpha\.console\STATUS.md` | API maintenance | Desktop client | codex |
| Project Beta | `C:\Projects\project-beta\.console\STATUS.md` | Portal UI | API maintenance | |
| Project Gamma | `C:\Projects\project-gamma\.console\STATUS.md` | Vendor handoff | Code changes | manual |

`Executor` is optional: `claude`, `codex`, `manual`, or blank for the global default. A pane override in `dispatch.json` wins over this column. `manual` projects are never dispatched by the panel; CARD, verification, and gates still work.

## Console rules

- Read only each STATUS file's CARD block during normal refreshes.
- Keep work for one project inside that project's managed executor session.
- Check the scope columns before dispatching work.
