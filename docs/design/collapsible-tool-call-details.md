# Collapsible tool call details

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
expands that tool group for the rest of its mounted lifetime. In append-only
terminal mode, the row points to `Ctrl+O`, which already opens full transcript
detail. Approval prompts, user-initiated shell calls, and focused interactive
shells stay expanded because collapsing them would hide required interaction.

The setting is runtime-only UI state: it does not change tool execution,
recording, model context, or serialized history.

## Test plan

- Verify the setting is schema-registered, visible in `/settings`, and does not
  require restart.
- Verify a collapsed tool group omits its description and result.
- Verify a complete click expands one group and a drag does not.
- Verify approval prompts and focused/user-initiated shells remain expanded.
- Verify `Ctrl+O` still forces full detail.
