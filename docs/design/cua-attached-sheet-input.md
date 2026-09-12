# Recognize attached sheets in exact-window input validation

[English](cua-attached-sheet-input.md) | [简体中文](cua-attached-sheet-input.zh-CN.md)

## Problem and scope

An App observation can select an attached macOS file sheet whose CGWindowID is
absent from the application's direct AXWindows array. The mutation validator
currently rejects that observed sheet as `off_space_or_ax_unresolved`. A fresh
VM reproduction confirmed this for both keyboard input and an observed Search
element in VLC. An earlier AXPress error had already opened the sheet; this
change does not retry or reinterpret that separate uncertain dispatch.

## Proposed behavior

Keep the existing direct-window path. Only when the requested window is absent
from its AX records, use the existing bounded attached-sheet discovery on those
retained roots. Add a sheet only when both root and sheet discovery are complete, its own window ID
is mapped, and its root window has a mapped record. Sheets minimize with that
root, so inherit its minimized state; an unknown root state remains unknown.
Do not duplicate an already mapped record or infer a window from geometry.

WindowServer ownership, element ancestry, hidden/minimized state and keyboard
focus/competing-destination checks remain in force. Delivery stays in the
background; there is no foreground fallback, retry or broader app-level target.
Unmapped or incompletely discovered sheets remain refused. Existing direct
targets avoid an additional discovery traversal.

## Validation and acceptance

Test mapped and unmapped attachments, unknown/minimized roots and duplicate
records. Retain existing sibling-window keyboard-ambiguity checks. Build and
run focused native unit tests without host desktop interaction. In a separate
guest Qwen MCP session, repeat the observed file-sheet action sequence with
native error capture and confirm actions affect the intended sheet. Then run
the unchanged conversion benchmark in a clean clone and verify the exported
MP3. Preserve failed attempts and record time/tokens; improved correctness is
required before treating a shorter run as a performance improvement.
