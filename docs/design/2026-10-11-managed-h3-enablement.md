# Managed Agent H3 Enablement: Runtime Hold, Stop Projection, Gate Lift

[English](2026-10-11-managed-h3-enablement.md) | [简体中文](2026-10-11-managed-h3-enablement.zh-CN.md)

Status: implemented and physically accepted (2026-10-11). Implements #13856. The acceptance pass ran on the H3 rig at `e64ee1fbeb` with the production gate lists and no admission arms: all six behaviours observed, including the previously blocked output-as-Artifact arm (byte-identical readback) and the Monitor watch outliving its turn; the pass needed — and got — the page-closure fix this change carries. Record: `.qwen/e2e-tests/2026-10-11-h3-enablement.md`. Related:
[H3 Shell/Monitor runtime](2026-10-03-managed-shell-monitor-runtime.md)
(the runtime being enabled), #13532 (physical acceptance), #13533 (B1/B2 and
the two design calls), #13789 (A1 fix), #13830 (B1), #13834 (B2 witness),
#13846 (the enablement shape this slice follows), #12872 (Stage F tracker).

## 1. Problem

H3 merged on 2026-10-06 and has delivered no usable capability since:
`MANAGED_SESSION_ENABLED_DOMAINS` carries no `monitor_run` and
`MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` is `['child_agent']` without
`shell`, so no Session can commit either through production configuration
(reproduced at `9763580b84` through the real authority commit path: both
refused "registered but not enabled for submission", the `child_agent`
control commits). Every precondition #13533 named has since cleared, and the
#13532 physical acceptance ran at `c3a6e43554` with no fix patches: five of
six behaviours observed, plus the Monitor arm.

The single blocked behaviour — **2, output as Artifacts** — is a genuine
conflict, not a defect: the H3 design's hold text ("a run holds its Runtime
for as long as it needs it", "Session release with `runtime_session_busy`")
contradicts the landed release sweep, which stops a still-live background run
in the same second its turn settles, so no output resource row ever lands.
#13533 recorded the resolution as the design owner's call, with a second
smaller call beside it (A8: what a platform-driven stop projects).

## 2. Decisions (design owner, 2026-10-11)

1. **Release refuses busy while a run is provably live.** A background run
   outlives its turn, its Runtime Session stays bound, and its output lands
   as an Artifact when it exits. Drain-on-release is rejected: it removes
   the property that distinguishes a background Shell from a foreground one.
2. **A8: a platform-driven stop projects as `cancelled`/`stop_requested`**
   with `stopRequested: true` on the record, so the model and the public
   task view can tell "the platform stopped this run" from "it exited".

Both answers are what the H3 design text already describes; this slice makes
the implementation match it.

## 3. Current state (verified at `9763580b84`)

- **Turn settle releases unconditionally.**
  `HostedWorkspaceToolTurn.finish()` (hosted-workspace-tool-turn.ts:4357)
  calls `broker.release()` at the end of every turn. Any refusal becomes
  `HostedToolRecoveryRequiredError` and parks the whole Session
  recovery-blocked (hosted-harness-session.ts:4702). That park is the
  honesty contract the pinned fault gate asserts: a Session closing over a
  refused release parks its Monitors `runtime_lost` rather than minting
  `stop_requested` for a process nobody stopped
  (hosted-harness-session.test.ts:6715).
- **The broker release sweep drains.** `settleUnprovenBackgroundRows`
  (RuntimeBrokerService.java:1911) runs status → `shell-terminate` → status
  for every live `:process` row, and `releaseSessionAfterSweep` (:2122)
  refuses `runtime_session_busy` only for what the sweep could not prove
  stopped. `shell-terminate` is issued from nowhere else.
- **The worker activation gate drains again.** `transport.release` ends in
  `activateWorkspace(false)`, whose gate stops the Session's background
  Shells and Monitors with a 5 s grace before answering
  (managed-workspace-activation.ts:103, managed-runtime-tool-executor.ts:1870
  `stopBackgroundSession`). A Monitor therefore cannot outlive its turn
  today either, although its tool result text already promises the model
  "it keeps running after this result and holds its Runtime until it
  exits".
- **Monitors hold nowhere the broker can see.** The broker admits a
  `:process` hold row only for `is_background` payloads
  (RuntimeBrokerService.java:787); a Monitor payload carries `is_monitor`
  and gets no row, so neither the sweep nor the busy check ever sees a
  watch. The worker-side `monitor-status`/`monitor-stop` maintenance routes
  exist (managed-monitor-runtime.ts:90) with no broker caller, and no
  Java-side protocol module.
- **A8's projection point.** The child_run record is settled by the
  harness-side publisher at capture finalize
  (hosted-shell-publisher.ts:853): exit evidence maps to `settleExited`
  (`stopReason: 'exited'`, no `stopRequested`), even when the exit is a
  sweep-driven SIGTERM. The record contract admits `stop_requested` only
  with `stopRequested: true` set first (managed-child-run-record.ts:332);
  `HostedChildRunSession.requestStop`/`settleStopRequested` exist with no
  production caller. The Monitor lane already projects `stop_requested`
  through the close path's `loop.stop(stopSettle)`.
- **Exit observation is landed.** B1 (#13830) observes background exits at
  Session re-acquire (scan arm, fire-and-forget), and B2's capture bound
  exists on main (16 MiB pause / 4 MiB resume, per-chunk re-assert,
  #13834's launcher-exit witness).

## 4. Scope

In scope:

1. The Runtime-hold semantics that implement decision 1, for both H3
   families (background Shell, Monitor watch).
2. The A8 projection (decision 2).
3. The gate lift itself: `monitor_run` joins
   `MANAGED_SESSION_ENABLED_DOMAINS`, `shell` joins
   `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS`, with the deliberate test
   flips #13846's practice describes (commit through the real gate; a test
   that needs the gate shut closes it per test).
4. Retirement of the rig's admission switch arms
   (`QWEN_H3_ACCEPT_ADMIT`/`QWEN_H3_ACCEPT_ADMIT_KINDS`): once the gates are
   production, the arms have nothing to admit.
5. A recorded physical acceptance pass on the H3 rig, including the Stage F
   fault round this enablement owes (#12380's exit gate is written "for
   each enabled capability").

Out of scope: the `workflow` kind (#13803); `send_input`, detach and
cross-boot attach (#13265's named follow-ups); the A7 rebuild driver (a
held Runtime pins its workspace mount until close — see Risks); public task
cancel and the children's task-event/output-cursor streams (#13746); the
macOS process-group profile; cross-host double-ownership.

## 5. Design

### D1. Release splits into routine and drain (broker)

`RuntimeBrokerService.releaseSession` gains the distinction the two callers
already name:

- **Routine release** (the public `:release` route's default): the sweep
  becomes observe-only — every non-terminal hold row asks its physical
  owner once, a proven exit settles the row, and anything else keeps it.
  No terminate is ever issued. A row still non-terminal after the
  observation refuses the release with **409 `runtime_session_held`** (new
  code): the hold is the designed state, distinguishable from
  `runtime_session_busy`, which keeps its exact current meaning (an active
  control or a non-background execution the sweep could not account for)
  and its exact current consequence at the harness (the Session parks).
- **Drain release** (the control plane's `drainHarnessSession` path, and
  the public route with `"drain": true` for the Session close below): the
  sweep keeps today's status → terminate → status semantics; what it
  cannot prove stopped still refuses `runtime_session_busy`, and a fully
  proven drain completes the release.

The busy-check ordering is unchanged: active controls and non-background
executions refuse `runtime_session_busy` first; hold rows are counted
separately through the existing exclusion set. The public route's `drain`
field is optional and additive; a caller that could release at all can
already drain today, so the flag grants no new capability.

### D2. A Monitor watch holds at the broker, like a background Shell

The H3 design's "one execution for the life of the watch, holding the
Runtime" lands as a broker-side hold row, the same shape as the shell
family's:

- `admitBackgroundProcess` admits a hold row for `is_monitor` payloads too,
  under a sibling dispatch family (`background_v3_monitor` beside
  `background_v3_process`). The start execution still settles detached;
  the watch row stays non-terminal for the watch's life.
- A new Java `ManagedMonitorProtocol` mirrors `ManagedShellProtocol` (kind
  registry, session validation, recovery marker) so the broker can drive
  the worker's pre-built `monitor-status`/`monitor-stop` routes
  (managed-monitor-protocol.ts already defines them worker-side).
- The observe-only sweep asks `monitor-status`; the drain sweep issues
  `monitor-stop`. The re-acquire scan (#13830) observes monitor rows the
  same way, so a watch that ended while its Harness was gone settles from
  evidence at the next acquire.
- With both families holding at the broker, a routine release refuses
  before `transport.release` runs, so the worker activation gate's
  stop-on-deactivate is reached only from drain releases (where stopping
  is the point) and from releases with nothing live (where it is a no-op).
  The gate itself and the transport interface are unchanged.

A watch that ends on its own — its process exits — settles its row at the
next observation and its monitor_run record through the existing publisher
finalize; the hold ends and the next routine release succeeds. The two
Harness-side bounds (`idle_timeout_ms`, `max_events`) stop the worker's
watch through the client control route's `monitor-stop` and settle the
record only on the worker's exit evidence, which also settles the hold row;
a stop the worker cannot prove parks the record until the watch's own end
or the Session close's drain settles it (§6, #13896).

### D3. Turn settle treats `runtime_session_held` as the designed hold

`finish()` keeps calling release unconditionally — the refusal path stays
load-bearing for honesty — and classifies the answer:

- 409 `runtime_session_held`: the turn settles normally. The held Runtime
  Session is recorded on the Session (the `runtimeLeaseHeld` mechanism
  gains a set shape, one entry per holding turn's Runtime Session) so the
  close path owes it. The Session is **not** blocked: nothing is lost, the
  Runtime is verifiably alive and holding, and blocking would park a
  healthy Session.
- 409 `runtime_session_busy`, or any other failure: unchanged —
  `HostedToolRecoveryRequiredError`, the Session blocks, and a later close
  parks Monitors `runtime_lost`. The pinned fault gate
  ("parks a Monitor on runtime_lost when the Session closes over a refused
  release", which stubs a `runtime_session_busy` refusal) is untouched and
  stays green.

A held turn's Runtime Session is re-acquired by name on a later turn or
released by the close below; the broker-side row holds independently of
either, so a Harness restart loses nothing (the scan observes on the next
acquire).

### D4. Session close drains held Runtimes, bounded

The close handler gains the step the H3 close sequence names, ahead of the
publisher close so the drain's finalize RPCs still land:

1. After the monitor loops are stopped, every held Runtime Session is
   drain-released through the public route (`"drain": true`). The sweep
   terminates the Session's live background Shells and Monitor watches
   (platform-driven stops), the worker's finalizes flow through the still
   open publisher, and the broker rows settle from exit evidence.
2. The close waits, within a bounded window, for every background capture
   the publisher tracks to reach its terminal write. A drain that cannot
   prove its stops inside the window fails the close honestly (503, the
   Session stays reopenable, the holds persist) — close never leaves a
   live process behind it and never mints a settlement it cannot prove.
3. Only then do the publisher close, the pending-input settlements and
   `session.managed.close(...)` run, in today's order.

`releaseLeaseNow` (the recovery-adopted lease handback at close) releases
with drain semantics for the same reason; the cancellation path's
fire-and-forget handback keeps routine semantics (a cancel route must not
stop a live run; the hold stays owed until close).

### D5. A8: platform-driven stops project `cancelled`/`stop_requested`

The marker originates where the stop is physically requested and rides the
existing finalize evidence:

- The worker registries mark a run they were asked to stop
  (`terminate`/`stopSession`/`stopAll` on the background Shell registry;
  the monitor equivalents) and the capture finalize's process evidence
  gains an optional `stopRequested: true` when the exit followed the
  request. A natural exit carries no marker.
- The harness publisher's `finalizeBackground` settles a marked run with
  `requestStop` + `settleStopRequested` (record: `stopRequested: true`,
  `stopReason: 'stop_requested'`, state `cancelled`), satisfying the
  record contract's rule that `stop_requested` requires the flag
  (managed-child-run-record.ts:332). An unmarked exit settles
  `settleExited` exactly as today. The Monitor lane mirrors this through
  its own settle path; a watch whose stop came from the Session close's
  `loop.stop(stopSettle)` already projects the same way.
- The publication contract's closed payload shapes
  (managed-tool-publication.ts / ToolPublicationContract.java and the
  shared fixtures) admit the optional `stopRequested` evidence field, in
  both languages, in this change.

### D6. The gate lift

- `MANAGED_SESSION_ENABLED_DOMAINS` gains `monitor_run`;
  `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` gains `shell` beside
  `child_agent`. The Java store needs no enablement list (it validates the
  bodies ahead of any writer since H1); the server-first order already
  holds.
- Test flips, deliberately: the pins of the disabled state
  (managed-child-run-record.test.ts's per-kind gate test,
  managed-extension-record.test.ts's `monitor_run` pin) flip to assert the
  enabled state; the authority suites that lifted the gates with
  `vi.mock` (managed-session-authority.extension.test.ts,
  managed-session-authority.child-run.test.ts) drop the lift and commit
  through the real gate; suites that exercise a closed gate close it per
  test. The tool-turn admission tests' deliberate-refusal arms
  (hosted-workspace-tool-turn.test.ts) become admission arms.
- Declared-tool lists are re-checked, not assumed: the production
  `HOSTED_WORKSPACE_SHELL_TOOLS` and the integration driver already declare
  `monitor`; the Java Harness IT's model mock lists a files-lane set that
  stays as it is unless the IT switches lanes. The `run_shell_command`
  declaration text that says "Background jobs are unavailable." is updated
  to describe the enabled capability.
- The rig's admission switch arms retire: the rig's `rig-up.sh` drops the
  `QWEN_H3_ACCEPT_ADMIT`/`QWEN_H3_ACCEPT_ADMIT_KINDS` exports and the
  bundle is rebuilt unpatched, so the acceptance runs against production
  lists.

### D7. Physical acceptance, re-run

The rig pass (`/root/h3-accept-rig`, `final-pass.sh` +
`swap-and-verify.sh`) is updated for the new semantics and re-run against
the merged build with no admission arms:

- **B1/B3** (owner identity, hold across a Broker restart): unchanged,
  plus the `0.25 s` live-window poll.
- **B2, the previously blocked arm**: a producer that outlives its turn
  (`printf` part 1, `sleep`, `printf` part 2, exit) — the turn settles with
  the run live and the Session **not** recovery-blocked; after the exit,
  the output reads back byte-identical with its manifest digest through
  the Session-store resource GET.
- **B4, split**: a bare `release` on a live run now answers 409
  `runtime_session_held` and stops nothing; a drain `release` answers 200,
  the run settles `cancelled`/`stop_requested` with `stopRequested: true`
  and the signal evidence (A8), and the cgroup unit empties.
- **B5** (worker SIGKILL → accurate 409 `runtime_admission_closed`,
  no silent re-mint): unchanged.
- **Monitor arm, extended**: the watch now provably outlives its starting
  turn — `observationSequence`/`notifiedThrough` advance after that turn
  has settled, a notification wakes a later turn, and the Session close
  settles the record `stop_requested` with its output manifest persisted.
- **A8 assertion**: every platform-driven stop in the pass carries
  `stopRequested: true`; every natural exit does not.

### D8. Stage F fault round for the two capabilities

#12380's Stage F exit gate is owed for each capability this slice enables.
For a background Shell run and for a Monitor watch, the round covers:

| Fault           | Gate                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| ACK-loss        | a dropped finalize answer is redriven and lands exactly once (the publisher's bounded redrive), never settling twice                           |
| observation gap | a Broker restart mid-run loses nothing: the re-acquire scan observes the exit from evidence (B1's arm), and no acquire waits on an observation |
| process crash   | worker SIGKILL mid-run: the hold persists, re-acquire attaches the original identity or blocks accurately (B5's arm)                           |
| cancellation    | a drain release stops the run and projects `stop_requested`; a routine release refuses held and stops nothing                                  |
| output delivery | a publisher endpoint refusal at finalize leaves the record honestly non-terminal and the redrive bounded, never a silent drop                  |
| storage failure | a store fault during settle is retried or the record stays provably unsettled; no committed revision claims bytes that were not stored         |

The broker-level arms land as runtime-broker fault-gate tests (the
`fault-gates` Maven profile's existing rig); the harness-level arms as
hosted fault-gate tests beside the existing Monitor park gate; the
physical arms run in the D7 pass. Each gate fails if the hold or the
projection is removed (mutation-checked).

## 6. Constraints and risks

- **A7 becomes the steady state.** A live background run pins its Runtime,
  and the Runtime pins the workspace mount: a later Session's turn that
  needs the mount waits, and can recovery-block on
  `runtime_provision_failed`. That is the designed hold's cost, recorded
  in #13533 as A7; the re-release/rebuild driver remains declared future
  work. This slice must not make the pin invisible: the held state is
  recorded on the Session and visible in its status.
- **Mixed-version tolerance.** An old Harness against a new broker reads a
  `runtime_session_held` refusal as an unknown failure and parks
  (degraded, honest); a new Harness against an old broker sees the old
  drain and behaves as today. Neither fabricates a settlement.
- **The honesty contract is load-bearing.** The `runtime_session_busy`
  path — refusal, park, `runtime_lost` at close — is pinned by a fault
  gate and is untouched by D1/D3; the new `runtime_session_held` code
  exists so the designed hold never rides that path.
- **A Monitor auto-stop settles only on the worker's exit evidence.** The
  quota and idle windows run in the Harness while the watch runs in the
  worker. Since #13896 the client control route admits `monitor-status` /
  `monitor-stop` for the Session's own watches, and an auto-stop settles
  `max_events` or `idle_timeout` only when the worker answers `exited`,
  which also settles the watch's hold row. A stop the worker cannot prove
  parks the record on the `runtime_lost` line until the watch's own end or
  the Session close's drain settles it. See
  [Monitor auto-stop evidence](2026-10-11-managed-monitor-auto-stop-evidence.md).
- **#13846 is in flight** and edits `managed-session-records.ts`; whoever
  merges second renumbers around the other.

## 7. Validation

- Unit: `packages/core` managed-runtime suites (record contract's
  `stopRequested` rule, projection partition, gate flips),
  `packages/cli` serve suites (turn-settle hold classification, close
  drain ordering, publisher A8 projection, worker registry marker),
  `packages/sdk-java` runtime-broker (routine/drain release, monitor hold
  row, sweep families) and managed-agent-server (publication contract
  shapes), with the shared payload fixtures driving both languages.
- Fault gates: the D8 table's CI arms, plus the existing pinned gates
  unchanged.
- Physical: the D7 rig pass on the packaged chain, recorded in this
  document and `.qwen/e2e-tests/2026-10-11-h3-enablement.md`.
- `npm run build && npm run typecheck`, package-level test runs for every
  touched package, and the pre-commit multi-pass audit.

## 8. Acceptance criteria

1. Production config commits `monitor_run` records and `child_run`/`shell`
   records; the `child_agent` control is unaffected.
2. A background Shell outlives its turn on the physical pass; its output
   reads back as an Artifact after exit (behaviour 2, previously blocked).
3. A routine release over a live run answers 409 `runtime_session_held`
   and stops nothing; the turn settles and the Session is not blocked.
4. A drain release stops the run, and the record settles `cancelled` with
   `stopReason: 'stop_requested'` and `stopRequested: true`; a natural
   exit settles `exited` with no marker.
5. A Monitor watch outlives its starting turn, notifies across turns, and
   projects `stop_requested` at Session close.
6. The Stage F table's gates are green for both capabilities.
7. The rig runs with no admission arms; the pass is recorded.
8. The pinned honesty gates (Monitor `runtime_lost` park among them) pass
   unchanged.

## 9. Open questions

1. The close drain window's exact bound (the registries' existing 5 s
   per-family grace plus the sweep's round trips is the starting point;
   the implementation pins the number and its witness).
2. Whether a long-held Runtime should surface in the Session's public
   status beyond the current fields (the hold is visible through the task
   surface today; a dedicated field is a product call, not required here).
3. The A7 rebuild driver's scheduling stays with the W-series mount work.
4. Resolved by #13896: a Monitor auto-stop gets its own remote exit
   evidence through the client control route; see
   [Monitor auto-stop evidence](2026-10-11-managed-monitor-auto-stop-evidence.md).
