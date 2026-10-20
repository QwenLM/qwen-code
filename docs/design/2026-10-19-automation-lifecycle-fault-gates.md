# FG11d: retire, disable, close and the cancellation matrix

[English](2026-10-19-automation-lifecycle-fault-gates.md) | [简体中文](2026-10-19-automation-lifecycle-fault-gates.zh-CN.md)

Status: `disable-span`, the per-run cancel cell and `retire-at-intent` are
implemented and green; `close-queued-input` and the rest of the cancellation
matrix are scoped but not implemented.

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
`fire_run` in the relay is the intent hold this slice needed, because the
occurrence is committed and the run has not reached the Harness. `close-*`
still needs a Session close the fixture cannot accept, which Limits records
instead of claiming it is ready.

## Slice 1: retire, disable, close

| Cell                 | Setup                                                                                  | Expected                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retire-at-intent`   | Retire while the claim sits at the Harness as `intent` (the relay parks the operation) | The occurrence settles `skipped` for `definition_retired` with no attempt; no run commits and no model Turn starts, and the claim is never `unknown`.                                      |
| `disable-span`       | Create the definition disabled, let two due slots pass, then enable it                 | The disabled span records no `fired` occurrence and no run; the first slot after re-enabling fires once.                                                                                   |
| `close-queued-input` | Close the Session while an automation input is queued behind a held turn               | The queued input settles without a model Turn; a live definition on the closed Session records `skipped(session_not_active)` for each slot, which is today's behaviour and is pinned here. |

## Slice 2: the cancellation matrix

Per-run public `TASK_CANCEL` must stop only the target occurrence. The matrix
asserts:

- the cancelled run reaches `cancelled` from its committed proof, and its
  occurrence settles once;
- the schedule, future slots, sibling runs and foreground work are untouched;
- a queued input cancelled before any attempt settles with no model call, and
  a run that completes naturally keeps its outcome;
- a retry under the same key reuses the original operation and run, and a
  parked cancel is never redelivered.

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
- `retire-at-intent` pins what the code does, not what this record first
  proposed. Parking `fire_run` at the relay leaves the occurrence committed and
  unstarted, and retiring there settles it `skipped` with `definition_retired`
  and zero attempts. No `automation_run` commits, so `cancelled` — the state a
  cancel gives a run that exists — never arises, and `not_started_proven` stays
  a property of the Harness's own execution line, which this lane could only
  read through a run it does not create. The cell asserts the skip, the spent
  attempt count, the absent run and the absent Turn.
- `close-*` needs a workspace-backed Session: the automation API refuses a
  Session without one (`session_not_found`), while closing a workspace
  Session in this fixture answers `409 workspace_unavailable` with
  `Hosted Workspace execution is not available.` The public close route takes
  `SessionLifecycleService.admit`'s workspace arm into
  `ManagedAgentStore.beginWorkspaceLifecycle`, and `beginLifecycle` throws
  there. The message is shared by ten raise sites in five classes, so name the
  route rather than a class: it is not the store-level authority FG11f faults.
  That slice records two refusals — the non-durable broker's 409 from
  `resolveScope`, and, under the durable broker, `WorkspaceExecutionStore`'s
  `Workspace execution authority is unavailable.` — so neither is this
  lifecycle throw.
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
