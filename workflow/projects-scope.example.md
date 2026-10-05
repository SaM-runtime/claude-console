# Project registry

This example uses fictional projects. Replace every sample path with an absolute path on your machine.

## STATUS 卡位置

| Project | STATUS path | Scope | Out of scope |
| --- | --- | --- | --- |
| Project Alpha | `C:\Projects\project-alpha\.console\STATUS.md` | API maintenance | Desktop client |
| Project Beta | `C:\Projects\project-beta\.console\STATUS.md` | Portal UI | API maintenance |

## Console rules

- Read only each STATUS file's CARD block during normal refreshes.
- Keep work for one project inside that project's managed executor session.
- Check the scope columns before dispatching work.
