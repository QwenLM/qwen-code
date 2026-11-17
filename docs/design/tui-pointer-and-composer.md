# TUI scrolling, selection and approval placement

[English](tui-pointer-and-composer.md) | [简体中文](tui-pointer-and-composer.zh-CN.md)

## Problem and evidence

The virtual transcript moves three rows for every reported wheel event, then
waits for a trailing 16 ms input timer and Ink's output throttle. Frequent input
therefore appears as 6–9 row steps. In a 5000-line message, the Ink patch also
horizontally clips invisible rows before vertical clipping: measured render p50
is 68.50 ms versus 5.42 ms with vertical clipping first.

Main transcript selection works with standard SGR input, but popup session
previews lack the selection controller. Native Warp drag verification remains
pending because the native automation mouse API reports noWindowsAvailable.
Approval mode currently consumes the left footer, away from the input frame.

## Changes and rationale

Keep the existing virtualized list and Ink renderer. Reorder Ink clipping so
horizontal work applies only to vertically visible rows, preserving output,
semantic boundaries and selection cells. Do not add a metadata cache.

Treat each reported wheel event as one row, matching Grok's Warp normalization.
Deliver the first update immediately and coalesce later updates to a 16 ms
cadence. Limit each flush to half the viewport (at least one row), and drain
remaining input on subsequent frames. After input stops, allow at most one
additional half-viewport of catch-up, discarding a flooded tail. Reversal discards the old direction;
keyboard navigation, a pointer press, focus loss and unmount cancel pending
motion. Scrollbar presses remain immediate and drags use the latest position.
Only reattach bottom-following when the current position reaches the current
bottom, so a measured one-row upward movement cannot snap back. The prior
position must also reach its prior bottom when history grows; a one-row
tolerance would undo explicit upward input on the next message.
This improves continuous terminal-row movement; it does not introduce pixel
coordinates or a copy of Grok's acceleration/classification system.

Give popup session previews the existing text-selection and content-mouse
controllers. Pause scrolling and selection events while their context menu is
open, preserving the selected text. Escape/Enter in the menu must not exit or
resume the preview. Use physical terminal geometry for mouse coordinates.
Clip copying and painted selection to the owning viewport, and mark decorative
borders non-selectable. The renderer's optional selection bounds travel with
the range and participate in deduplication. When adding the selection
background, replace the cell's prior background style so ANSI serialization
restores the popup surface immediately after the selection ends.

The user confirms that main-transcript drag now works in Warp. Extend the
same visible-region selection to the input text area, with one selection
owner per output stream. A drag highlights and copies without moving the input
cursor; an ordinary click still positions the cursor. Input text edits clear
the copied visual selection. This does not add editable replacement ranges to
the text buffer. Expandable thought/tool/process summaries must ignore release
while a text selection exists, including drags returning to their start cell.

Place the localized approval mode on the input's lower-right border in both
main and agent views. Keep voice/session top labels, cursor geometry and input
height. Truncate labels by terminal-cell width. Retain the mode-switch hint and
fallback mode display where no visual input border is available. Permission
policy and mode-switch handlers remain the existing ones.

## Scope and files

The change affects the existing Ink patch and its regression tests,
ScrollableList and its frame scheduler, VirtualizedList's bottom-follow rule, SessionPreview, BaseTextInput,
InputPrompt/Footer and AgentComposer/AgentFooter, TextInputMouseController,
selection ownership, and thought/tool/process click guards with focused tests. Existing
dialog and transcript hierarchy changes are preserved. OpenTUI and native
terminal scrollback retain their existing scrolling implementations.

## Validation and acceptance

Compare global and local PTYs using the same synthetic transcript, events,
timestamps and visible frames. Verify sparse input, fast input, burst draining,
direction changes, PageUp/Home/End, scrollbar takeover, focus and resize.
Compare long-message rendering before/after without changing output or semantic
cells, including CJK, ANSI styles and horizontal plus vertical clipping.

Select ASCII, CJK and multiple lines in transcript and preview; verify highlight,
copy on release, context-menu ownership and returning to the original chat.
Verify the approval label in main/agent input, all modes, narrow terminals,
multiline input, top labels and reader/native fallback. Run focused tests, lint,
format checks, build, typecheck and bundle. Record native Warp coverage honestly
if its pointer automation remains unavailable.

## Open questions

Native automation still cannot deliver pointer actions to Warp. The user has
confirmed main-transcript drag now works; verify the reported input-selection
and expand-on-release gaps with the real PTY harness and focused tests.

## Captured examples

The [installed baseline](images/tui-workspace/before-installed.png) reports a
0.25.0 banner; it is an environment comparison, not a rebuilt PR base. The
[current startup](images/tui-workspace/after-startup.png),
[input selection](images/tui-workspace/input-selection.png), and
[centered settings](images/tui-workspace/settings-popup.png) use isolated fake
providers and synthetic session data. Pointer measurements also compare the
earlier local bundle against the updated bundle.
