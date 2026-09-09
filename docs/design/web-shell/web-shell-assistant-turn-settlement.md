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

Each mounted `DaemonSessionProvider` publishes every prompt terminal observed
on its live SSE stream after the terminal transcript projection is committed.
Hosts that need submitter ownership correlate the prompt id with their submit
result. On reconnect, a terminal carried only by the replay snapshot publishes
when this provider previously admitted that prompt. That admission gate keeps
ordinary persisted-history loading silent while surviving session switches and
epoch-reset reloads that discard the active request controller.

A lost connection or missing terminal does not publish a settlement: neither
condition proves how the prompt ended. Hosts receive only daemon terminal
events observed live or through reconnect replay.

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
