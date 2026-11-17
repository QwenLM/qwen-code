# TUI workspace layout and process summaries

[English](tui-workspace-layout.md) | [简体中文](tui-workspace-layout.zh-CN.md)

## Problem and scope

Short conversations currently shrink the virtual transcript and leave the
composer immediately below the messages. Dialogs replace the bottom controls,
moving the conversation when opened. Compact tools only combine calls inside
one scheduler batch, so successive thoughts, commentary, and commands still
produce a long execution log.

Extend the current main-checkout visual hierarchy work without consulting old
UI worktrees. Keep canonical history, tool execution, approvals, and terminal
protocols unchanged. The default Ink virtual viewport is the primary target.

## Design

The virtual transcript fills its allocated height even for empty or short
conversations. The composer and agent tab footer occupy the bottom rows. Other
embedded lists keep their existing content-sized behavior.

Regular dialogs render in a centered absolute layer above the transcript. Their
width and height are bounded by the terminal, with margins where space permits.
Settings and session windows are capped at 32 rows on tall terminals. Settings retains its
existing eight-item list limit rather than expanding to consume the screen.
They keep existing keyboard ownership and internal list navigation. The bottom
input is shown as an inactive preview; no second active input is mounted.
Dialog content paints an opaque background so transcript characters cannot
show through. Authentication flows retain their existing unbounded inline
layout, since clipping provider forms can hide required input. Screen-reader
and native-scrollback layouts retain their linear presentation.

A dialog-only size context supplies these bounds to layout consumers, including
session/resume/delete, rewind/diff, hooks, extensions, and their nested lists.
The physical `useTerminalSize` hook stays unchanged for pointer coordinates and
terminal protocols. Session previews inside a floating window use a scrollable
viewport rather than `<Static>` output, so opening or returning from a preview
cannot print outside the overlay. Standalone and linear previews keep their
existing scrollback presentation.

A presentation-only projection combines successful, completed tool batches and
completed thoughts across adjacent history entries. Assistant text is eligible
only when a subsequent tool batch in the same uninterrupted run establishes
that it is intermediate commentary. The trailing answer remains visible.
Errors, cancellations, live tools, approvals, images, specialized tool results,
and other status records remain visible and split a run. Original entries,
IDs, and source-copy indices remain authoritative. The summary is a single
muted count line with subdued thought duration and one expansion hint. Global
full-detail mode restores the original sequence; mouse expansion restores the
group's entries without changing stored history.

Manually expanded process groups keep their summary and restore each original
member as a separate virtual list row. Members retain their canonical references
and source-copy offsets, and each receives its own measured visibility state.
This preserves the Thinking Mods gate: expanded thoughts outside the viewport
must not start a render extension merely because their summary is visible.

## Affected areas and constraints

Changes stay in the CLI UI: workspace layout, virtual transcript sizing,
dialog bounds, process projection, summary rendering, and focused tests.
Shared tool categorization remains separate from result-discarding rules;
grouping a command must never discard its output. Deduplication of committed
and pending copies runs before aggregation. Original source-copy offsets are
computed before projection. Native `<Static>` scrollback remains append-only
and does not retroactively merge entries. Experimental OpenTUI behavior is
reported separately; existing rendering must remain operable.

## Validation and acceptance

Use an isolated deterministic OpenAI fixture and task-owned terminal sessions.
Record the global `qwen` baseline and verify the current bundle at 100 × 32,
40 × 16, and a tall terminal. Check startup and short-answer bottom alignment,
multiline input, long transcript scrolling, resize, dialog navigation and Esc,
and no input leakage behind a modal. Check successive thoughts, commentary,
reads, and commands collapse while the final answer remains; full detail must
restore chronology and outputs. Errors, approval, cancellation, and images
must remain visible. Verify dark/light/NO_COLOR and screen-reader fallbacks.
Screenshots use Chrome Canary. Run build, typecheck, bundle, focused tests,
format/lint checks, two clean self-audit passes, and independent review.

## Risks and open questions

Aggregation changes virtual item geometry and must invalidate cached heights
when membership or expansion changes. Overlay dimensions must match the width
used by child dialogs. Live records and final text must not be hidden by an
inferred model phase. These constraints are covered by projection and layout
regressions and terminal verification. No new settings or dependencies are
required.
