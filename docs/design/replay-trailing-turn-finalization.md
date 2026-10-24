# Finalizing Abandoned Calls During Live History Replay

[English](replay-trailing-turn-finalization.md) | [简体中文](replay-trailing-turn-finalization.zh-CN.md)

## Problem

During a busy `qwen/session/loadUpdates`, disabling dangling-call finalization
protects active tools but also leaves unmatched calls from older turns running
forever in the reconstructed view (#9953). An abandoned background tool can
then keep the client's task polling active even when task snapshots are empty.

## Boundary and scope

For a complete bulk replay, preserve unmatched calls originating in the last
replay turn. Reuse `isReplayTurnStartType` from the transcript reader, excluding
realtime messages: voice conversation records do not enter model history or
own tools, so they cannot supersede active tool calls. Ordinary user records
start a turn; inline mid-turn, cron, notification, Goal, and session-agent
messages do not. Without a known turn start, preserve unmatched calls
conservatively.

This is a replay-view boundary, not a new runtime admission or rewind model.
It does not prove that every unmatched call in the trailing turn is executing.
The existing caller decides whether the session is busy. Idle replay continues
to finalize every unmatched call unless explicitly exempted for restore.

This rendering boundary does not identify autonomous execution turns: cron,
Goal, and notification activity can stay grouped with the last ordinary user
record, so abandoned calls within that group remain pending. Notification
records can also be persisted before admission or consumed inline during an
active turn; their subtype alone is not a safe execution boundary. Broader
autonomous-turn cleanup needs execution/delivery evidence and maintainer
agreement rather than widening the shared rendering classifier.

## Change

Bulk replay identifies the source record UUIDs in the trailing turn, then
allows the existing replay machine to finalize unmatched calls outside that
set. The machine retains responsibility for matching calls and results.
Source UUIDs avoid applying a raw call ID exemption to a distinct older call
after duplicate IDs have been renamed. All parallel calls in the retained
turn remain eligible for real results.

The existing `skipFinalizeCallIds` restore exemptions still apply. A partial
live replay does not finalize older calls: an unread record may contain their
results. Record ordering, persisted transcripts, replay cursor format, tool
execution, model history, and reader/writer barriers are unchanged.

`replayPage` retains its existing boolean contract: unfinished pages do not
finalize calls, because a later page may contain the result. This change is
limited to complete bulk replay; paged busy reads remain a separate concern.

## Consumers and validation

The shared replay machine serves ACP history replay, SDK transcript views,
and HTML history export. Its new source-record exemption is opt-in and is
supplied only by CLI bulk replay; other consumers keep their default behavior.
`collectHistoryReplayUpdates` forwards the existing live/idle decision from
ACP load/resume and `qwen/session/loadUpdates`.

Regression tests cover abandoned A plus active parallel B/C, duplicate IDs,
a new prompt with no new tool call, late results, incomplete replay, restore
exemptions, and cross-page matching. Run the affected CLI and bridge tests,
build, typecheck, and bundle. The recorded test-script reproduction also
checks client state and background-task polling; real model execution blocking
or hallucination is not an established consequence of this issue.

Round-1 verification exercised a real ACP notification turn with seeded older
cron/Goal call records, confirming the cleanup gap for that shape. It also
persisted a notification between an active
shell call and its result: applying the proposed subtype-only boundary to that
real snapshot incorrectly finalized the active call. In a separate real
cross-prompt background-shell scenario, the job was still running but its
launching call already had a persisted result and replayed as completed. These
observations do not establish a universal cross-turn liveness invariant.
