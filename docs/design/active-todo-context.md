# Active Todo Context

## Problem

`todo_write` presents the current list as a reminder only in its own tool
result. After more tool calls, that reminder loses salience and the model may
end the turn with unfinished items. The persisted todo file is unsuitable as
live control state because it can outlive the work chain that created it.

## Design

After a successful `todo_write`, keep a reminder containing only unfinished
items under a stable work-chain owner. Prompt IDs used by retries and related
automatic turns resolve to that owner, so concurrent notification branches do
not move or overwrite the foreground reminder. Background tasks and loop
wakeups capture the owner when they are created and carry it back with their
automatic turn; unrelated cron and notification turns use an isolated owner
that is removed when the turn ends. Inject the reminder on the first request of
a retry or related automatic turn and after function responses on later tool
turns. Clear it when all todos complete, a new ordinary work chain starts, or
the session changes.

Every injected copy is recorded permanently in chat history, so per-turn
injection would grow the live context linearly with tool turns. Tool-turn
injection therefore re-issues the reminder only every third tool turn since
the last time the state was presented (the `todo_write` result itself counts);
turn-start injections always fire and reset that cadence. The payload is a
compact `- [status] content` line list capped at 800 characters. History stays
append-only, so provider prefix caching is unaffected.

This does not change stop semantics or enable `todoStopGuard`. The guard remains
an optional bounded recovery after a model has already tried to stop; this
change instead preserves task context before that decision.

## Verification

- A successful write with unfinished items updates the session reminder.
- A completed list clears it.
- Core and ACP tool-result messages append the reminder after function results.
- ACP mid-turn user input remains last and therefore keeps precedence.
- An ordinary new prompt clears stale state while retry/continue retains it.
- Independent automatic turns are isolated; related automatic turns inherit.
- Terminal automatic turns release their temporary ownership state.
