# Web Shell default mid-turn insertion

## Problem

Messages sent while a turn is running are currently admitted as ordinary
pending prompts. The UI may then expose a separate insert action, even though
the expected send behavior is to make the message available to the running
turn automatically.

## Behavior

- A plain-text model prompt sent during an active turn is offered to the
  daemon's mid-turn queue by default.
- The prompt remains visible in the Web Shell queue until the daemon reports
  that it was actually injected into the running turn.
- The prompt disappears only after that injection event. Acceptance of the
  enqueue request alone is not treated as insertion.
- A new client connected to an older daemon keeps its ordinary pending-prompt
  fallback. Once a query-capable client receives an acceptance, the daemon owns
  the message: if the active turn becomes idle before injection, it promotes
  the message into its normal prompt FIFO.
- Anonymous live-steering messages remain private to the active coordinator.
  If one misses the final drain before the turn settles, the coordinator starts
  it as the next collected turn instead of exposing or promoting it as a bare
  prompt.
- Commands and prompts with images continue through the ordinary pending-prompt
  path because they cannot be represented by the text-only mid-turn API.
- The queue no longer exposes a separate insert action.

## State model

For a daemon advertising `session_mid_turn_message_query`, the daemon is the
only owner of an admitted message. The Web Shell does not keep a parallel
mid-turn queue: it renders the daemon's session snapshot and never resubmits at
idle, on session switches, or during page teardown. Delete and edit mutate the
daemon queue by stable message id. Settled ids remain in a bounded
reconciliation ring so an ambiguous HTTP retry cannot recreate a removed or
already-injected message. Older daemons keep the legacy local `submitting` and
`queued` fallback.

The daemon injection event includes stable message ids and message text. New
clients reconcile by id; text and originator matching remains as a compatibility
fallback for older daemons. Stable-id reconciliation is session-wide: every
attached client sees and may mutate the same daemon-owned queue regardless of
which client submitted a message.
These anonymous queue-only coordinator messages are still delivered to the ACP
child but are excluded from this session-wide event and snapshot surface.
Daemon queue additions and removals reuse the session pending-prompt change
events so every connected client refreshes the authoritative snapshots.

The queue and reconciliation rings are process-local. A child-channel exit
terminates the live session with `session_died`; queued messages are not
promoted into the removed session or retained across that terminal failure.

Delete and edit are shown only when the daemon advertises
`session_mid_turn_message_mutation`. This keeps clients compatible with older
daemons that can accept mid-turn messages but cannot remove them by id.

## Compatibility

`session_mid_turn_message_query` is the ownership boundary. A new client uses
client-generated message ids and relies on a daemon advertising that feature
for reconciliation and idle promotion. A new client connected to an older
daemon keeps the legacy local fallback. Client and daemon versions are deployed
together otherwise, so a daemon advertising the capability owns every accepted
mid-turn message.
