# Web Shell assistant turn settlement

## Goal

Expose a host callback for the semantic end of an assistant turn without requiring consumers to infer completion from prompt-status transitions or scan a changing transcript.

The callback is a generic Web Shell lifecycle contract. It is not tied to any embedding product, artifact projection, or workspace side effect.

## Contract

`onAssistantTurnSettled` receives:

- `sessionId` and daemon-assigned `promptId`; their tuple is the stable idempotency key;
- `outcome`: `completed`, `cancelled`, or `failed`;
- the daemon `stopReason` for completed and cancelled turns;
- `error` (`{ message, code? }`) for failed turns; when no assistant content exists, this is the settlement's only failure diagnostic;
- `transcriptComplete`, which is false when replay integrity is degraded or bounded live-journal repair could not restore the complete turn before failing or being discarded;
- the final visible assistant message when it remains available in the committed current-session transcript; turns without assistant content and events delivered across a session switch omit it, while cancelled and failed turns may carry partial content.

Transport cursors such as the daemon SSE `eventId` remain internal to the session layer. Web Shell explicitly projects the stable host contract instead of forwarding the internal event object.

The callback is optional. Existing `onSessionChange({ type: 'turn_complete' })` behavior remains unchanged.

## Lifecycle and ordering

The daemon prompt terminal (`turn_complete` or `turn_error`) is authoritative. Prompt-status `idle`, render completion, and history replay are not terminal signals.

If a process or transport fails without delivering either terminal event, no settlement is published. This fail-closed behavior avoids reporting an unproven completion; connection health remains a separate lifecycle.

The daemon session provider publishes a settlement only after it has:

1. flushed buffered transcript deltas;
2. applied `assistant.done` and the terminal event's own transcript projection;
3. completed live-journal repair when a truncated active turn can be repaired, or classified the retained transcript as incomplete before discarding an unsuccessful repair.

Live-journal truncation ownership is captured when the marker arrives, before transcript retention can evict its rendered status block. The client keeps a session-scoped marker-claim ledger: daemon event IDs are used when present, while id-less markers use a deterministic client key derived from their prompt ownership and payload. The transcript projection also preserves the envelope `promptId` on `history_truncated` status blocks. A marker is consumed only by its owning terminal (or conservatively by the first observed terminal when ownership is absent), so it can make that turn incomplete without tainting later turns.

Ordinary session load, branch/split transcript replay, and older-history pagination never publish settlements. A terminal received while reconnecting an already active prompt may publish because it is a previously unseen live lifecycle transition, not history playback.

The callback covers live turns from both the primary chat and interactive Split View panes. Every pane observes its own session provider, and a bounded Web Shell-level dispatcher suppresses duplicates when the primary session is also mounted in a pane. Merely opening a pane and replaying its transcript remains silent.

Recent duplicate terminal delivery is suppressed by a bounded in-memory window in the mounted session provider using `(sessionId, promptId)`. Hosts must use the same key for durable idempotency across remounts and long-lived sessions.

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
- `TC-12`: clearing or replacing a repair episode releases its held settlement once with `transcriptComplete: false`.
- `TC-13`: degraded catch-up replay and unrecoverable live-journal markers publish the affected turn with `transcriptComplete: false` without tainting later complete turns in the same session.
- `TC-14`: a correlated terminal after reconnect consumes the restored-active snapshot and allows live or catch-up repair to finish; a mismatched live terminal neither consumes nor publishes for the restored turn.
- `TC-15`: a live turn in a Split View pane publishes with that pane's session and final message, while the shared dispatcher suppresses duplicate observation of the primary session.
- `TC-16`: id-less live-journal markers retain envelope prompt ownership, and marker claims survive transcript-retention eviction and same-session rebuilds without tainting later turns.

No visual UI changes are introduced, so browser screenshot validation is not applicable. Package unit tests, build, typecheck, and repository preflight are the delivery gates.
