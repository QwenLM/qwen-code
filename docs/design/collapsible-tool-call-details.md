# Collapsible tool call details

[中文版](collapsible-tool-call-details.zh-CN.md)

## Problem

Code mode `exec` calls can place large results directly in the transcript. The
existing compact renderer only summarizes read, search, and list tools, so code
execution still consumes substantial screen space.

## Design

Add `ui.showToolCallDetails`, a user-facing boolean setting that defaults to
`true` to preserve the current display. When set to `false`, ordinary tool
groups render as one line containing only status, tool name, count, elapsed
time, and an expansion hint. Arguments, results, images, and notices remain in
the history item and are only hidden by the renderer.

In Virtualized History with mouse tracking enabled, clicking the collapsed row
expands that tool group immediately on release, including the first click of
multi-click selection. A single click on the first row of a completed expanded
group collapses it after the multi-click window. A follow-up click in the same
group, a wheel scroll, a drag, or a context-menu press cancels that pending
collapse; unrelated left clicks outside the group and bare hover motion do not.
Multi-click detection uses the same
wide-character-snapped frame coordinates and held-drag rules as text selection.
Clicks in result content, link clicks, multi-click text selection, drag selection,
and context-menu interactions do not collapse an expanded group. A live group may be expanded but cannot be collapsed until it completes.
Scheduler-backed groups keep this state by `batchId` when their live pending row
becomes committed history; adapter-built groups without a batch id keep it for
their mounted lifetime. In append-only terminal mode, the row points to
`Ctrl+O`, which already opens full transcript detail. Approval prompts,
user-initiated shell calls, and focused interactive shells stay expanded because
collapsing them would hide required interaction.

The setting is runtime-only UI state: it does not change tool execution,
recording, model context, or serialized history.

## Test plan

- Verify the setting is schema-registered, visible in `/settings`, and does not
  require restart.
- Verify a collapsed tool group omits its description and result.
- Verify one complete click expands immediately, even when it starts a multi-click
  selection; an independent single click on its first row collapses only after
  the multi-click window.
- Advance past that window when verifying that result-body clicks, link clicks,
  multi-click selection, drag selection, and context-menu interactions do not
  collapse an expanded group. Cover wide-character boundaries and same-cell drags.
- Verify outside left clicks and bare hover motion preserve a pending collapse,
  while wheel scrolling, dragging, and unmounting cancel it without changing
  shared batch state. Bare hover between double-click presses must preserve the
  multi-click chain.
- Verify a pending group can expand but cannot collapse until it completes.
- Verify approval prompts and focused/user-initiated shells remain expanded.
- Verify `Ctrl+O` still forces full detail.
