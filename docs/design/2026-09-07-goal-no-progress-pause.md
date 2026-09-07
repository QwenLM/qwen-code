# Stopping a Goal that has stopped getting anywhere

## Problem

An autonomous Goal has two bounds, and neither one notices a Goal that is
simply going in circles.

**The token budget is the only bound a talkative model reaches.** Continuation
is gated in one place, `queueContinuation` in `goal-runtime.ts`, and the only
thing that stops it there is a spent `tokenBudget` -- 30,000,000 tokens by
default. A model that answers each turn with a paragraph of status and calls
no tools never records evidence, so the verifier is never asked to judge
anything, and the Goal continues. The user sees turn after turn go by and the
spend climb, with nothing on the record that could ever end the loop except
the budget itself.

**The checkpoint bound measures the opposite problem.** `checkpointStalls`
stops a Goal after three consecutive checkpoints that could not relieve an
overflowing evidence window. That bound fires when a Goal produces _too much_
evidence to catalogue. A Goal producing none never reaches it: with no
evidence recorded, the checkpoint check closes as bookkeeping and the streak
does not even advance (`goal-runtime.test.ts`, "keeps the stall streak when a
turn records no evidence at all").

So the runtime can tell a Goal that is drowning in evidence from one that is
not, but not a Goal that is working from one that is idling.

Both comparable runtimes bound this. Codex stops a Goal after three
consecutive turns whose only tool activity was failed execs; Claude Code caps
consecutive Stop-hook blocks at eight.

## Design

A Goal stops after `GOAL_NO_PROGRESS_TURN_LIMIT` consecutive autonomous turns
that produced nothing to judge.

**What counts as progress.** A turn made progress if it recorded at least one
evidence-bearing tool result, or if it proposed a terminal state. Either one
gives the next turn something to act on: a tool result is citable evidence,
and a proposal is a claim the verifier or the blocked audit will weigh.
Assistant prose is deliberately not progress -- prose is exactly the output
this bound exists to notice.

`get_goal` and `update_goal` results do not count. They are recorded under the
turn's permit but carry `provenance: 'goal_runtime'`: the Goal runtime talking
to itself. A turn that only re-reads its own state is the clearest form of the
idling in question, and counting those results would make the bound
unreachable for the model most likely to trip it.

**Which turns are measured.** Only the runtime's own continuations, identified
by the host's delivery mark -- the same signal that already decides whether an
objective announcement was delivered and whether a wind-down hand-off was
spent. A turn carrying the user's own text is the user steering, and it
restarts the streak: the user has just supplied the new direction the bound
would otherwise be asking for. The wind-down hand-off turn is exempt from both
halves; it is asked to hand off rather than to work, so it neither counts
against the streak nor clears it.

A user turn reserved while the third quiet turn was still running also
outranks the bound. That reservation is a caller waiting in `claimGoalTurn`,
and stopping in front of it would strand them; the turn runs, and restarts the
streak on its own terms.

**Pause, not blocked, and not usage-limited.** `blocked` is a verdict the
verifier reaches on cited evidence, and this bound has no evidence to cite.
`usage_limited` says an allowance was spent, and nothing was: the Goal simply
stopped producing. A pause is what actually happened, `/goal resume` is the
whole remedy, and every surface already renders a paused Goal's `lastReason`.

Following `2026-09-02-goal-pause-reasons.md`, no new `GoalStateCause` is
introduced. The cause stays `pause`, which keeps the change out of the state
parsers, the persistence format, the legacy projection, the ACP replay, and
`shouldDisplayGoalStateCause`. The reason is a shared constant for the same
reason the other pause reasons are.

**Where the count lives.** On the record, as `noProgressTurns?`, exactly like
`checkpointStalls`: a daemon restart or a session resume must not launder it,
and zero is spelled as no field so a Goal that never idles carries nothing
new. It is cleared by edit, replace, and every resume -- including the resume
of a Goal this very bound stopped. Resuming is the user asking for another run
at the objective; starting that run three-quarters of the way to the bound
would end it after a single quiet turn.

**Where the count comes from.** The `GoalTurnTokenLedger` becomes
`GoalTurnLedger` and gains an optional `takeGoalTurnToolResults(turnId)`
alongside the existing spend accessor. `ChatRecordingService` implements it
the way it implements the spend: a single entry keyed by turn id, fed at the
point a tool result is recorded under a Goal permit, consumed once.

The method is optional, and that is load-bearing. A ledger that cannot answer
-- absent, older, or throwing -- switches the bound off for the session rather
than reporting every turn as idle. "Nothing measured" is not "nothing
happened", and the failure mode of getting that backwards is stopping a
working Goal. For the same reason the bound tests the count measured on this
turn rather than the count read off the record: a restored streak must not
stop a Goal whose ledger cannot see the turn that would have relieved it.

**Where the bound fires.** In `finishTurn`, after the `turn_finished` record
is journalled with the streak that reached the limit -- so the record explains
itself -- and before any continuation is queued. The checkpoint for that turn
is skipped: a stopping Goal has nothing to compact, and a resumed one starts
its next turn with a checkpoint anyway. A failed settle write does not strand
an active Goal; the in-memory snapshot shows the stop regardless, the same way
the budget stop already handles a lost write.

The threshold is a constant, not a setting. Three matches the checkpoint stall
bound and the blocked-audit streak; a `goals.*` settings family is the subject
of separate work on turn and time budgets.

## Scope

- `goal-protocol.ts`: `GOAL_NO_PROGRESS_TURN_LIMIT`, the
  `GoalRecord.noProgressTurns` field, and `GOAL_PAUSE_REASON_NO_PROGRESS`.
- `goal-reducer.ts`: `reduceGoalTurnFinished` records or clears the streak and
  leaves it untouched when the turn reports none; `transitionGoal` deletes the
  key when it is cleared; edit and all three resume branches clear it; the
  record parser accepts, validates, and restores it.
- `chatRecordingService.ts`: the per-turn tool result count, fed from
  `recordToolResult` for permitted results that are not `goal_runtime`, and
  `takeGoalTurnToolResults`.
- `goal-runtime.ts`: `GoalTurnLedger` and its optional accessor; the
  `takeTurnToolResults` reader that answers `undefined` rather than zero; the
  streak computation in `finishTurn`; the skipped checkpoint; the journalled
  pause and the committed paused snapshot.
- `config.ts`: the runtime is handed the recorder as `ledger`.
- `docs/users/features/goals.md`: the new pause reason joins the list.

Nothing in the hosts changes. The runtime journals the pause and broadcasts
it, and every surface already renders a paused Goal and its reason.

## Verification

- `goal-reducer.test.ts`: a reported streak is recorded and zero clears the
  field; an unreported streak is left untouched; edit and each of the three
  resume branches clear it; the parser restores a persisted streak, spells
  zero as no field, rejects negative and fractional counts, and reads a Goal
  persisted before the field existed.
- `chatRecordingService.test.ts`: `recordToolResult` feeds the count for
  permitted results, skips `goal_runtime` results and unpermitted ones,
  consumes once, and does not credit one turn with another's results.
- `goal-runtime.test.ts`: three quiet autonomous turns pause the Goal with the
  shared reason, journal `turn_finished` then `pause`, broadcast `pause`, and
  mint no fourth continuation; a tool result and a terminal proposal each
  restart the streak; an undelivered turn restarts it; the wind-down hand-off
  neither counts nor clears; a ledger that cannot count and one that throws
  both leave the bound off, as does one that answers with something that is
  not a count; the turn that spends the streak takes no checkpoint; a restored
  streak is spent by the next measured quiet turn; a resume clears the streak
  and restores the whole allowance; a failed settle write still shows the
  stop; a waiting user turn outranks the bound.
- End to end against a real model, with an objective the model can only answer
  in prose: the before-and-after transcripts are in this change's pull request
  under Evidence.
