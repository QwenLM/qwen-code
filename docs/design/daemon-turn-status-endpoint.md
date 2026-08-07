# Daemon turn-status endpoint

## Goal

Provide pollable HTTP endpoints that report one turn's state for a session:
queued, running, or settled (completed with stop reason, cancelled, error),
including the agent reply text. Today the only way to observe a turn's
outcome is the SSE stream (`turn_complete` / `turn_error` keyed by
`promptId`); a client that cannot hold an SSE connection has no way to ask
"what happened to my prompt".

## Routes

Both routes are live-session-owner scoped and read-only, in the same class as
`GET /session/:id/pending-prompts`: they resolve the owning runtime via
`resolveLiveSessionRuntime`, authorize the caller via the
`X-Qwen-Client-Id` header (`parseClientIdHeader`), and never fall back to
another runtime.

- `GET /session/:id/turns/:promptId` — status of that exact prompt.
  - `200` with the turn status object.
  - `404 { code: 'prompt_not_found' }` when neither the live pending queue
    nor the persisted transcript knows that promptId.
- `GET /session/:id/turns/current` — status of the session's current turn:
  the running prompt, else the queued FIFO head, else the most recent
  persisted outcome, else `{ state: 'idle' }`.

Shared errors: `404` unknown session (`SessionNotFoundError`), `400`
`invalid_client_id` for a client id bound to another session.

## Response shape

```json
{
  "sessionId": "…",
  "state": "idle | queued | running | completed | cancelled | error",
  "promptId": "…",
  "promptText": "…",
  "promptTextTruncated": false,
  "queuedAt": 0,
  "startedAt": 0,
  "endedAt": 0,
  "stopReason": "end_turn",
  "error": { "message": "…", "code": "…" },
  "resultText": "…",
  "resultTruncated": false,
  "originatorClientId": "…"
}
```

Field presence: optional fields are omitted rather than defaulted. In
particular `promptTextTruncated` / `resultTruncated` are only present when
`true` — consumers must treat an absent flag as `false`.

- `queued` / `running` mirror the bridge's live `pendingPromptList`
  (`queuedAt` at admission, `startedAt` at FIFO dispatch).
- `completed` / `cancelled` / `error` mirror the persisted `turn_result`
  record (`startedAt` / `endedAt`, `stopReason` for completions, `error`
  for failures). A `stopReason` of `cancelled` is reported as
  `state: 'cancelled'`.
- `promptText` mirrors the pending-prompt extraction: first non-empty text
  block, `[image]` for image-only prompts. `resultText` accumulates
  `agent_message_chunk` text streamed during the turn (tool output and
  thought chunks excluded by design). Both are capped at
  `TURN_RESULT_TEXT_MAX_CHARS` (32 KiB) with the paired `*Truncated` flag.
  The cap applies to both projections: the live `queued` / `running`
  status caps `promptText` the same way the settled record does, so the
  same promptId reports a consistent shape before and after settlement.

## Persistence: reuse the transcript, no daemon memory

Settled outcomes must survive daemon restarts and must not require the
daemon to retain per-turn state. The agent therefore appends one
`turn_result` system record to the EXISTING session transcript JSONL
(`<projectDir>/chats/<sessionId>.jsonl`) through the existing
`ChatRecordingService` append path — no new files, no new write machinery:

- `ChatRecordingService.recordTurnResult(payload)` appends a
  `type: 'system'`, `subtype: 'turn_result'` record, best-effort like
  `recordFileHistorySnapshot`: a recording failure must never break turn
  settlement.
- `Session` accumulates the turn in flight (`#turnRecording`): the record
  is created at admission after `assertCanStartTurn()` for prompts carrying
  an invocation context (daemon-admitted prompts only — internal
  cron/notification turns are not pollable), accumulates streamed agent
  text in `sendUpdate`, and settles on every exit path (early
  admission-cancel, pendingSend-cancel, normal completion, thrown error).
  Each `prompt()` call captures its own record reference and settles that
  exact reference; the shared slot is only published once the predecessor
  turn has settled and the turn's model loop starts. This keeps DAEMON-003
  deadline overlaps (the bridge releases the FIFO while the agent is still
  executing the old turn) from misattributing one turn's outcome to the
  other turn's promptId.
- ACP per-session configs keep chat recording enabled by default, so every
  daemon session writes its transcript; the top-level ACP process disabling
  `chatRecording` does not affect sessions.

Reads go through the `qwen/control/session/turn_status` ext-method on the
owning ACP child: it flushes the recording service (so a just-settled turn
is visible — the flush is best-effort and a recorder in a write-failure
state still falls through to the scan), then scans the transcript backward
from the tail with
`SessionTranscriptReader` for `turn_result` records — exact `promptId`
match, or the most recent record when no promptId is given. The scan is
bounded (10 pages x 500 records) so a pathological lookup cannot read a
huge transcript end to end.

## Bridge resolution order

`AcpSessionBridge.getSessionTurnStatus(sessionId, context?, promptId?)`:

1. Authorize the caller against the session (mirrors `/prompt`).
2. Live state wins: a prompt on `pendingPromptList` (not removed) has not
   settled, so no record can exist for it. With `promptId`, exact match;
   without, the running entry, then the queued FIFO head.
3. Otherwise the ext-method above. A persisted record maps to the settled
   states; `null` maps to `undefined` (with promptId → 404) or
   `{ state: 'idle' }` (current).

`PendingPromptEntry.startedAt` is stamped at FIFO dispatch (at creation
for a prompt admitted straight to running).

## Failure semantics

- Turn settlement never depends on recording: `recordTurnResult` is
  best-effort, and the Session settle path swallows recording errors.
- A transcript without `turn_result` records (session never settled a
  daemon turn, or recording disabled/failed) simply yields `idle` /
  `prompt_not_found`.
- A prompt removed from the pending list before it settles — cancelled
  while still `queued`, or removed while `running` — never produces a
  `turn_result` record: the SSE channel publishes the terminal
  (`cancelled` / `removed`), but polling reports `404 prompt_not_found`
  for that promptId from the removal on. This is intentional — removals
  are not pollable — and consumers relying on those outcomes should use
  the SSE channel.
- The ext-method throws for non-live sessions; the bridge routes it only to
  the owning child.
