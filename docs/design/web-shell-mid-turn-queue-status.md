# Web Shell mid-turn queue status

## Problem

When a queued prompt is moved into the running turn, the Web Shell removes it
as soon as the mid-turn enqueue request is accepted. The daemon may not inject
that message until a later tool boundary, so the message disappears while it is
still waiting and the user cannot tell whether it was consumed.

## Design

Keep the prompt visible through three states:

1. `submitting`: the prompt is being admitted to the daemon prompt queue.
2. `queued`: the prompt is waiting in the daemon prompt queue and can be moved
   into the running turn.
3. `midTurnQueued`: the daemon accepted the move, but has not yet injected the
   message into the running turn.

The `mid_turn_message_injected` SSE event is the consumption boundary. The
existing side channel matches that event by session, originator client, and
message text; only then is the prompt removed from the Web Shell queue.
If the running turn becomes idle before that event arrives, the daemon has
dropped the undrained mid-turn copy. The Web Shell removes the waiting row and
submits the same text as the next ordinary turn so the accepted message cannot
be stranded.

Removing the original queued prompt produces
`pending_prompt_completed{state:"removed"}` followed by that prompt's own
cancelled terminal. The removal event includes the prompt's `previousState`, so
the session provider can correlate a `queued` removal and its terminal by
`promptId` without suppressing the legitimate terminal for a removed `running`
prompt. A queued prompt's terminal cannot settle the running turn; the running
turn remains active until its own terminal arrives.

While the transfer request is pending, the row shows `Inserting into the current
turn...`. Once accepted, it shows `Waiting for the model...` with a tooltip that
explains it takes effect on the next model call. Actions are hidden because the
daemon mid-turn queue has no remove or edit operation. Failed transfers restore
the prompt text to the editor.

Removing a queued prompt immediately releases its pending-prompt capacity slot.
The bridge removes the corresponding serial-dispatch task before it starts, so
deleted history does not count toward `maxPendingPromptsPerSession` and a
replacement prompt still cannot overtake the active turn.
Because prompts share that serial queue with session operations, the first
prompt may be reported as queued when a branch or working-directory change is
already ahead of it.

The daemon advertises `session_mid_turn_message` in `/capabilities`. Web Shell
shows both insertion actions only when that feature is present, so clients
connected to an older daemon do not expose unsupported operations.

## Immediate insertion

Server-queued text prompts also offer `Insert now`. This is not turn
cancellation: the browser moves the selected prompt to the existing mid-turn
queue and requests that the ACP child interrupt only its active model call. The
same turn then drains the message, records it as mid-turn user input, and starts
another model call. The running daemon prompt remains active throughout, so no
new top-level user turn or cancelled terminal is produced. The interrupt
controller covers the complete model operation, including automatic compression
and recap before the response stream starts.

The enqueue and interrupt request share one daemon operation. The bridge stores
the message before asking the child to interrupt, so a fast model completion
cannot lose it; if there is no active model call because a tool is running, the
message is still drained at the next normal boundary. While the request is in
flight the row shows `Inserting now...`; after acceptance it remains visible as
`Waiting for immediate effect...` until `mid_turn_message_injected`. Failure
to interrupt the active model call does not discard the already accepted
message. The response distinguishes `deferred` (for example, a tool is running)
from `unavailable` (the interrupt request failed). Deferred messages keep the
immediate-waiting state because they are drained at the next boundary;
unavailable interruption downgrades the row to ordinary
`Waiting for the model...`.

The two actions are visually distinct: ordinary insertion uses
`CornerUpRight`, while immediate insertion uses `Zap`. Their hover text states
whether the current model response continues or is interrupted. Successful
requests rely on the persistent row status and do not emit a redundant toast.
When the queue container is narrower than 700px, action and status labels are
hidden. Action icons, loading spinners, and hover descriptions remain
available.
