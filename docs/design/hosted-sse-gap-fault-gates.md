# Hosted SSE gap fault gates (FG6e)

[English](hosted-sse-gap-fault-gates.md) | [简体中文](hosted-sse-gap-fault-gates.zh-CN.md)

## Problem and scope

Issue #12872 requires public and WebShell event streams to survive a disconnect
during a Hosted tool turn. D3 already implements durable replay; FG6e adds a
real-process gate with a packaged Harness, Workspace Edit worker and
MySQL/MariaDB. Disconnecting an observer must not cancel the tool or replay the
Prompt. Rejoining observers must receive each persisted event exactly once.

The public GET stream resumes with `Last-Event-ID`, which takes precedence over
`after`. The WebShell POST stream uses its existing `afterSequence` body field.
Both cursors refer to the last received SSE `id`; their event projections differ.
No protocol or production behavior change is proposed.

## Test boundary

Public Workspace Turn admission remains unavailable. Reuse the existing private
Hosted Workspace fixture rather than enable it for this test. A test-only Java
relay reads the real private stream through `HostedHarnessClient`, applies the
production `HarnessEventProjector`, and commits those projections through
`appendPublicEventIfAbsent`, preserving the original Prompt and source identity.
The regular SQL sequence allocation, identity derivation, after-commit event hub,
public/WebShell controllers and SSE services remain in the exercised path.

The relay does not invent tool or terminal events. It does not prove public Turn
admission, coordinator batching, or public Turn status transitions. Those remain
outside this slice. A fixture-local trusted principal supplies the saved
Workspace reader identity; the production authorization checks still run.

## Scenario

1. Open both event streams and start one real private Hosted Edit.
2. After backup preparation, create `proof.txt.read-gate` before forwarding start.
   The worker imports `hosted-file-read-gate.mjs`; its native Edit read writes
   `proof.txt.read-entered` and waits before calling the original reader. Require
   that marker and the regular file still containing `x`. Capture the received
   prefixes and disconnect both observers while the private Turn is active and
   no effect has completed.
3. Remove the read gate. With both observers disconnected, require one `x` to `xx`
   effect and a successful original execution and private Turn. The relay commits
   the real final assistant message, then holds the real terminal event before
   committing its projection. The private stream projects committed messages,
   not individual provider deltas or tool journal records.
4. Reconnect each observer from its own last received id. Give the public request
   a conflicting `after=0` to pin header precedence. Wait until both catch up to
   the durable watermark, then commit the held terminal on those same connections.
5. Compare each original prefix plus resumed suffix with the complete durable
   sequence and its JSON projection. Require consecutive ids, exact payloads,
   one successful terminal, expected text and private tool records, the original execution
   identity, one dispatch/effect, no cancellation and released storage ownership.

All waits and HTTP calls are bounded. On failure the driver closes its streams
and listeners; the parent fixture owns worker teardown. Cleanup must terminate
and reap only fixture-owned workers without releasing an uncertain Edit merely
to unblock it. Assertion-failure cleanup coverage remains a #13124 follow-up.
Keep the existing normal and FG6a–FG6d gates intact.

## Implementation and validation

Extend `HostedWorkspaceToolTurnIT` with a dedicated SSE driver and test-only Java
relay/probe. The existing Hosted MySQL CI selection includes the additional test.
Keep the fake model deterministic; no real credentials or model are needed.

Attempt the global CLI baseline first, recording any inability to enter its
private Hosted profile. Validate the packaged local artifact against real SQL,
then run build, typecheck, focused tests and Checkstyle. Independently inspect
SQL identities, sequence and terminal counts rather than trust the driver alone.

Remove covered replay guards one at a time while keeping the gate unchanged:
ignore either resume cursor, corrupt either stream’s replayed SSE id, or replace
the SQL cursor’s strict `>` boundary with `>=`. Each
mutation must fail a behavioral assertion; infrastructure failures do not count.
Restore source and runtime artifacts before final verification. Read the entire
diff in open-ended and reverse audits until two consecutive rounds are clean;
after round five accept only Critical fixes.

Browser UI reconnection, replay pagination, retention/resync, slow-consumer overflow, process crash
recovery, automatic continuation, Shell/provider controls and native Windows
execution validation are outside this slice. The read barrier uses regular files;
the current process fixture still relies on POSIX process cleanup. D3's existing
tests continue to cover its broader replay contracts. No unresolved design question remains.
