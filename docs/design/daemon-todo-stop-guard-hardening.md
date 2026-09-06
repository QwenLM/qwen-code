# Daemon Todo Stop Guard hardening

## Context

The daemon Todo Stop Guard can append a bounded automatic continuation after a
model turn leaves trusted Todo items unfinished. A bridge may admit another
user prompt while the current turn is draining, and background agents, monitors,
notifications, and cron jobs may complete at the same time. The Guard must not
overtake admitted user work, revive work from another workspace or prompt, or
lose user and tool content when an automatic send fails.

## Continuation ownership

`craft/claimTodoStopGuardContinuation` is the ordering boundary between a
bridge prompt queue and a Guard continuation. The request contains the session
ID and, for a bridge-owned prompt, the trusted
`InvocationContextV1.promptId` injected by the bridge. Session-local provider
prompt IDs are not owners.

For a bridge-owned prompt, the daemon claims only while that prompt is still
the active, non-aborted running entry. A live queued prompt produces
`{ claimed: false, hasQueuedPrompt: true }` and binds the wait to the current
owner prompt ID. A missing, replaced, or competing owner fails closed without
changing another owner's state. An ownerless automatic turn can claim only
when no live bridge prompt exists.

Channels and the desktop shared agent do not have the daemon FIFO. They validate
the current session and return a successful claim for it; unknown sessions and
ownerless fallback handlers fail closed. Clients that do not implement the
method, malformed responses, and the two-second claim deadline all disable only
the Guard portion of a continuation; an independently blocking external Stop
hook may still continue. A confirmed live FIFO prompt instead ends the old turn
immediately, without displaying or counting the now-stale hook response.

`craft/todoStopGuardQueueReleased` carries the Guard owner prompt ID. A late
release can clear only the matching wait. FIFO promotion also clears the
owner-scoped wait because the queued user prompt has taken ownership. Session
also tracks claims in flight: if the matching release is processed before the
claim response continuation, it records a short-lived tombstone, applies the
terminal release state, and refuses to install a wait from the stale response.
The tombstone is removed when the last in-flight claim for that owner settles.

## Send ordering and preservation

The drain result's `hasQueuedPrompt` field is a hint. A positive hint is
confirmed by a claim: a still-live queue yields the turn, while a disappeared
queue allows Stop processing to continue. If the same drain also removed
mid-turn user content, yielding stores that content in chat history before the
queued prompt runs so the ordering boundary does not become a data-loss
boundary. A failed or malformed drain gives recovered user content priority
when such content exists; otherwise it hard-suspends the Guard without
suppressing an independent external Stop hook.

Before a Guard-attributed model stream, Session drains input, builds image
parts, selects the full-turn vision model, refreshes PLAN mode and background
state, refreshes the Guard decision, and claims the continuation. Compression,
token-limit checks, and the provider send happen only after that claim. Each
additional Guard stream claims separately. A prompt admitted before the claim
wins; one admitted after the claim is ordered after the already committed
continuation.

If preparation, compression, claim, token-limit validation, stream creation, or
the provider send fails, the unsent Guard instruction is removed before history
preservation. Drained user parts, successful function responses, and other
independent Stop content remain. Session compares the user-content push counter
before adding history so a lower layer that already persisted the content
cannot cause a duplicate.

## Hard suspension

Hard suspension is entered after Guard exhaustion, explicit session disposal,
working-directory relocation begins, a terminal queued-prompt release, an
unreliable drain with no recovered user input, and controlled cancellation or
failure paths that cannot safely continue the chain. It clears existing queued
ownership and blocks late Todo writes from re-arming the old chain. A complete
FIFO observation racing with suspension may still establish prompt-ordering
priority for its owner, but that priority does not restore Guard trust or permit
a Guard send.

Only a new ordinary prompt starts a fresh chain. A trusted retry may resume a
retry-paused chain, but background results, cron turns, notification turns,
settings refreshes, and late tool completions cannot clear hard suspension.
Entering PLAN mode clears Guard trust and prevents automatic continuation.

## Background lineage

Session captures a background baseline at the start of each work chain and
resets the baseline and explicit related-agent set together.

- A newly created top-level agent is related.
- A new child inherits recursively from its parent. Missing parents and cycles
  fail closed.
- A baseline agent is unrelated unless the chain successfully continues it
  with `send_message(task_id)`.
- `send_message(task_id)` provisionally marks the target after permission and
  `PreToolUse` checks but before execution, so a fast completion notification
  is classified correctly. Success commits before `PostToolUse`; error,
  cancellation, or throw rolls back only the mark introduced by that call.
- Team-addressed `send_message(to)` does not change task lineage.
- A monitor with an owner inherits the owner's relation regardless of the
  monitor's own baseline membership. An ownerless monitor uses its monitor ID.

Notification relation is stored at enqueue time so later registry deletion or
status changes cannot reclassify an already delivered result. Live scans,
priority selection, and overflow protection use the same lineage rules.
Starting a new ordinary prompt intentionally resets every notification already
in the queue to unrelated: those results were enqueued before the new work-chain
boundary and cannot inherit their previous chain's classification.

## Session lifecycle and bounded queues

`/cd` validates and canonicalizes the target before acquiring the existing
session close gate. An apparent no-op also acquires the gate and rechecks the
current directory, so it cannot race a concurrent relocation; it does not
hard-suspend the Guard unless it becomes a real move. Once a move is gated, it
hard-suspends the Guard, waits for foreground, cron, and notification turns to
settle, relocates, refreshes model context, and releases the gate in `finally`.
Prompt admission checks the gate both before and after writer admission. The
settle loop rechecks ownership after every completion so a prompt admitted
before the gate while waiting for its predecessor is included too. Relocation
failure leaves the old Guard suspended.

`dispose()` remains synchronous but aborts the foreground controller with a
dedicated controlled-cancellation reason, hard-suspends the Guard, and prevents
late tool results from reviving it. Production close paths retain responsibility
for waiting until turns settle.

On persisted-session load or resume, history replay, worktree restoration,
paused-agent restoration, and goal restoration all complete before the rewriter
and durable cron scheduler start. This prevents an immediately due cron fire
from racing restoration and classifying a pre-existing paused agent as new work
from the resumed chain.

Deferred cron overflow is computed after deduplication. A related incoming item
may retain twenty unrelated items; an unrelated incoming item first trims to
nineteen and becomes the twentieth. Related entries are never evicted, and a
multi-entry trim emits one diagnostic.

The notification queue case where all bounded entries are related remains
deferred. Replacing one unique related result with another would still be silent
data loss. A follow-up design must provide a recoverable result or a durable,
model- and user-visible gap notice for every omitted related result. Track that
work in [#7805](https://github.com/QwenLM/qwen-code/issues/7805).
