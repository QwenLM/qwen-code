# Daemon Todo Stop Guard

## Problem

Daemon and ACP clients can keep a session alive after a model turn ends. When
the model has just written an unfinished top-level Todo list, a natural model
stop can leave the daemon request incomplete even though the session has enough
trusted state to continue. The client currently has no bounded, built-in way to
distinguish that case from an ordinary completed turn.

This design adds an opt-in daemon-only stop guard. It deliberately does not
change the TUI, the Core Todo tool, or the general agent loop.

## Configuration and safety boundary

`experimental.todoStopGuard` defaults to `false`, requires a restart, and is
not shown in the TUI settings dialog. The guard is forced off in safe mode,
bare mode, and Approval `plan` mode. `disableAllHooks` does not disable the
built-in guard because it is not an external hook.

Each uninterrupted automatic-continuation stage may create at most two extra
primary-model streams. A mid-turn user message explicitly starts a fresh
two-attempt stage because it is new user input, while retry/continue and
background results retain the current stage's budget. Existing permission
checks, cancellation, token limits, loop protection, ACP grace periods, and
daemon resource limits remain authoritative. In particular, a disconnected
client never implies permission approval.

## Trusted state

The CLI `Session` owns a small in-memory `DaemonTodoStopGuard` state machine.
It stores whether the current work chain is armed, the latest unfinished item
count, committed continuation attempts, suspension/queued-prompt state, and
whether exhaustion was already reported. The Session separately snapshots the
IDs of background agents, shells, monitors, and wakeups at the start of a work
chain, including terminal notifications and wakeups already queued at that
boundary.

Only a successful top-level `TodoWriteTool.execute()` result with the structured
`{ type: 'todo_list', todos: [...] }` envelope can arm the guard. The observation
happens after tool execution and status calculation, before Session
`PostToolUse` hooks. Arguments, replayed history, disk state, failed or
duplicate tool calls, sub-agent Todo lists, and discovered tools that shadow
the `todo_write` wire name are not trusted. The newest successful result
replaces the count; an empty or fully completed list disarms the guard
immediately. Disarming prevents another natural-stop continuation; it does not
truncate a tool loop already opened by a committed Guard stream.

A new ordinary user prompt starts an unarmed work chain and resets its
background baseline. It cannot inherit activation from an earlier request even
if Todo state remains in memory. Trusted retry/continue keeps the work chain
only while trusted unfinished Guard state still exists; after a trust-clearing
lifecycle event it starts with a fresh background baseline and must arm again.
A mid-turn user message keeps its activation and starts a fresh two-attempt
stage. This means the hard bound is two consecutive automatic streams without
new user input, not two streams across the entire lifetime of a work chain.
Cron and notification turns can establish their own chain through a successful
top-level Todo write; when they process background results for an armed chain,
they retain that chain's budget. A related background result is also a trusted
continuation that clears an API/network retry pause without clearing a hard
suspension.

The guard is not persisted. Rewind and history restoration clear trust, as do
branch/fork, a successful working-directory change, a new Session, disk
restoration, and daemon or agent restart. A live client attach to the same
Session keeps the in-memory state; changing models or non-Plan approval modes
does not by itself start a new work chain. A lifecycle invalidation also blocks
late tool results from the superseded live turn from re-arming the guard; the
next independent prompt or automatic turn establishes a fresh boundary.
Deferred automatic queues are released once an invalidated foreground prompt
settles, including when that prompt exits through an error path.

## Stop ordering

The guard participates only at a natural model stop. When it is active, Session
applies this order:

1. Drain mid-turn user messages. If any exist, skip Stop hooks and the guard,
   reset the guard budget, and run the user continuation in the current loop.
2. If the daemon FIFO contains a complete, non-aborted prompt, finish the
   current request and mark the old chain as awaiting that prompt. A cancelled
   queued request cannot later let background activity revive the old chain.
   When the last queued prompt is aborted, the bridge explicitly tells the
   live Session to terminate the awaiting guard and release unrelated automatic
   queues. If one drain observes both a mid-turn message and a queued full
   prompt, the mid-turn message runs first and FIFO priority remains in force
   even if that continuation completes the Todo list or hard-stops the guard.
3. On foreground turns, evaluate existing external Stop hooks with their
   existing cap and error semantics.
4. Evaluate the guard only when it is armed, not suspended or awaiting a queued
   prompt, has unfinished items, is outside Approval `plan`, and has no relevant
   background input.
5. If both an external hook and the guard block the same stop, combine their
   reasons into one continuation model call. Their counters remain independent.

Relevant background input is a still-live background agent, shell, monitor, or
`@wakeup` whose ID was not in the work-chain baseline, plus queued notifications
or wakeups with the same relationship. Background work and ordinary cron jobs
inherited from an older request do not block a new request. Automatic
cron/notification turns run the built-in guard only; they do not introduce
external Stop-hook calls. A related result retains the current budget, while an
old-task notification or ordinary cron turn is delayed until the active chain
can no longer resume, then starts an independent unarmed chain. Deferred
unrelated recurring cron fires are coalesced per task and bounded so a stalled
background dependency cannot grow the queue without limit. Daemon follow-up
suggestions are also suppressed while a Guard chain can still resume or a
complete FIFO prompt has priority, so unfinished work does not trigger a
competing suggestion-model call.

Hard terminal paths suspend the current work chain: user or permission
cancellation, `PostToolUse.shouldStop`, loop or repeated-call protection, token
limits, and the external Stop-hook cap. API and network errors preserve state
for an explicit trusted retry/continue.

## Continuations and observability

The first guard continuation sends:

> [Todo Stop Guard] N todo item(s) are still pending or in progress. Continue executing the current task now. Do not ask the user whether to continue. If progress requires user input, use the structured question or permission flow. If progress depends on external state, report the blocker explicitly.

The second also sends:

> This is the final automatic continuation. Before ending, either complete/update the todos or report the completed progress and the exact blocker.

The counter is committed only after `responseStream` is successfully returned.
Cancellation, compaction failure, or token rejection before that point does not
consume an attempt; a later stream failure does. Free-form blocker text is not
parsed. A compaction failure suspends that guard chain so it cannot leave
automatic queues blocked behind an unreachable retry; when an external Stop
hook was coalesced, its reason may still continue under the hook's existing
semantics. The budget counts every primary-model stream attributable to the
guard, including a follow-up that sends tool results from the preceding guard
stream. If the second stream returns more tool calls, Session executes and
preserves their results but does not open a third guard-attributable stream.
If the first stream completes every Todo through a tool call, the remaining
attempt may send the tool result without another unfinished-Todo prompt so the
model can finish its response. Mid-turn input sponsors that tool-result send
instead and takes priority without consuming the remaining Guard attempt.
When that stream was coalesced with an external Stop hook, the hook's existing
tool loop may still send those results without another Guard prompt or Guard
attempt; enabling the Guard must not truncate an external hook continuation.

Each committed continuation emits a replayable discrete
`agent_message_chunk` with `_meta.source = 'todo_stop_guard'` and the attempt,
maximum attempt count, and unfinished count. Exhaustion similarly emits:

> [Todo Stop Guard] Automatic continuation stopped after 2 attempts; N todo item(s) remain unfinished.

Todo text is never included in guard telemetry. Normal usage metadata still
accounts for the additional calls. Replay compaction preserves Guard events
that carry both `qwenDiscreteMessage` and the Guard source independently, so it
does not merge attempts or discard their per-attempt metadata after the live
event ring rolls over.

## Bridge compatibility

`craft/drainMidTurnQueue` adds optional `hasQueuedPrompt`. The bridge sets it
only when its pending-prompt list contains a complete entry whose state is
`queued` and whose abort signal is not aborted. Older Desktop/channel clients
may omit the field; Session treats omission as `false`. If the drain times out,
late responses may restore message contents, but their queued-prompt snapshot is
discarded because it may already be stale.

REST/SSE disconnect behavior and the event ring are unchanged. ACP HTTP retains
its existing ten-second grace period and replay path; grace expiry and explicit
close/cancel retain their current termination behavior.

## Verification

Unit tests cover strict activation, lifecycle resets, suspension, budget and
stream-commit semantics, bridge queue reporting, configuration gates, Stop-hook
coalescing, and terminal paths. Concurrency tests cover prompt FIFO priority,
late drain recovery, background-baseline isolation, and automatic turns.
Daemon E2E testing covers prompt admission without an SSE subscriber and later
ring replay of the bounded attempts. Existing ACP transport regressions cover
reconnect within the grace window, grace expiry, and permission round trips;
the manual E2E plan also exercises those paths with the guard armed. With the
setting disabled, existing Stop-hook, cron, notification, and prompt behavior
must remain unchanged.
