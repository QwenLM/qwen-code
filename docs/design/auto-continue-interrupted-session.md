# Auto-continue interrupted daemon sessions

## Problem

An ACP session can be persisted while a turn is in progress and later restored after the daemon or its environment restarts. The restored daemon has no in-memory active prompt, so WebShell becomes idle even though the persisted turn never reached a normal terminal state.

The daemon already exposes `POST /session/:id/continue`. Its ACP-side implementation classifies persisted history and atomically either starts a continuation or returns `accepted: false`. WebShell does not call it, and the TypeScript SDK has no typed wrapper for it.

## Design

Add a typed continuation result and methods to the raw and session-scoped TypeScript daemon clients. After WebShell completes an explicit session load, call the session-scoped continuation method when ACP replay contains a user turn and the restored session has no active prompt.

The ACP replay is the first gate: `user_message_chunk` proves there is a persisted turn to classify. Restored replay does not retain `turn_complete`, so WebShell does not try to infer completion from replayed assistant text, loading state, or connection count. The ACP agent's existing continue classifier is the authoritative completion gate: an interrupted turn produces `accepted: true`; a normally completed turn produces `accepted: false`.

Do not call continuation while `/load` reports an active prompt or when replay has no user turn. Do not call it for incremental SSE reconnects, which do not perform an explicit session restore. A continuation failure is recoverable: the loaded transcript remains usable and a warning notice is shown.

## Protocol boundary

The current `pending_prompt_started` event describes promotion from the pending queue and is not emitted for the first prompt on an idle session. It is therefore not used as a persisted turn-start marker in this change. The existing ACP control method performs the authoritative persisted-history classification; `turn_complete` and `turn_error` remain the terminal SSE events for the continuation it admits.

## Files

- TypeScript daemon result types and raw/session-scoped clients.
- WebShell daemon session provider and focused tests.
- Daemon SDK and WebShell focused unit tests.

## Out of scope

- A user-facing Continue button.
- Automatic continuation during transient SSE reconnects.
- Changing the ACP interruption classifier or introducing a new persisted lifecycle record.
- Retrying a failed automatic continuation in a loop.
