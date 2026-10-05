# Hosted Turn failover E2E and Harness Turn takeover (G1)

[English](2026-09-30-hosted-turn-failover-e2e.md) | [简体中文](2026-09-30-hosted-turn-failover-e2e.zh-CN.md)

Status: proposed. Implements slice G1 of #12952 (part of #12380), after G0
(#12955).

## Problem and scope

`--inflight-failover` and `--continuation-failover` in
`scripts/run-managed-agent-server-e2e.ts` exit immediately with a
`not-yet-enabled` throw whose stated reason is stale. G0 opened public
admission for Workspace-bound file-tool Sessions, but running the modes against
the packaged stack shows the deeper gap: **the Hosted Harness has no Turn
takeover**. The Java coordinator and SDK already carry the full recovery
contract — the `_meta.qwen.daemon.managedRuntimeRecovery` load payload, the
`POST /session/:id/managed-runtime/continue` and `/cancel` routes, per-epoch
output retraction — while the TypeScript Harness refuses a loaded Session with
unsettled input (`hosted_turn_recovery_required`) and implements none of that
contract.

G1 therefore delivers:

1. **Harness-side Turn takeover.** A replacement Harness loads a Session whose
   Turn parked at an `await_runtime` / `results_ready` checkpoint, reconciles
   and settles its Runtime executions without replay, reports the recovery
   snapshot, and continues the Turn on coordinator request.
2. **Durable streamed text.** Assistant text commits to the journal as
   activation-scoped delta events while the model streams, so a published
   prefix survives the writer and a dead owner's prefix is retracted from the
   public projection by the existing epoch machinery.
3. **Admission enabler.** The packaged server gains an explicit opt-in
   (`qwen.managed-agent.trusted-actor-header`, default empty) that stands in
   for the trusted gateway's `AuthenticatedTenantActor`, so the E2E can create
   Workspace-bound Sessions through the public route. Never enable it where
   untrusted clients can reach the server.
4. **Ungated modes and CI.** Both modes lose the stale gate, drive their
   physical tool through `write_file` (the publicly admitted profile), run in
   the Hosted MySQL CI job, and the README describes them as runnable.

Out of scope: public Shell profile selection, the G2 takeover reconciliation
scan, G3 owner-affinity removal, and multi-Runtime takeover. Cancellation
takeover is implemented for contract completeness but has no E2E mode.

## Current state

- The runner already contains the complete in-flight/continuation scenarios
  (held Broker `:start` proxy, fake model, process kills, home deletion,
  audits); they were gated by #12801 without ever passing.
- `ManagedSessionJournalStore` writer fencing, `await_runtime` checkpoints and
  `resolveAwaitRuntime` exist in core; the `--session-failover` durable-owner
  proof passes.
- Java side: `HostedHarnessClient` parses the recovery `_meta`, calls
  continue/cancel, and `HarnessCoordinator` retracts a dead owner's public
  deltas, binds the replacement Harness generation and records recovery
  admissions.
- Missing (TS): recovery snapshot on load, continue/cancel routes, exactly-once
  re-dispatch of parked executions, and mid-Turn durable text deltas.
- Missing (packaged server): any way to supply an actor principal, so public
  Workspace creation returns 401 outside in-JVM tests.

## Decisions

- **Load reports or completes the parked Runtime work; it never replays the
  model Prompt.** On load with unsettled input, a runnable `await_runtime` or
  `results_ready` checkpoint and a Workspace tool profile, the Harness resolves
  every in-progress execution against the Broker by its original
  `executionCallId`. A continuation load re-dispatches each parked execution
  through `execute` — the Broker's durable record makes that exactly-once —
  commits the tool result, and advances the checkpoint to `results_ready`
  before answering. A passive load (the coordinator's cancellation path)
  first adopts the dead owner's Runtime Session — acquiring dispatches
  nothing — then reads execution status and reports `known`/`unknown`. The
  load holds the adoption and never releases it itself: on success the
  terminal cancel route hands the lease back; on failure it stays owed,
  because a release persists RELEASED while a stranded READY identity is
  still usable — a redriven cancel is re-admitted against the current
  checkpoint (the daemon never re-loads an attached Session), and a
  takeover after an owner change re-acquires idempotently. A load refused
  after adopting but before the Session registers records the owed adoption
  and reports it by name, since no registered session exists to retire it;
  the record drains on the next successful load of that Session, and only
  session retirement discharges an abandonment otherwise.
  Executions the Broker cannot account for report `unknown`, the coordinator
  blocks the Turn as `managed_runtime_recovery_blocked`, and nothing replays.
- **Continue runs the model from `results_ready`; cancel settles without new
  work.** `managed-runtime/continue` validates the prompt, checkpoint and
  activation identities, admits the continuation with a 200 receipt, then
  re-issues the model request with the journaled tool results and runs the
  normal tool-capable loop to a terminal record. `managed-runtime/cancel`
  best-effort cancels parked executions and settles the Turn as cancelled.
  Both refuse identity mismatches with 409.
- **Assistant text streams as a new `message.delta` journal event.** The kind
  joins the closed v1 set with `harness` actor and activation subject, so a
  fenced former owner cannot append. Deltas carry the final message's
  pre-assigned `messageId`; `message.committed` records whose deltas already
  project do not project a second chunk, so from-scratch projections stay
  exact. Every model chunk commits immediately — a published prefix must be
  durable while its stream is still open — split only at the journal's text
  limit.
- **Runtime takeover needs the W0e reclaim, so the modes are Linux-only
  today.** The replacement owner must retire the dead worker's Runtime binding
  before it can re-drive the parked execution. That reclaim exists only for
  the durable local-process provisioner, whose trusted host identity is
  Linux-only. The runner enables `durable-local-process` for these modes,
  creates the state directory owner-private, and refuses other platforms with
  an explicit error pointing at the Hosted MySQL CI job. This is the boundary
  #12766 already records; G1 does not change it.
- **The E2E seeds Workspace admission as deployment data** (registry row,
  access grant, Broker mount) and enables `harness.workspace-files-enabled`
  plus the trusted-actor header on both Spring owners. The physical side effect
  is a fixed `write_file`; the exactly-once assertions ride the durable
  execution row, dispatch generation and model-request counts, not file bytes.
  `--session-failover` still creates an unbound Session, but this admission
  wiring is no longer mode-gated: every mode's owners carry it (#13258), so
  its configuration matches the other modes.
- **Both modes join the `hosted-harness-mysql` job**, which installs the MySQL
  server binaries the runner needs for its private `mysqld`.

## Changes and ownership

| Layer        | Change                                                                          | Scope                     |
| ------------ | ------------------------------------------------------------------------------- | ------------------------- |
| Core journal | `message.delta` event kind (schema, harness actor, activation subject)          | Managed Session log       |
| CLI Harness  | Recovery snapshot + settlement on load; continue/cancel routes; delta streaming | Hosted Harness sessions   |
| CLI Broker   | acquire + `status` read + release for passive reports                           | Workspace Broker          |
| Java API     | `TrustedActorHeaderFilter` + property, default off                              | Deployment opt-in         |
| E2E runner   | Ungate; Workspace seeding, mounts and actor wiring; `write_file` side effect    | Local and CI verification |
| CI workflow  | MySQL binaries + both failover modes in `hosted-harness-mysql`                  | Hosted MySQL job          |
| README       | Runnable modes; property risk note                                              | Managed Agent Server docs |

## Validation and acceptance

Unit tests: the delta event schema round-trip; recovery meta shape and refusal
paths; continue/cancel identity and phase gates; the actor filter. The G0
Hosted integration test and the Hosted MySQL suites keep passing.

The E2E exit checks are the issue's own:

- **In-flight:** the first Broker `:start` is held after the durable
  `await_runtime` checkpoint; both process trees die and their homes are
  deleted; the replacement reuses the original `executionCallId`, executes the
  physical tool exactly once, continues the Prompt without replay (one initial
  and one continuation model request), and commits one terminal event.
- **Continuation:** the Harness dies after the first published text chunk; the
  tool executed once and settled beforehand; the replacement issues one further
  continuation; the public transcript shows only the replacement's answer (the
  retracted prefix is blank); the Turn has one terminal event.

Deleting any assertion must fail its mode. `--session-failover` and the
real-model check rerun as regressions. Build, typecheck, bundle, focused tests
and two clean diff audits precede completion.

## Boundaries and open questions

G1 lives under #12952. The issue's slice text assumed the takeover machinery
already existed; this design records that the Harness half is the bulk of the
work. Whether delta streaming should later apply to no-tool Hosted Turns, and
how multi-Runtime recovery composes with the G2 scan, stay open. The
trusted-actor property is a local/E2E stand-in; a real gateway replaces it
without touching admission logic.

Known follow-ups from the maintainer's real-environment verification:

- A takeover load whose reply is lost leaves the Turn stuck: the Harness has
  attached the Session and answers every later load with 409
  `hosted_session_already_attached`, so the recovery snapshot cannot be
  fetched again. The takeover load needs to become idempotent. Note the load
  can legitimately take up to 120 s while the default coordinator
  `request-timeout` is 30 s.
- A journal that contains `message.delta` events cannot be opened by a
  Harness of an older build. The released 0.24.7 refusal shape is a
  fail-closed `POST /session/:id/load` answer: 503 with
  `{"error":"managed_session_open_failed","code":"managed_session_open_failed"}`
  — one step before the journal reader's own surface, and retried by the
  coordinator while the fleet stays mixed. Since #13320 the Java client
  surfaces the refusal code (`HarnessSessionRefusedException`) and the
  coordinator names it in retry logs and in the recorded terminal failure
  once the pre-admission retry budget runs out, so the rolling-deploy
  runbook can tell "journal newer than the reader" apart from a genuinely
  unavailable Harness. Readers of this build are fine; a rollback or a mixed
  fleet during a rolling deploy is not. Upgrade the fleet before enabling
  Hosted Workspace turns, or gate rollback.
- A model fallback or retry that lands after the first streamed chunk fails
  the Turn terminally (`Hosted Harness cannot retract a published model
attempt.`): once `message.delta` records are journaled, the partial attempt
  is public and cannot be withdrawn, so the Turn settles as `error` instead
  of discarding the partial attempt and retrying, which is what the
  pre-streaming behavior did. A transient provider capacity event mid-stream
  therefore fails the Turn permanently rather than being retried by the
  coordinator (a `turn_result` is terminal). Classifying this settlement as
  retryable for the coordinator is a follow-up. (Superseded by #13319's
  in-band retraction: a retry landing after publication replays the request
  fresh, the Harness journals `message.retracted`, and the server empties the
  message's deltas by source-sequence range and publishes
  `stream.reconciled` — see
  [2026-10-04-managed-midstream-retry-retraction](2026-10-04-managed-midstream-retry-retraction.md).)
