# Web Shell Assistant Turn Settlement

## Problem

Embedding hosts currently infer turn completion from Web Shell's rendered
streaming state. That state is suitable for loading UI, but it does not identify
the daemon prompt or distinguish completion, cancellation, and failure.

## Contract

`WebShellProps.onAssistantTurnSettled` reports:

- the session id and daemon prompt id;
- `completed`, `cancelled`, or `failed`;
- the daemon stop reason when present;
- the final retained top-level assistant message when available;
- error details for failed prompts.

The stable host idempotency key is `(sessionId, promptId)`. Existing
`onSessionChange({ type: 'turn_complete' })` behavior remains unchanged.

## Delivery

Each mounted `DaemonSessionProvider` publishes a terminal for a prompt it
locally bound, after the terminal transcript projection is committed. That
happens on the live SSE stream, and also on a reconnect whose replay snapshot
carries the terminal — the snapshot is released once injected and SSE resumes
from `lastEventId`, so a replayed terminal is never re-delivered live. Ordinary
persisted-history loading does not publish: the gate is a locally bound prompt,
not the event type, so a first attach to a long-finished session stays silent.

The provider suppresses duplicate terminals for its mounted lifetime. A host
can mount the same session in more than one provider, such as the main chat and
a Split View pane, so durable cross-provider suppression remains the host's
responsibility through the documented idempotency key.

The final message is optional because bounded transcript retention, partial
history, cancellation, and failure can legitimately leave no retained assistant
text. Artifact and workspace projection have separate lifecycles and are not
implied to be settled by this callback.

## Verification

- completed, cancelled, and failed live terminals publish once;
- subscribers observe the terminal transcript projection before the callback;
- duplicate terminals publish once per provider mount;
- persisted history load is silent while reconnect catch-up publishes,
  including a terminal that arrives through the replay snapshot;
- main chat and Split View providers forward the callback;
- existing `onSessionChange` behavior is unchanged.
