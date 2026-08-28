# Web Shell assistant turn settlement

## Goal

Expose a host callback for the semantic end of an assistant turn without requiring consumers to infer completion from prompt-status transitions or scan a changing transcript.

The callback is a generic Web Shell lifecycle contract. It is not tied to any embedding product, artifact projection, or workspace side effect.

## Contract

`onAssistantTurnSettled` receives:

- `sessionId` and daemon-assigned `promptId`; their tuple is the stable idempotency key;
- `outcome`: `completed`, `cancelled`, or `failed`;
- the daemon `stopReason` when a turn completed;
- `transcriptComplete`, which is false only when bounded live-journal repair could not restore the complete turn;
- the final visible assistant message when it remains available in the committed current-session transcript; turns without assistant content and events delivered across a session switch omit it, while cancelled and failed turns may carry partial content.

The callback is optional. Existing `onSessionChange({ type: 'turn_complete' })` behavior remains unchanged.

## Lifecycle and ordering

The daemon prompt terminal (`turn_complete` or `turn_error`) is authoritative. Prompt-status `idle`, render completion, and history replay are not terminal signals.

If a process or transport fails without delivering either terminal event, no settlement is published. This fail-closed behavior avoids reporting an unproven completion; connection health remains a separate lifecycle.

The daemon session provider publishes a settlement only after it has:

1. flushed buffered transcript deltas;
2. applied `assistant.done` and the terminal event's own transcript projection;
3. completed live-journal repair when a truncated active turn can be repaired.

Ordinary session load, branch/split transcript replay, and older-history pagination never publish settlements. A terminal received while reconnecting an already active prompt may publish because it is a previously unseen live lifecycle transition, not history playback.

Duplicate terminal delivery is suppressed for the lifetime of a mounted session provider using `(sessionId, promptId)`. Hosts must use the same key for durable idempotency across remounts.

`prompt_cancelled` is a cancellation request, not a confirmed prompt terminal, and does not publish a settlement by itself. Waiting for permission or `ask_user_question` also does not publish.

Listener failures are isolated from daemon stream processing. Artifact, tool-result persistence, and workspace projection keep their independent lifecycle.

## Implementation boundary

The WebUI daemon session layer owns authoritative terminal observation, transcript ordering, replay suppression, repair, and duplicate suppression. It exposes a subscription hook with prompt-level settlement metadata.

Web Shell owns projection of the final visible assistant message and the public callback type. It does not add daemon routes or change daemon event payloads.

## Tests

- `TC-01`: normal terminal publishes once with the complete final message.
- `TC-02`: assistant/tool/assistant turn returns the final assistant message.
- `TC-03`: permission or `ask_user_question` waiting does not publish.
- `TC-04`: confirmed cancellation publishes `cancelled`; cancellation request alone does not.
- `TC-05`: `turn_error` publishes `failed` and preserves any partial assistant message.
- `TC-06`: reconnect catch-up for an active local prompt publishes once.
- `TC-07`: ordinary history replay and older-history pagination do not publish.
- `TC-08`: duplicate terminal events publish once for a mounted provider.
- `TC-09`: session switch cannot attribute an old terminal to the new session.
- `TC-10`: successful live-journal repair delays publication until the repaired transcript is committed; failed repair marks `transcriptComplete: false`.
- `TC-11`: listener exceptions do not interrupt subsequent daemon events or listeners.

No visual UI changes are introduced, so browser screenshot validation is not applicable. Package unit tests, build, typecheck, and repository preflight are the delivery gates.
