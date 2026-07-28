# Active Todo Context

## Problem

`todo_write` presents the current list as a reminder only in its own tool
result. After more tool calls, that reminder loses salience and the model may
end the turn with unfinished items. The persisted todo file is unsuitable as
live control state because it can outlive the work chain that created it.

## Design

After a successful `todo_write`, keep a reminder containing only unfinished
items, keyed by the prompt ID that owns the work chain. Append it after function
responses on subsequent tool-result turns with the same owner in both the core
and ACP loops. This isolates ordinary prompts, cron jobs, and background
notifications even when they share a session. Clear the reminder when all todos
complete, a new work chain starts, or the session changes. Retry, continue, and
explicitly related automatic requests move the reminder to the new prompt ID
because they resume the same work chain. The repeated reminder is capped at
4,000 characters.

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
