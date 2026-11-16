# Web Shell hook statistics

[English](web-shell-hook-statistics.md) | [简体中文](web-shell-hook-statistics.zh-CN.md)

## Problem and scope

PR #17015 supplies local main-agent Hook lifecycle records, canonical history
identities and paginated turn queries. This second PR makes those records
accessible from a reply. Managed collection, async final results, session-wide
totals and subagent aggregation remain out of scope.

## Data and ownership

Reuse the session-owned trajectory lifecycle store for live/replayed Hook
metadata and its existing reconnect, invalidation and cleanup boundaries.
Resolve a turn through its persisted record and the navigation index's
`historyPromptId`, or the canonical identity in live Hook metadata. Admission
IDs are not interchangeable with history identities, especially on retry.
Never assign an event to the newest reply by arrival time.

The provider binds read-only SDK queries to the attached session/client. A
changed session invalidates pending reads. Persisted full-turn summaries come
from the server; complete live records can show in-progress state immediately.
Unknown replay state does not replace a persisted terminal result. Details use
frozen snapshots with 50 executions per page. Live Hook
changes refresh only the affected turn's summary, without fetching on text deltas. Historical
records outside the rendered transcript remain queryable through navigation.

## Interface

The latest assistant reply of a turn has a quiet anchor icon between branching
and sources/time. Before a reply it uses the prompt row; a turn without an
assistant reply uses its terminal status when available.
Hover or keyboard focus shows a compact summary of runs, blocked, unsuccessful
and total duration; clicking opens the statistics dialog. Recent records appear
only in the dialog. Narrow screens use a more menu. Reuse the shared tooltip,
dropdown and dialog primitives, portal root and theme tokens. Escape dismisses
overlays and focus returns to the trigger.

The dialog shows whole-turn executions, blocked, unsuccessful (error + timeout)
and cumulative execution time in a compact grid. Chronological records use
single-line summaries and two-column expanded details on wide screens, with a
scroll area capped at 70vh so expanded records remain readable. The dialog reads a fresh
snapshot when opened, without a manual refresh action or redundant status and
duration explanations. Status, event, source, duration and safe names are text,
never interpreted HTML. Async dispatch is not completion; its dispatch duration
is separate. Unknown outcomes and partial history coverage are explicit. Missing
execution durations are excluded from the total without an additional warning.
Empty unrecorded and unsupported turns do not show fabricated zeros or an entry.
Read failures retain a retryable entry; closing the dialog refreshes its hover summary.

## Changes and validation

Changes are confined to Web Shell lifecycle state, provider/query wiring,
message placement, UI components, translations and tests. The data contract and
Hook execution behavior remain owned by PR #17015.

Verify live/replay deduplication, canonical identity across retry, session
switches, stale responses, reconnect, pagination snapshot consistency, errors
and retry, no-assistant turns, partial/unknown/dispatched states, and over 1,000
executions. Run focused tests, build, typecheck and browser acceptance with real
local Hook records. Check light/dark, 320 px width, keyboard, touch, Escape and
focus return, and preserve existing reply actions. Record baseline and final
evidence in `.qwen/e2e-tests/web-shell-hook-statistics.md`.
