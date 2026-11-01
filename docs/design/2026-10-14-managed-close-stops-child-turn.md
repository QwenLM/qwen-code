# A parent close stops each child's running Turn (#13875)

[English](2026-10-14-managed-close-stops-child-turn.md) | [简体中文](2026-10-14-managed-close-stops-child-turn.zh-CN.md)

Status: implemented in this change. Delivers [#13875](https://github.com/QwenLM/qwen-code/issues/13875), finding 2 of [H4f](2026-10-10-managed-task-cancel.md)'s real-stack acceptance. Unit-level validation is done; the real-stack acceptance probes of the issue are listed under Validation and remain to be rerun.

## Problem

Closing a parent Session recorded a stop request for each running child and then **waited for the child's Turn to end on its own** — up to the Harness Turn deadline (`qwen.managed-agent.harness.turn-deadline`, 30 minutes by default). A caller who cancelled the child's task first and then closed, the natural cleanup order, got no faster stop: a close admitted right after the cancel still waited, because the only worker that physically stops a child — the child result relay's stop arm (H4f) — leaves early for a parent that is no longer `ACTIVE`, and the close admission moves the parent to `CLOSING` first. During the wait the child keeps calling the model and running tools in a Workspace whose owner asked to close it.

## Current state before this change

- The close cascade (`SessionLifecycleCoordinator.cascadeChildScopes`) sent each child the `cancel` operation, which records `stopRequested` on the run record, and then admitted the child's own close. That close refuses while the child has an active Turn ("The Session has an active Turn."), the refusal became close debt, and the parent close re-armed through the dispatch retry. Nothing on this path cancelled the Turn.
- The relay's stop arm cancels the Turn through `ManagedAgentService.cancelChildTurn`, but only runs while the parent is `ACTIVE`. Once the close is admitted, a stop the relay had not acted on yet is never acted on.

## Decision: the cascade cancels the Turn itself (option B)

#13875 named two options. Option A — the relay's stop arm also runs under a `CLOSING` parent — keeps the cancel with the relay but has to reopen the relay's early-out, which also guards result delivery to a closing parent, and has to arbitrate two settlers: the stop arm and the cascade both settle the run `close_scope`, and exactly one settlement may commit. **Option B, implemented here: the cascade cancels each child's active Turn itself, through the same keyed `cancelChildTurn` the stop arm uses, before admitting the child close.** The relay is unchanged, and a close with no prior public cancel is covered by the same arm. One driver owns the stop at any moment: while the parent is `ACTIVE` the relay does; once the close is admitted the cascade does. The keyed command (parent, run, Turn) makes the hand-off replay-safe.

## How it works

In the cascade's per-child walk, after the stop request is recorded and before the close-capability gate:

| Child's latest Turn                           | Cascade                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCEPTED` or `RUNNING`                       | `cancelChildTurn` (a redrive replays the keyed admission), then owe the re-arm — the child close still refuses while the Turn runs, so the next pass admits it once the Turn settled. |
| `CANCELLING`                                  | Wait on the retry; the Turn owns its outcome and the cancel is not re-driven.                                                                                                         |
| Terminal (`COMPLETED`, `CANCELLED`, `FAILED`) | No cancel; the existing child close and `close_scope` settlement proceed.                                                                                                             |
| No Turn                                       | Unchanged (the never-started pairings).                                                                                                                                               |

- A Turn that completes before the cancel lands keeps its natural outcome: the keyed cancel answers an ended Turn without effect, and a run the relay already settled is frozen against the cascade's `close_scope` by the record successorship.
- The stops run only once the stop request is durable: a faltered `cancel` operation defers the Turn cancel to a later pass (the child close attempt itself is unchanged), so a relay that captured the parent `ACTIVE` can never see a cancelled Turn with no recorded request and settle it `child_failed`. Once the request commits, every observer of the cancelled Turn also sees it and settles `cancelled` by `stop_requested`.
- A child holding session messages (H4d-b) gets its message route stopped **before** the Turn cancel, exactly as on the relay's stop arm: the cancel's own load can start the child's wake pump on a queued input. A faltered message stop drives no Turn cancel. Once the Turn is terminal, the child's own close stops any remaining message work ("holding the Session as a close does"), so no separate stop is owed there.
- Nested children recurse: each child's own close runs the same cascade. Delete runs the same cascade too (`settle` calls it for both `CLOSE` and `DELETE`), so deleting an active Session stops its children the same way.

## Boundaries

- The run's terminal revision is unchanged: `close_scope` settles `cancelled` by `stop_requested`. A child whose Turn completed naturally but whose result was never delivered — the relay delivers nothing to a closing parent — still settles `cancelled`. That is H4b's close semantics and is deliberately not changed here: the Turn's own `COMPLETED` outcome and its result stay intact in the child Session's record, and nothing is rewritten.
- The re-arm cadence is unchanged (dispatch backoff). The cancel adds passes that each do durable work, so the close completes in seconds instead of at the Turn's natural end.
- A faltered Turn cancel is close debt like any other faltered child verb: logged, re-armed, never settled on suspicion.

## Validation

- `SessionLifecycleCoordinatorTest#theCascadeCancelsTheChildsActiveTurnInsteadOfWaitingForIt` (parameterized over `ACCEPTED` and `RUNNING`): a child whose Turn never ends on its own. The cascade drives the keyed cancel exactly once — a further pass with the Turn `CANCELLING` re-records the stop request without re-driving it — and once the Turn settles `CANCELLED` the child close is admitted and the parent close completes without the wait. Written as the failing reproduction first, it passes with the fix.
- The stop's own failure paths, in the same suite: `theCascadeRetriesAFalteredChildTurnCancel` (a faltered cancel stays debt and re-drives), `aFalteredStopRequestDefersTheTurnCancelUntilItIsDurable` (no Turn cancel before the first durable stop request), `theCascadeStopsTheMessageRouteBeforeCancellingTheTurn` (message stop before Turn cancel), `aFalteredMessageStopDefersTheTurnCancel` (a faltered message stop drives no Turn cancel) and `aToleratedMessageStopRefusalStillCancelsTheTurn` (the two tolerated refusal codes — `hosted_turn_recovery_required`, `hosted_session_closing` — do not defer the Turn cancel).
- Regression: `SessionLifecycleCoordinatorTest` (29 tests), `ChildResultRelayTest` (106), `ManagedCwdChangeOperationTest` (48), and the full `managed-agent-server` module suite. The module suite's only failure is `BackfillWitnessesTest` (a Flyway baseline-version assertion), which fails identically on unmodified HEAD — baseline-checked, unrelated to this change. Checkstyle and SpotBugs: clean.
- Real stack, on the packaged chain with a scripted slow child (the issue's acceptance probes):
  - S8a (cancel, then close) and S8b (close only): the child's Turn ends `CANCELLED` within seconds of the close admission, and the parent close completes without waiting for the Turn's natural end.
  - A child that completes in the race window keeps its natural Turn outcome and its result.
  - A child with a queued H4d-b message: the message is never consumed, and the run settles `cancelled`.
  - A two-level tree: the close stops both levels.
  - Deleting an active Session stops its children the same way.

## Follow-up work

None new. The H4f follow-up row "Close stops the child" is delivered by this change.
