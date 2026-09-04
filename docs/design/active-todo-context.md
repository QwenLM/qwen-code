# Active Todo Context

## Problem

`todo_write` presents the current list as a reminder only in its own tool
result. After more tool calls, that reminder loses salience and the model may
end the turn with unfinished items. The persisted todo file is unsuitable as
live control state because it can outlive the work chain that created it.

## Design

After a successful `todo_write`, keep a reminder containing only unfinished
items under a stable work-chain owner. Prompt IDs used by retries, related
automatic turns, and ordinary user turns that arrive while a reminder is still
registered resolve to that owner, so concurrent notification branches do not
move or overwrite the foreground reminder. Background tasks and loop wakeups
capture the owner when they are created and carry it back with their automatic
turn; unrelated cron and notification turns use an isolated owner that is
removed when the turn ends. Inject the reminder on the first request of a retry
or related automatic turn and after function responses on later tool turns.
Clear it when all todos complete, when an ordinary turn starts with no reminder
registered, or when the session changes.

A registered reminder is the signal that the plan still has unfinished items,
because `todo_write` deletes it once the list completes. An ordinary user turn
therefore continues the chain instead of discarding the context of work that is
still running: the turn that asks how the work is going is the turn that needs
the plan. The accepted cost is that an abandoned plan keeps resurfacing until a
later `todo_write` completes or clears it, while a genuinely new task replaces
the plan on its first write. Both frontends apply this, and in ACP the
todo-stop-guard lineage reset stays keyed to the retry/continue flag alone, so
carrying a plan never widens the guard's trust (#10953).

Every injected copy is recorded permanently in chat history, so per-turn
injection would grow the live context linearly with tool turns. Tool-turn
injection therefore re-issues the reminder only every third tool turn since
the last time the state was presented (the `todo_write` result itself counts);
turn-start injections always fire and reset that cadence. The payload is a
compact `- [status] content` line list capped at 800 characters. History stays
append-only, so provider prefix caching is unaffected.

A tool-turn count is a poor proxy for elapsed work when the turn is a delegated
run: a parent blocked on one foreground subagent earns a single tool turn for
the whole execution, so the cadence on its own leaves the plan stale for as
long as the subagent ran — 55 minutes in the report that motivated this rule
(#10953). A tool-result batch that carries a top-level Agent result therefore
forces the reminder due at that boundary, on both frontends, instead of waiting
out the cadence. Forcing stays bounded by registration: with no reminder
registered there is nothing to inject, so a delegation outside an active plan
costs nothing. This re-times delivery of the existing reminder only. It does
not derive plan state from the execution, which remains the model's job through
`todo_write`, and the Agent tool's optional `todo_id` stays observational.

This does not change stop semantics or enable `todoStopGuard`. The guard remains
an optional bounded recovery after a model has already tried to stop; this
change instead preserves task context before that decision.

## Verification

- A successful write with unfinished items updates the session reminder.
- A completed list clears it.
- Core and ACP tool-result messages append the reminder after function results.
- ACP mid-turn user input remains last and therefore keeps precedence.
- An ordinary new prompt retains the reminder while items are unfinished and
  clears stale state when none is registered; retry/continue always retains it.
  Both frontends behave the same.
- A tool-result batch carrying a top-level Agent result forces the reminder due
  even though the turn budget is not filled; a batch without one stays budgeted.
- Independent automatic turns are isolated; related automatic turns inherit.
- Terminal automatic turns release their temporary ownership state.
