# Pausing a Goal, and saying why

## Problem

Two gaps, both visible the moment a user interrupts an autonomous Goal.

**A cancelled tool batch does not always stop the Goal.** Cancelling a Goal
turn already pauses the Goal on two paths: the model stream ending as
`UserCancelled`, and a tool batch whose calls were all cancelled. A batch
where some tools had already finished takes neither path. It falls through to
the ordinary submit path, so the cancelled tool's `[Operation Cancelled]`
result goes back to the model as one more tool result. The model reads it as a
transient failure and keeps working on the objective the user just
interrupted. This is the Goal-shaped form of the misattribution reported in
issue #10170.

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

For the first gap, a Goal tool batch that the user cancelled now stops the
Goal even when only some of its tools were cancelled. The branch adds the
responses to history first, so every function call stays paired with a
response and the history the next Goal turn resumes from stays well-formed.

Ordinary tool cancellation outside a Goal turn is unchanged; that is the
subject of #10170 and PR #10180.

## Scope

- `goal-protocol.ts`: the optional `reason`, its validator and bound, the
  shared reason constants and the two builders.
- `goal-reducer.ts`: pause writes or clears `lastReason`; the parser accepts a
  reason on `pause` only.
- `use-llm-stream.ts`: `failClosedGoalTurn` takes a `userCancelled` flag and
  picks the matching reason; the new partial-cancel branch.
- `goalCommand.ts`: `/goal pause` names itself.
- `Session.ts`: four ACP pause sites choose among user interrupt, output
  limit, session disposal, turn failure, and the Stop-hook cap.
- `nonInteractiveCli.ts`: the headless helper takes an explicit pause reason,
  and the run-budget site names the budget that tripped.
- `docs/users/features/goals.md`: a section on interrupting a Goal.

## Verification

- `goal-reducer.test.ts`: a supplied reason is recorded; a reasonless pause
  clears a stale one; the parser accepts a valid reason and rejects empty,
  oversized, non-string, and reasons on `resume`/`clear`.
- `goal-runtime.test.ts`: the reason is journalled with the paused snapshot,
  and a `releaseTurn` arriving after the pause schedules no continuation.
- `use-llm-stream.test.tsx`: a partly cancelled Goal tool batch pauses with
  the user-interrupt reason and never reaches the model.
- `goalCommand.test.ts` and `Session.test.ts` pin the reason each pause site
  sends.
- An E2E plan in `.qwen/e2e-tests/goal-pause-reasons.md` covers the three
  interactive cancel shapes and `/goal pause`.
