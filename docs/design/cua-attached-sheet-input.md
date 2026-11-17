# Recognize attached sheets in exact-window input validation

[English](cua-attached-sheet-input.md) | [简体中文](cua-attached-sheet-input.zh-CN.md)

## Problem and scope

An App observation can select an attached macOS file sheet whose CGWindowID is
absent from the application's direct AXWindows array. The background mutation
validator then rejects that observed sheet as `off_space_or_ax_unresolved`.
The original VLC reproduction used the earlier App keyboard and pointer routes.
Current App keyboard, pointer and paste operations use the upstream activation
route. App semantic operations (`setValue`, `performSecondaryAction` and
`selectText`), observation capability checks and programmatic background input
still use the exact-window validator and need attached-sheet membership.

## Proposed behavior

Keep the existing direct-window path. Only when the requested window is absent
from its AX records, use the existing bounded attached-sheet discovery on those
retained roots. Add a sheet only when both root and sheet discovery are complete, its own window ID
is mapped, and its root window has a mapped record. Sheets minimize with that
root, so inherit its minimized state; an unknown root state remains unknown.
Do not duplicate an already mapped record. Reuse the upstream window-ID mapping
contract; attached-sheet discovery adds no separate geometry heuristic.

WindowServer ownership, element ancestry, hidden/minimized state and keyboard
focus/competing-destination checks remain in force where applicable. Delivery
selection remains with the caller, including the upstream App activation route.
This change adds no delivery fallback, retry or broader app-level target.
Unmapped or incompletely discovered sheets remain refused. Existing direct
targets avoid an additional discovery traversal.

## Validation and acceptance

Test mapped and unmapped attachments, unknown/minimized roots and duplicate
records. Retain existing sibling-window keyboard-ambiguity checks. Build and
run focused native unit tests without host desktop interaction. In a separate
guest Qwen MCP session, select or edit an observed field through an App semantic
operation and confirm the effect belongs to the intended attached sheet.
Programmatic background keyboard input requires separate delivery validation.
Preserve failed attempts and record time/tokens in any later benchmark;
the earlier VLC results do not establish behavior under the updated App route.
