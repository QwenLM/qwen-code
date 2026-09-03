# Pausing a Goal, and saying why

## Problem

Two gaps, both visible the moment a user interrupts an autonomous Goal.

**A cancelled tool batch leaves the Goal's history malformed.** Cancelling a
Goal turn does stop the Goal -- pressing Esc while tools run aborts the
continuation owner's signal, and the cancelled-continuation branch in
`use-llm-stream.ts` pauses the turn. What that branch does not do is answer
the model's function calls: it marks the batch submitted, which stops those
callIds ever being submitted again, so the `functionCall` parts stay unpaired
and the next `/goal resume` sends a history with a call that has no response.
The all-cancelled branch below it writes those responses; the cancelled
continuation, which is the branch a user's Esc actually reaches, does not.
This is the Goal-shaped form of the misattribution reported in issue #10170.

**No pause says why it happened.** `reduceGoalControl` leaves `lastReason`
untouched on a pause, and no host supplies one. The field is rendered as the
reason a Goal is in its current state, so a paused Goal shows either nothing
or the previous turn's verifier rejection -- which explains why the Goal was
still running, not why it stopped. Six pause sites across the interactive TUI,
ACP, and headless are affected, and they cover events as different as a user
interrupt, a spent model output budget, a Stop-hook cap, and a failed turn.

## Design

`GoalControlRequest`'s `pause` variant gains an optional `reason`. The reducer
writes it to `lastReason`, and a pause without one clears the field rather
than inheriting a stale value. Every existing renderer already shows
`lastReason` for a non-active Goal, so the TUI card, `/goal`, the ACP
`_meta.goalState` update, and the headless `goal_state` event all carry the
reason with no per-host UI work.

No new `GoalStateCause` is introduced. The cause stays `pause`, which keeps
the change out of the state parsers, the persistence format, the legacy
projection, the ACP error mapping, and `shouldDisplayGoalStateCause`.

The reasons themselves are constants in `goal-protocol.ts` rather than
per-host prose, so the same event reads the same way everywhere and a test can
assert on the event instead of one host's wording: a user interrupt, `/goal
pause`, the model's output limit, a closed session, the Stop-hook cap, plus
two builders for a failed turn and a spent headless run budget. `parseGoalControlRequest`
accepts a reason only on `pause`, and only a non-empty string within
`GOAL_PAUSE_REASON_MAX_CHARACTERS`, so the HTTP and ACP control paths cannot
inject unbounded text into a card.

For the first gap, the branch that a cancelled Goal tool batch actually takes
now writes the batch's responses to history before it stops, so every function
call stays paired with a response and the history the next Goal turn resumes
from stays well-formed. The pairing belongs there rather than in a branch
further down: a batch whose continuation was cancelled returns before either
of them, and a second pause on an already-paused Goal throws.

Ordinary tool cancellation outside a Goal turn is unchanged; that is the
subject of #10170 and PR #10180.

## Scope

- `goal-protocol.ts`: the optional `reason`, its validator and bound, the
  shared reason constants and the two builders.
- `goal-reducer.ts`: pause writes or clears `lastReason`; resuming a paused
  Goal clears it, so a running Goal never renders the prose that explains why
  it stopped; the parser accepts a reason on `pause` only.
- `client.ts`: the interrupted-exit pause carries a reason. It runs before
  every host's own reasoned pause and a second pause on a non-active Goal
  throws, so this is the dispatch that decides what the record says -- a
  caller-aborted exit is a user interrupt, an exit that merely failed to
  complete is a failed turn, and the Stop-hook cap names itself.
- `use-llm-stream.ts`: `failClosedGoalTurn` takes a `userCancelled` flag and
  picks the matching reason; the cancelled-continuation branch pairs the
  batch's responses into history before it stops.
- `goalCommand.ts`: `/goal pause` names itself.
- `Session.ts`: four ACP pause sites choose among user interrupt, output
  limit, session disposal, turn failure, and the Stop-hook cap.
- `nonInteractiveCli.ts`: the headless helper takes an explicit pause reason,
  and the run-budget site names the budget that tripped.
- `docs/users/features/goals.md`: a section on interrupting a Goal.

## Verification

- `goal-reducer.test.ts`: a supplied reason is recorded; a reasonless pause
  clears a stale one; a resume clears a pause reason but keeps a blocked
  Goal's; the parser accepts a valid reason and rejects empty, oversized,
  non-string, and reasons on `resume`/`clear`.
- `client-goal.test.ts`: the interrupted-exit pause carries the user-interrupt
  reason when the caller aborted, the failed-turn reason when it did not, and
  the Stop-hook cap reason at the cap.
- `goal-runtime.test.ts`: the reason is journalled with the paused snapshot,
  and a `releaseTurn` arriving after the pause schedules no continuation.
- `use-llm-stream.test.tsx`: a partly cancelled Goal tool batch pauses with
  the user-interrupt reason, pairs both responses into history, and never
  reaches the model.
- `goalCommand.test.ts` and `Session.test.ts` pin the reason each pause site
  sends.
- An E2E plan in `.qwen/e2e-tests/goal-pause-reasons.md` covers the three
  interactive cancel shapes and `/goal pause`.
