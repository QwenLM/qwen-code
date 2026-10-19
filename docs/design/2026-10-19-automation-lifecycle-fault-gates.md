# FG11d: retire, disable, close and the cancellation matrix

[English](2026-10-19-automation-lifecycle-fault-gates.md) | [简体中文](2026-10-19-automation-lifecycle-fault-gates.zh-CN.md)

Status: slice 1 is partially delivered. `disable-span` is implemented and
green; the other two cells and slice 2 are scoped but not implemented.

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

Only `disable-span` runs on that stock fixture. `retire-at-intent` needs a hold
between the run commit and the wake turn, and `close-*` needs a Session close
the fixture can currently accept; Limits records both instead of claiming they
are ready.

## Slice 1: retire, disable, close

| Cell                 | Setup                                                                                  | Expected                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retire-at-intent`   | Retire while the claim sits at the Harness as `intent` (the relay parks the operation) | The claim settles `cancelled` with `not_started_proven`; the occurrence is not `unknown`.                                                                                                  |
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

#14526 implemented the per-run cancel; slice 2 pins the round-level matrix
around it.

## Limits

- These cells do not exercise Workspace tools or publication; FG11f owns
  those, and is blocked on the execution-authority gap recorded in its
  design.
- `retire-at-intent` needs a claim to exist. With the relay holding
  `fire_run` before the Harness, Spring never commits an `automation_run`, so
  the first construction observed an empty run list and nothing to settle
  `cancelled`. Staging it needs a hold between the run commit and the wake
  turn, which this fixture does not expose yet.
- `close-*` needs a workspace-backed Session: the automation API refuses a
  Session without one (`session_not_found`), while closing a workspace
  Session in this fixture answers `workspace_unavailable` from the managed
  Session's workspace-execution check, not from the store-level authority
  FG11f hits.
- A task cancel needs the projection's task id, not the run record id:
  passing `arun_…` answers `task_not_found`, and the id from
  `GET /v1/agents/sessions/{id}/tasks` is accepted. With the wake turn parked
  on the model, that cancel then left the run unsettled for 120 s while the
  Harness connection closed with socket EOF; staging the cell needs a
  different hold point.
- Lease takeover during a cancel is out of scope, as in FG11c.
- The stream-gap gate (`FG11e`) is untouched.

## Acceptance

- Each slice green on JDK 21 with a real MySQL 8, selected with
  `-Phosted-automation-gates`.
- Every cell red at the site it names when its guard is removed.
- Budgets in `scripts/tests/hosted-process-ci.test.js` recomposed if the
  class's runtime moves; no new class is added.
- Delivered in both languages with matching structure.
