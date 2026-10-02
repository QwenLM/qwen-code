# Hosted replaceable Harness — remove owner affinity (G3)

[English](2026-10-02-hosted-replaceable-harness.md) | [简体中文](2026-10-02-hosted-replaceable-harness.zh-CN.md)

Status: proposal, not implemented. Issue tracker: #12952 (Stage G). Code
references are to `main` @ `728c13de21`. This design answers Q2 and Q3 of
#12952 following the proposal in its comments, and corrects one mechanism
description from that proposal (see "Current state", item 1).

## Problem and scope

Stage G externalized the authoritative Session history and proved writer
fencing and takeover. What remains is G3: a Hosted Session must not be pinned
to the Harness process generation that first served it. Today, restarting the
Hosted Harness alone leaves every bound Session failing with a generation
error until the Java control plane also restarts
(`managed-agent-server/README.md:185`). G3 removes that affinity so a live
control plane adopts the next Harness generation and Turns continue.

Scope, settled per the issue:

- **Hosted only.** The ordinary path keeps local storage and owner affinity.
  `session_execution_engine_unavailable` (`acpAgent.ts:1120`) and "a Managed
  failure never replays through Legacy" stay unchanged, guarded by existing
  tests.
- **"Any Harness" means any Harness process generation the same control plane
  can reach, one generation after another (Q3).** The connector holds one
  Harness base URL. Two live owner pairs, graceful handoff and cross-host
  takeover need lease handoff and routing that nothing merged provides; they
  get a separate tracker.
- **"Of the correct engine" means the same capability digest and a Harness
  that can read the journal its predecessor wrote.** A changed digest stays
  terminal.
- **Q2 is a G3 deliverable, not a prerequisite:** a gated proof that a
  _concurrently surviving_ former owner is fenced, as a freeze variant of an
  existing failover scenario (D7).

Out of scope: the public-Shell opt-in (tracked separately from G0's tail),
Step 3's model-round reissue and `await_action` settlement beyond what D5/D6
require (named follow-up slices below), and any multi-instance control-plane
work.

## Current state

Where the affinity lives (all verified at `728c13de21`):

1. **The control plane pins one Harness process generation.**
   `HostedHarnessClient` negotiates once in its constructor and keeps that
   boot ID (`HostedHarnessClient.java:107`). The connector builds the client
   exactly once (`QwenHostedHarnessConnector.java:395-410`); `close()` does
   not null the field and **no code path rebuilds it**. The coordinator treats
   `HostedHarnessGenerationException` as terminal
   (`HarnessCoordinator.java:178-180`), and `bindHarness` refuses a rebind
   once a Turn carries `submission_attempted` or an event epoch
   (`ManagedAgentStore.java:1240-1244`).
   Correction of the issue proposal's wording: generation mismatch is
   detected from the `X-Qwen-Harness-Boot-Id` **response header**
   (`HostedHarnessClient.validateGeneration`, lines 1067-1086) or by a local
   check against a cached session ref (`requireSessionRef`, lines 977-991),
   never by parsing a 409 body. Java parses no error-body code anywhere;
   daemon 409s (`hosted_session_already_attached`,
   `hosted_turn_recovery_required`) arrive as code-blind
   `DaemonHttpException`s and become indefinite post-admission retries
   (`HarnessCoordinator.java:184-193`, whose budget check is bypassed once
   `submissionAttempted` is true, lines 582-590). The connector's `create()`
   even swallows _any_ 409 into a silent load fallback (lines 301-305).
2. **The Session row is bound to a Harness boot ID.** A Turn that was
   submitted or admitted can only move through the recovery CAS
   (`bindRecoveredHarness`, `ManagedAgentStore.java:1270-1281`). No method
   clears `submission_attempted` or a per-turn epoch; only session-lifecycle
   completes clear them (CLOSE/ARCHIVE/DELETE, lines 719-731).
3. **The journal writer lease is exclusive while alive** and its holder renews
   at half-life (`http-managed-session-store.ts:889-902`;
   `ManagedSessionStore.java:197-210`). A successor waits for expiry (60 s
   default, `application.yml` `session-store.writer-lease-duration`) or a
   seal. Store-level fencing is already proven
   (`ManagedSessionStoreIntegrationTest.fencesWritersAndReplaysExactTransactions`).

Items 2 and 3 are the fencing G3 keeps. Item 1 is the affinity G3 removes.

What already works (the G3 machinery mostly exists):

- The coordinator already has a takeover-load branch: a Session row with a
  `harness_boot_id` attaches through `recoverManagedRuntime`, which sends the
  takeover load from #13083 (`HarnessCoordinator.java:231-239`).
- `bindRecoveredHarness` is exactly the compare-and-swap an adoption needs;
  `recordRecoveryAdmission` re-keys the epoch.
- The TS takeover load settles `await_runtime` / `results_ready` parkings and
  refuses the rest (`recoverHostedRuntimeTurn`,
  `hosted-runtime-recovery.ts:218`).
- Event streaming reads the journal by sequence
  (`hosted-harness-session.ts:2240-2245`), so a stored event cursor is valid
  on any generation.
- The three failover E2E modes prove sequential replacement when an operator
  kills both owners deliberately; the 2026-09-30 design records the three
  follow-ups G3 now addresses (lost-reply takeover load, 30 s timeout vs
  120 s load, `message.delta` rollback).

Two distinct events currently share the code
`hosted_harness_generation_mismatch` (the client exception at
`HarnessCoordinator.java:178` and the DB bind refusal at line 325). Only the
first is adoption-eligible; the design names them "wire mismatch" and "bind
refusal" below.

## Decisions

### D1 — Adoption is centralized in the connector, at retry boundaries

On any `HostedHarnessGenerationException`, one synchronized adoption runs
in the connector: **every cached Attachment and every `pendingRecovery`
entry is dropped** — they re-mint on demand, and a stale ref observed
after another thread's rebuild must not retry-loop on itself. When the
exception's actual boot ID differs from the client's, the old client is
also closed and the field cleared; the next call rebuilds (renegotiation
applies the digest gate, D2). The exception is then rethrown so callers
reach their existing retry mechanics. Nothing adopts mid-stream:
`consumeStream` embeds the attach-time boot ID in every recorded event
source key (`HarnessCoordinator.java:398-401`),
so a torn stream dies by exception and the Turn is adopted at its next
dispatch attempt. `HostedHarnessClient` itself is unchanged except a
per-request load timeout (D9b).

### D2 — The digest gate stays terminal

A renegotiated capability digest different from the configured one keeps
throwing `HostedHarnessCapabilityMismatchException`
(code `managed_capability_mismatch`) and the coordinator keeps failing the
Turn terminally. "Replaceable" never crosses an engine boundary.

### D3 — The coordinator stops failing on wire mismatch

The `HostedHarnessGenerationException` catch in `HarnessCoordinator.coordinate()`
becomes `transientFailure` instead of terminal `fail`. The next dispatch
attempt goes through the existing recovery attach: `session.harnessBootId()
!= null` selects `recoverManagedRuntime` (the takeover load) with the rebuilt
client; on success `bindRecoveredHarness(expected = old boot ID)` CASes the
row to the new generation. `bindHarness` refusals and post-admission turns
keep moving through the recovery branch only — the "bind refusal" code path
is unchanged in shape, it simply stops being reached in adoption flows
(D4 removes its trigger).

### D4 — A marked-but-never-admitted Turn withdraws its submission mark

New store primitive `withdrawSubmissionAttempted`, modeled on
`bindRecoveredHarness`'s CAS: owner + live dispatch lease + ACTIVE status +
`submission_attempted = TRUE AND harness_event_epoch IS NULL` → set
`submission_attempted = FALSE`. No new columns, no Flyway migration.

Placement: in `runClaimed`'s fresh branch, when `bindHarness` refuses
because the Session row names an older generation while the Turn has no
epoch (never admitted), the coordinator withdraws the mark and retries the
bind against the attachment the takeover load just produced.

Safety condition, stated precisely (this corrects the proposal's "the 409
proves non-admission" shortcut): withdrawing is safe because **re-submission
is idempotent at the journal**. `submitInput` commits with `commandId =
promptId` (`hosted-harness-session.ts:1481-1491`), so an admission that did
happen at the old generation before its reply was lost replays as the exact
same transaction when the Turn re-submits on the new generation
(`ManagedSessionStoreIntegrationTest.fencesWritersAndReplaysExactTransactions`
covers exact replay). The boot-ID middleware rejecting before any Session
route (`hosted-harness-contract.ts:68-83`) is the common case, not the
invariant; the journal `commandId` is the invariant.

### D5 — "Cannot be taken over" becomes typed and terminal; "retry later" stays retriable

TS: `recoverHostedRuntimeTurn` returns a discriminated result instead of
`undefined` for the deterministic decline states, each a stable function of
the journal — `await_action` (an approval group in `requested` state),
`model_start` (no checkpoint yet, or a checkpoint at another model-start
phase; also the load route's answer for a parked Turn on a no-tool Session),
`turn_settled` (settled in the journal with the terminal event not yet
projected), `shell_in_flight`, `batch_not_durable` (parked before
`await_runtime` without durable args), `checkpoint_blocked` (the checkpoint
no longer parses), `unresolved_after_settle` (the checkpoint names another
Turn, or the state after settling is still not runnable). Thrown errors
stay transient, exactly as today. The load route answers declines with new
409 code `hosted_turn_recovery_declined` plus a `reason` field;
`hosted_turn_recovery_required` is thereafter emitted for transient states
only. `hosted-tool-approval.ts:247`'s uses are transient and unchanged.

Java: code-blindness is kept everywhere except one call site. The
connector's `recoverManagedRuntime` parses the 409 body of its own load
response; on `hosted_turn_recovery_declined` it throws a typed
`HostedHarnessRecoveryDeclinedException` carrying the reason, and the
coordinator fails the Turn as `managed_runtime_recovery_blocked` — the
existing code with one new producer, also the observable pattern #13054
asks for. No global HTTP-code table is introduced.

### D6 — The takeover load is idempotent

TS retains the recovery report on the attached session until a
continue/cancel admission for that prompt consumes it. A repeated load that
(a) names an attached session, (b) sets a takeover flag, and (c) finds the
recovery still pending returns 200 with the stored snapshot instead of 409
`hosted_session_already_attached`. Repeated plain loads keep the 409. This
closes the lost-reply follow-up recorded by the 2026-09-30 design; the
`opening.has(sessionId)` refusal (a takeover currently in flight) is
unchanged and stays retriable.

### D7 — Q2 gate: the freeze variant (test-only unless it finds a defect)

A continuation-scenario arm in `scripts/run-managed-agent-server-e2e.ts`:
SIGSTOP the original Harness (the journal writer) and SIGKILL the original
Spring JVM (`crashProcess`, exactly as the continuation mode kills it), keep
the Harness home, let the leases lapse (the existing SQL waits work
unchanged against a frozen writer), let the replacement finish the Turn,
then SIGCONT the frozen Harness and assert:

- no journal transaction from the _old writer generation_ after the wake
  (counted straight off `qwen_managed_session_journal_tx`; the head's
  revision and sequence keep moving with the replacement's own legal
  writes such as heartbeats, so identity, not revision, is the fence),
- the public transcript still holds only the replacement's answer and one
  terminal event,
- `managed_agent_session.harness_boot_id` is still the replacement's.

Why the Spring must actually die (a refinement discovered by the first CI
run of this arm): reclaiming a workspace binding requires death evidence
from `/proc` liveness via the trusted host identity, and a SIGSTOPped JVM
still reads as alive there — so with a merely-stopped Spring the
replacement's reconcile times out (`runtime_broker_reconcile_timeout`) and
the Turn never completes. Resource-level (Broker/worker) takeover of a
surviving owner is therefore structurally out of reach today, exactly the
"two live owner pairs" this issue excludes; the arm fences at the journal
writer level instead, which is what G3's exit check words. Teardown needs
no special signal ordering (the Harness is already continued). The same PR
also wires `npm run test:e2e:managed-session-failover` into the
`hosted-harness-mysql` CI job, where it was previously absent by omission.

### D8 — E2E: the Harness-only restart arm

One runner switch, stacked on the three scenarios, that kills only the
Harness (`crashChild(harness.child, …)` at the existing crash block, lines
1130-1135), restarts a fresh Harness on the **same port** (free after
SIGKILL; the live Spring's `HARNESS_BASE_URL` was fixed at JVM start), keeps
the original Spring, Broker and `runtimeHome`, deletes `harnessHome` (the
journal is remote; the new process must prove it needs nothing local), and
reuses the existing lease-expiry waits. Post-restart assertions: the idle
Session's next Turn completes and the model boundary sees Turn 1's prompt
and answer; `managed_agent_session.harness_boot_id` moved to the new
generation **without a Spring restart**; the in-flight and continuation
arms keep their current assertions. The before picture is produced by the
same arm on `main`: it must fail with the generation error the README
documents. The README sentence at `:185` is deleted. With Spring and its
Broker alive the worker is not orphaned and no W0e reclaim is needed, so
this arm drops the Linux guard for the workspace-turns scenarios and the
run reports whether darwin passes; the existing kill-both modes keep the
guard.

### D9 — Production defaults made consistent (settled, per the issue)

- **D9a, retry budget vs writer lease.** A Turn whose attach goes through
  the recovery path (`session.harnessBootId() != null`) is exempt from the
  pre-admission retry cap: it is waiting on another generation's lease, a
  wait bounded by the writer lease itself. Recovery-path failures never
  produce `hosted_harness_unavailable`; the Turn stays queued.
- **D9b, request timeout vs takeover load.** `HostedHarnessClient.loadSession`
  uses a dedicated `load-timeout` (default 120 s, env-overridable like the
  other knobs); the general `request-timeout` stays 30 s.
- **D9c, journal-contract marker.** Capability negotiation requires a
  `features` token naming the journal contract (e.g.
  `managed_session_journal_delta_v1`). A Harness too old to read
  `message.delta` journals is refused once at (re)negotiation — on adoption
  this is D2's terminal path — instead of failing every Session open with
  `managed_session_open_failed`.

### D10 — Step 3 stays a named follow-up, minus its cheap row

D4 already delivers the proposal table's first row (submission attempted,
never admitted → re-submitted after withdrawal). The remaining rows — model
round reissue with partial-text retraction (`before_model`; mechanism
already proven by `--continuation-failover`, which retracts a dead owner's
published prefix), `await_action` settle-as-cancelled with Runtime-Session
release (safe per `managed-harness-factory.ts:541-547`; the MCP profile
must be checked first), and `turn_settled` rebind-and-keep-reading — are
follow-up slices on top of D5's typed-decline contract. Shell parkings stay
declined with the typed outcome; real Shell takeover belongs to the Shell
work item. G3's exit check is met by Steps 1+2 (D1-D9); the issue closes
when the model-round slice lands.

## Changes and ownership

| Layer                     | Files                                                                                       | Change                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Java qwencode             | `HostedHarnessClient.java`, `DaemonHttpException.java`                                      | per-request load timeout; error-body code accessor (no global code table)                                                                |
| Java managed-agent-server | `QwenHostedHarnessConnector.java`, new `HostedHarnessRecoveryDeclinedException.java`        | D1 adoption (client rebuild + cache invalidation), D5 single-site 409-code parse in `recoverManagedRuntime` throwing the typed exception |
| Java managed-agent-server | `HarnessCoordinator.java`                                                                   | D3 catch change, D4 withdrawal use, D9a exemption                                                                                        |
| Java managed-agent-server | `ManagedAgentStore.java`                                                                    | `withdrawSubmissionAttempted` CAS (D4)                                                                                                   |
| Java managed-agent-server | `ManagedAgentProperties.java`, `application.yml`                                            | `load-timeout` (D9b), `features` marker config (D9c)                                                                                     |
| TS CLI                    | `hosted-harness-session.ts`                                                                 | decline-code mapping (D5), retained snapshot + idempotent repeat load (D6)                                                               |
| TS CLI                    | `hosted-runtime-recovery.ts`                                                                | discriminated decline result (D5)                                                                                                        |
| TS core                   | `managed-harness-checkpoint.ts`                                                             | nothing; `HARNESS_MODEL_START_PHASES` reused by D5 naming                                                                                |
| Runner + CI               | `scripts/run-managed-agent-server-e2e.ts`, `package.json`, `.github/workflows/sdk-java.yml` | D7 freeze arm, D8 Harness-only arm, `--session-failover` step                                                                            |
| Docs                      | `managed-agent-server/README.md`                                                            | delete the generation-error sentence; document adoption behavior                                                                         |
| Unit tests                | collocated `*.test.*` per file above                                                        | per-decision coverage; see validation                                                                                                    |

Ownership follows the shared-bean structure: `HarnessCoordinator`,
`SessionLifecycleCoordinator`, `ActionResponseCoordinator` and
`ManagedAgentService` all inject the same connector bean, so D1 needs no
per-caller change; each layer's retry mechanics do the rest.

## Validation and acceptance

Unit tests (collocated):

- Connector: adoption rebuilds once under concurrent mismatches; equal-boot
  mismatch drops only the stale entry; digest mismatch stays terminal;
  `recoverManagedRuntime` maps `hosted_turn_recovery_declined` + reason to
  the typed exception and leaves other 409s code-blind.
- Coordinator: wire mismatch schedules a retry, not a fail; recovery-attach
  failures are exempt from the pre-admission cap; decline →
  `managed_runtime_recovery_blocked`.
- Store: `withdrawSubmissionAttempted` succeeds only under its guards
  (owner, live lease, no epoch, mark set); a second withdrawal loses the CAS.
- TS: each of the five decline states returns its reason; a transient
  recovery failure still answers `hosted_turn_recovery_required`; a repeated
  takeover load returns the same snapshot 200 until consumed and 409
  `hosted_session_already_attached` for plain repeats.

E2E (runner arms, all against the packaged stack):

1. Baseline on `main`: the D8 arm fails with the documented generation
   error (README `:185`), proving the test is load-bearing.
2. D8 Harness-only restart × three scenarios: idle next-Turn context,
   in-flight, continuation — existing assertions hold, `harness_boot_id`
   moves without a Spring restart.
3. D7 freeze arm: post-SIGCONT assertions as listed. Deleting any of them
   fails the arm.
4. CI: `hosted-harness-mysql` gains the D7 arm, the D8 arms and
   `--session-failover`, and the job ceiling moves from 60 to 90 minutes
   against the added modes.

The lost-reply race behind D4 (the old generation admits, its 202 reply is
dropped, the Harness restarts, and the Turn must complete with exactly one
journal admission for its `promptId`'s `command_id`) needs a new
submit-reply-dropping proxy between Spring and the Harness that the runner
does not have yet. It is a follow-up test arm, not part of this slice; the
backstop it would exercise is the store-level exact replay already covered
by `ManagedSessionStoreIntegrationTest`.

Acceptance = the #12952 G3 exit check: two successive owner generations
serve one Session with no operator-chosen affinity (D8 arms); a fenced
former owner cannot mutate the newer binding or journal (D7 arm); a Session
with no runnable engine still fails closed and a Managed failure still
causes no Legacy replay (unchanged tests).

## Boundaries and open questions

- Sequential generations only. Two live owner pairs, graceful handoff,
  cross-host takeover → separate tracker (multi-instance control plane).
- The Broker side of a frozen former owner: #12964 tests and Broker fault
  gates, not D7.
- `#13054`: D5's pattern (typed decline → typed terminal turn outcome) is
  the answer its bound-Turn Workspace-refusal case should reuse; this design
  does not itself change Workspace-refusal handling.
- Step 3's model-round slice: the G1 design records that a _same-generation_
  retry after the first streamed chunk stays terminal
  (`cannot retract a published model attempt`); retraction exists only
  cross-generation. The slice must not weaken that.
- `await_action` settlement depends on the MCP profile's approval wiring;
  verify before relying on `managed-harness-factory.ts:541`.
- Harness-only arm on darwin: expected to pass without the W0e reclaim; the
  first green run decides whether the Linux guard drops for this arm only.
- Nits found while mapping (not G3 work): `sdk-java.yml:273-274` stale step
  decomposition `12+10+20` (actual `12+10+10+10`); the runner's Linux-guard
  message says "dead worker" where the reclaim actually retires an orphaned,
  still-alive worker's ownership.
