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
- If the daemon rejects the mid-turn request, or the active turn becomes idle
  before injection, the same prompt is submitted as an ordinary next turn.
- Commands and prompts with images continue through the ordinary pending-prompt
  path because they cannot be represented by the text-only mid-turn API.
- The queue no longer exposes a separate insert action.

## State model

An eligible prompt moves through `submitting` and `queued` mid-turn states.
Both states keep the row visible. While admission is in flight its actions are
disabled. Once the daemon returns a stable message id, delete and edit operate
on the daemon queue rather than only changing local UI: delete removes the row
after server confirmation, while edit removes it and restores its contents to
the composer. If the message has already left the daemon queue, the action
leaves the row intact until the injection event or idle fallback establishes
its real outcome. An injection event removes the row. Once delete or edit has
been requested, that message is never resubmitted automatically: an idle
fallback removes it for delete or restores it to the composer for edit. A
failed admission or an idle transition atomically claims untouched rows for
ordinary submission so the two fallback paths cannot submit them twice.

The daemon injection event includes stable message ids in addition to the
originating client id and message text. New clients reconcile by id; text-based
matching remains as a compatibility fallback for older daemons. Reconciliation
continues to match only messages from the current client and session,
preserving independent queues in other Web Shell clients.

Delete and edit are shown only when the daemon advertises
`session_mid_turn_message_mutation`. This keeps clients compatible with older
daemons that can accept mid-turn messages but cannot remove them by id.
