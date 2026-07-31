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
Both states keep the row visible and its destructive actions disabled. An
injection event removes the row. A failed admission or an idle transition
atomically claims the row for ordinary submission so the two fallback paths
cannot submit it twice.

The existing daemon event includes the originating client id and message text.
Reconciliation continues to match only messages from the current client and
session, preserving independent queues in other Web Shell clients.
