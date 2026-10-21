# FG11d: retire, disable, close and the cancellation matrix

[English](2026-10-19-automation-lifecycle-fault-gates.md) | [简体中文](2026-10-19-automation-lifecycle-fault-gates.zh-CN.md)

Status: `disable-span`, the per-run cancel cell, `retire-at-intent`, the
closed-Session skip cell and the close-in-flight refusal are implemented and
green; the rest of the cancellation matrix is scoped but not implemented.

Issue: #14446, the FG11 tracker. The `d` row records per-run task
cancellation as implemented by #14526, and states that retire, disable,
close and the round-level cancellation matrix are not discharged by that
merge.

## Why

FG11a already pins lost replies for `retire_schedule` — including the dropped
retire answer and the no-slot-after-retire property — and FG11b pins store
faults around the ledger. This round does not repeat that cell; it covers the
lifecycle questions neither slice answers:

- What happens to a claim that has reached the Harness as `intent` when its
  definition is retired?
- Does a retired or disabled definition ever fire again, including the slot
  that was already due?
- What happens to an automation input that is queued when its Session closes?
- Does a cancel stop only its occurrence, leaving the schedule, future slots,
  siblings and foreground work intact?

`AutomationScannerTest` covers `session_not_active` and `count_limit` on H2,
and `WorkspaceSessionCloseMySqlIT` covers close for Workspace Sessions, but no
packaged lane runs these questions on the real schema with the real scanner.

## Fixture

Both slices live in `HostedAutomationFaultGatesIT`, which already provides the
packaged stack: in-JVM Spring with the scanner on, a real Harness behind
`HostedLifecycleRelay`, real MySQL and a model stub. The relays carry the
faults: `held(...)` parks an operation before the Harness sees it,
`relayed(...)` drops one answer, and the scanner's own scheduler is held while
a case arms.

`disable-span` and `retire-at-intent` run on that stock fixture: parking
`fire_run` in the relay holds the fire between the occurrence commit and the
Harness admission, which is the window this cell needs. `close-*` runs on that
same fixture once the case arms its Workspace lifecycle, which Limits records.

## Slice 1: retire, disable, close

| Cell                 | Setup                                                                                                                     | Expected                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retire-at-intent`   | Retire after the occurrence commits but before the Harness admits `fire_run` (the relay parks the operation)              | The occurrence settles `skipped` for `definition_retired` with no attempt; no run commits and no model Turn starts, and the claim is never `unknown`.                                                                        |
| `disable-span`       | Create the definition disabled, let two due slots pass, then enable it                                                    | The disabled span records no `fired` occurrence and no run; the first slot after re-enabling fires once.                                                                                                                     |
| `close-queued-input` | Close a Session that carries a live definition, with the Workspace lifecycle armed (durable broker, 0700 state directory) | The close completes and the next slot records `skipped` for `session_not_active` with no model Turn. A close attempted while a turn is in flight is refused with `409 turn_active`, so no close ever reaches a queued input. |

## Slice 2: the cancellation matrix

Per-run public `TASK_CANCEL` must stop only the target occurrence. The matrix
asserts:

- the cancelled run reaches `cancelled` from its committed proof, and its
  occurrence settles once;
- the schedule, future slots, sibling runs and foreground work are untouched;
- a queued input cancelled before any attempt settles with no model call; that
  a run which completes on its own keeps its outcome — delivered: a cancel
  arriving after settlement is refused with `409 task_action_unavailable`
  (`The task does not accept a cancellation now.`), and the run stays
  `completed` with its occurrence `fired`;
- a cancel retried under the same key reuses its committed operation and changes
  nothing — delivered: the second request answers the cancelled task, the run
  stays `cancelled` and the occurrence settles once;
- a retry under the same key reuses the original operation and run — delivered:
  the second `POST /runs` answers the run it already made, records no second
  occurrence and starts no second Turn. That a parked cancel is never
  redelivered stays open.

- `cancel-stops-only-the-target` is delivered. With the wake turn parked on the
  model, the public task cancel settles the task and the run `cancelled` in
  under a second and the schedule stays `live`; releasing the model immediately
  after the `202` instead lets the turn finish first, which is the ordering the
  cell avoids.

#14526 implemented the per-run cancel; slice 2 pins the round-level matrix
around it.

## Limits

- These cells do not exercise Workspace tools or publication; FG11f owns
  those, and is blocked on the execution-authority gap recorded in its
  design.
- `retire-at-intent` is retirement before Harness admission, not a committed
  intent. The relay parks `fire_run` before the Harness sees it, so the
  occurrence exists and no `automation_run` does: retiring there settles the
  occurrence `skipped` with `definition_retired` and zero attempts, and there is
  no run to cancel. A claim already held at `intent` is a different branch —
  `HostedAutomationSession.fire()` cancels it once the definition retired under
  it, and the CLI-side case "ends a claim its definition retired under as
  cancelled, never started" pins that path to `cancelled` with
  `not_started_proven`. This lane does not exercise that branch, so the gap
  stays open here rather than being read as closed by this cell.
- `close-*` needs the Workspace lifecycle, not merely a workspace-backed
  Session. Closing admits through `SessionLifecycleService.admit`, and the
  action store refuses a bound Session whose execution registry facts are
  missing: `ManagedActionStore` answers `409 workspace_unavailable` with
  `Hosted Workspace execution is not available.`, which is neither
  `WorkspaceExecutionStore`'s authority refusal nor `HarnessCoordinator`'s
  workspace-files outage. Four armings make that check pass —
  `durable-local-process`, an owner-private 0700 broker state directory,
  `verified-workspace-recovery-enabled`, and the storage guard's registration,
  which the third makes effective where the guard is not enabled by itself.
  With those the close completes and the next slot records `skipped` for
  `session_not_active`. A close attempted while a turn is in flight is refused
  with `409 turn_active`, which is what bounds the queued-input arm: the queue
  is decided by the turn, never by a close.
- A task cancel needs the projection's task id, not the run record id:
  passing `arun_…` answers `task_not_found`, and the id from
  `GET /v1/agents/sessions/{id}/tasks` is accepted. With the wake turn kept
  parked on the model, the cancel wins: the task and the run both settle
  `cancelled` in under a second, and releasing the model afterwards does not
  revive them. Releasing the model immediately after the `202` instead lets the
  turn finish first, and the run settles `completed`. The parked model is
  therefore the hold point this cell needs; the release ordering, not the
  fixture, decides the outcome.
- Lease takeover during a cancel is out of scope, as in FG11c.
- The stream-gap gate (`FG11e`) is untouched.

## Acceptance

- Each slice green on JDK 21 with a real MySQL 8, selected with
  `-Phosted-automation-gates`.
- Every cell red at the site it names when its guard is removed.
- Budgets in `scripts/tests/hosted-process-ci.test.js` recomposed if the
  class's runtime moves; no new class is added.
- Delivered in both languages with matching structure.
