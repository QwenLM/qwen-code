# Replay projection watermark

[English](replay-projection-watermark.md) | [简体中文](replay-projection-watermark.zh-CN.md)

## Problem and scope

A full load reads the events retained by a session's event bus. It cannot undo
summary projection applied before those events entered the bus. A filtered event
does not consume an event ID, so two snapshots can have the same cursor and
different source histories. Reassigning IDs while seeding cached replay also
hides the original projection boundary. Publication rejected by serialization
or retention preparation currently does not mark the snapshot degraded.

This change adds source-projection observation metadata. It does not implement
history stitching, promise complete replay, change event IDs, add a route or
feature flag, or change the full/summary projections themselves.

## Contract

`replayProjectionWatermark` is an optional, nonnegative event-ID boundary W in
the response's `eventEpoch`. For a full in-memory replay snapshot it is captured
synchronously with the replay arrays and `lastEventId` C. Missing means the
response does not provide this observation; consumers must not substitute zero.
Zero means the boundary precedes the first published event, not that summary
mode has never been used.

| Operation                                        | Boundary update                                            |
| ------------------------------------------------ | ---------------------------------------------------------- |
| Successful publication in summary mode with ID N | W = max(W, N), even if this particular event was unchanged |
| Summary filtering without an assigned ID         | W = max(W, nextId - 1)                                     |
| Replay seed                                      | W advances through the last newly assigned ID of the batch |
| Switch to full or reset retained replay          | Retain W                                                   |
| New bus epoch                                    | Start at zero; any seeded events advance the new boundary  |

Every seed is conservatively treated as unverified. This includes full persisted
history because the generic bus has no source proof. Thus old seeded user groups
cannot qualify as unprojected solely because they received new IDs; a subsequent
full user group can. Empty seeds do not change the boundary.

A consumer can require a complete user group's first native event ID to be
strictly greater than W before considering that suffix. This only excludes
publish-time summary projection and unverified seeds in the suffix. Consumers
must still validate full user groups, persisted-history boundaries, epoch,
partial/degraded flags, truncation and content-degradation markers. Available
command snapshots and normal tool/text compaction retain their existing
semantics; this field does not certify raw event fidelity.

Serialization or retention-preparation rejection sets the existing sticky
`replayDegraded` state without consuming an ID or throwing. Its existing
diagnostic callback remains best effort and is invoked once for the first
degradation. A closed bus remains a normal no-op.

## Propagation and compatibility

The bus emits W only for full snapshots. Native load forwards that captured
value with the matching arrays and epoch. A summary read omits it; switching a
read back to full does not erase prior source projection. Successful bounded
persisted-page refreshes also omit it because their events are not the bus
snapshot with native IDs. Refresh stability checks compare W as well as epoch
and cursor, so filtering that advances W during the asynchronous read causes
retry or fallback. W is not an activity counter: another filtered event when
W already equals C does not change either boundary.
Resume without replay arrays does not provide this snapshot observation.

The TypeScript REST type and `DaemonSessionClient` retain the optional load
metadata, including zero. Existing callers, Web Shell rendering, SSE ownership,
permission handling and cursor behavior remain unchanged. REST routes and
standalone restoration already forward the bridge result; the Java SDK retains
raw JSON rather than a dedicated replay field model.

## Implementation boundaries

- `packages/acp-bridge/src/eventBus.ts`: boundary, atomic snapshot and degradation.
- `packages/acp-bridge/src/session-control-plane.ts` and `bridgeTypes.ts`: load
  propagation, summary omission and refresh stability.
- TypeScript daemon response types and session client: preserve the observation.
- Collocated bus, bridge and SDK tests, plus this bilingual design.

No application-specific adapter or private downstream repository is changed.
The field describes the snapshot at C; it does not promise that future writers
will continue publishing in full mode.

## Validation and acceptance

Before implementation, a deterministic test script using the real event bus
and compactor showed identical clean and filtered snapshots, undetected
serialization rejection, and unmarked reseeded projection. The installed CLI
and source-script baseline are recorded separately in the local E2E plan.

Tests cover zero/missing metadata, successful summary publication, filtering
without cursor advancement, the next full user boundary, full/reset persistence,
same-epoch and new-epoch seeds, serialization/retention rejection, full and
summary load, and a refresh where only W changes. SDK tests preserve zero and
absence across workspace and standalone load factories. Root build, typecheck
and bundle, focused package tests and the independent deterministic verification
must pass. No real-model or downstream application acceptance is claimed.

## Status and open questions

Implementation candidate. The conservative treatment of every seed is intentional;
there is no trusted-seed bypass in this change. Any future stronger completeness
contract requires its own source proof and review.
