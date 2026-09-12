# Web Shell context overview and manual compression

[English](2026-09-12-web-shell-context-compaction.md) | [简体中文](2026-09-12-web-shell-context-compaction.zh-CN.md)

## Problem and current behavior

The composer tooltip, transcript context cards, and right-side context panel
already expose token usage. Category totals and detailed lists are separated,
making readers find the same category twice. Remaining capacity is not prominent,
and the panel has no direct way to run the existing `/compress` command.

## Goals and scope

Deliver clearer context accounting and manual compression in one change. Reuse
existing usage data and compression behavior. Do not add new daemon routes,
change compression algorithms, invent a system-prompt sub-breakdown, or change
the composer's click-to-transcript behavior.

## Presentation

The tooltip shows exact used, total, and remaining counts from existing local
counters; hovering does not request data. Remaining capacity is the nonnegative
difference between the context window and used tokens, and includes the
compression buffer. It must not be labeled as free space.

Both full context surfaces share an overview followed by the used/free/buffer
legend and an advanced category disclosure. Put per-item details immediately
under their category total, preserving separate built-in and MCP tools, full
names, loaded skill bodies, and token ordering. Keep the continuous proportional
meter and existing warning/error thresholds. Numeric values use readable theme
tokens and tabular figures. Sidebar categories start collapsed; transcript
details start expanded. Disclosure state lasts for the current mount.

Transcript readings are explicitly labeled as snapshots. Detailed snapshots
offer the existing current-context read action when available. Refreshes and
compression never rewrite previous snapshots. Before the first usage reading,
retain the estimated-overhead view instead of implying measured zero usage.

## Manual compression and ownership

The current context panel offers manual compression beside Refresh. Execute the
canonical `/compress` command through the owning live session's existing prompt
lifecycle. Await completion, show pending and failure feedback, prevent duplicate
submissions, and refresh current context after completion. Cancellation feedback
acknowledges the request; the existing backend can still
finish compression after cancellation. It must not claim that compression stopped
or succeeded. Manual Refresh after cancellation reconciles the current reading
and composer counters.

Controls are supplied by the owning main view or split pane, including its live
busy, connection, and write-block state. Recheck ownership and availability at
invocation and after asynchronous work. In split view, sessions in the pane set
require their pane's controls, including during registration and cleanup. The
primary session retains its own controls when it is outside that set.
Restored foreign-session tabs are
read-only until their live owner supplies controls. A restored tab's read adapter
may inherit unrelated actions, so it is never a source of mutation authority.
Switching sessions, closing a pane, or unmounting a panel must not apply an old
result to a new session. Before submission, the host disarms the previous prompt's
retry state and clears stale follow-up suggestions. The ordinary composer draft and attachments are
retained.

Only the advertised built-in `compress` command enables the action; an identically
named custom command is not compression authority. Reuse the existing Goal gate
and source view's busy/write guards. Compression output does not carry ordinary
usage metadata, so the completion read explicitly reconciles composer counters
through `getContextUsage({ syncCounters: true })`. This opt-in updates neither
billing usage nor history, and only applies to the same session/model if no newer
usage arrived while reading. Unknown zero counts preserve the last known
counters; positive estimates remain valid, including after compression. A refresh
failure after successful compression has separate feedback and must not automatically repeat compression.

## Implementation areas

- `ChatEditor` and its tests: remaining capacity in the lightweight tooltip.
- `ContextUsageMessage`, styles, and tests: shared overview and nested categories.
- `ContextUsagePanel`, styles, and tests: compression controls and feedback.
- `App`, `ChatPane`, and `ArtifactPanel`: live owner controls and their lifecycle.
- Session actions: opt-in reconciliation of owner-scoped composer counters.
- English/Chinese strings and browser context scenarios.

## Risks and validation

The principal risk is a stale or cross-session mutation. Verify active and idle
sessions, rapid clicks, busy tasks, connection loss, cancellation, session changes,
and restored foreign tabs. Verify post-compression counters and preserve previous
snapshots. Check zero/estimated/over-limit readings, long names, keyboard
disclosures, light/dark themes, and narrow composer/panel widths.

Run a baseline with the global CLI, then validate the built local application,
root build/typecheck/bundle, and affected package tests. Read the full proposed
diff in open-ended and reverse-audit passes until two consecutive passes are
clean. Publish actual before/after UI captures in the PR using the fork's assets
branch.

## Acceptance criteria and open questions

All three context surfaces agree on used and remaining capacity. Category details
appear once under their totals. Compression is available only for its idle,
writable live owner; pending, failure, and completion are visible. Current usage
refreshes while historical readings remain unchanged. No open product questions.
