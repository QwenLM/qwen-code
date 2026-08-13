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
  bridge terminal or persisted outcome, else `{ state: 'idle' }`.

Shared errors: `404` unknown session (`SessionNotFoundError`), `400`
`invalid_client_id` for a client id bound to another session.

## Response shape

```json
{
  "sessionId": "session-id",
  "state": "completed",
  "promptId": "prompt-id",
  "promptText": "Summarize the build failure",
  "startedAt": 1786152000000,
  "endedAt": 1786152012000,
  "stopReason": "end_turn",
  "resultText": "The build failed because the route catalog assertion is stale."
}
```

Field presence: optional fields are omitted rather than defaulted. In
particular `promptTextTruncated` / `resultTruncated` are only present when
`true` — consumers must treat an absent flag as `false`. A truncated result
also carries `resultCode: "RESULT_TEXT_TRUNCATED"` so consumers can reject an
incomplete answer without interpreting free text.

`originatorClientId`, when present, identifies the trusted client that admitted
the prompt. An `error` payload may accompany `state: 'error'` and contains a
required `message` plus an optional `code`; `prompt_deadline_exceeded` identifies
the bridge deadline terminal. Error messages are capped at 4,096 UTF-16 code
units and codes at 256, with `messageTruncated` / `codeTruncated` set only when
the corresponding value was truncated.

- `queued` / `running` mirror the bridge's live `pendingPromptList`
  (`queuedAt` at admission, `startedAt` at FIFO dispatch).
- `completed` / `cancelled` / `error` come from the bridge's exactly-once
  formal terminal while the daemon is live. A matching persisted
  `turn_result` enriches that status with recorded content but cannot
  overwrite its state, stop reason, error, or terminal timestamp. After a
  daemon restart, settled state comes from the persisted record alone. A
  `stopReason` of `cancelled` is reported as `state: 'cancelled'`.
- `promptText` mirrors the pending-prompt extraction: first non-empty text
  block, `[image]` for image-only prompts. `resultText` is the canonical
  top-level assistant answer visible to the user: subagent-owned chunks,
  discrete messages, and slash-command output are excluded; when message
  rewrite succeeds, rewritten text replaces the corresponding raw segment.
  Tool, thought, background, and status output are also excluded. When a
  response block calls a tool, its visible preamble is discarded; only the
  final response block after the last tool boundary is retained. Rewrite
  failure or an empty rewrite falls back to the raw top-level segment. Both
  fields are capped at
  `TURN_RESULT_TEXT_MAX_CHARS` (32,768 UTF-16 code units) with the paired
  `*Truncated` flag. A truncated `resultText` also sets
  `resultCode: "RESULT_TEXT_TRUNCATED"`.
  The result cap is applied after rewritten-versus-raw selection, so excluded
  or replaced text does not consume the visible-answer budget.
  In-flight raw/rewrite candidates are separately bounded to 65,536 UTF-16
  code units and 256 segments; loss of selected content at either bound sets
  `resultTruncated`.
  The cap applies to both projections: the live `queued` / `running`
  status caps `promptText` the same way the settled record does, so the
  same promptId reports a consistent shape before and after settlement.

## Persistence and the terminal overlay

Settled outcomes that the owning session successfully records survive normal
daemon restarts by appending one `turn_result` system record to the EXISTING session transcript JSONL
(`<projectDir>/chats/<sessionId>.jsonl`) through the existing
`ChatRecordingService` append path — no new files, no new write machinery:

- `ChatRecordingService.recordTurnResult(payload)` appends a
  `type: 'system'`, `subtype: 'turn_result'` record, best-effort like
  `recordFileHistorySnapshot`: a recording failure must never break turn
  settlement.
- `Session` accumulates the turn in flight (`#turnRecording`): the record
  is created after invocation-context validation but before admission checks,
  including `assertCanStartTurn()`, for prompts carrying an invocation context
  (daemon-admitted prompts only — internal cron/notification turns are not
  pollable). This keeps admission failures queryable by promptId. The record
  accumulates canonical visible answer segments in `sendUpdate` and settles on
  every exit path (early admission-cancel, pendingSend-cancel, normal
  completion, thrown error).
  Each `prompt()` call captures its own record reference and settles that
  exact reference; the shared slot is only published once the predecessor
  turn has settled and the turn's model loop starts. This keeps DAEMON-003
  deadline overlaps (the bridge releases the FIFO while the agent is still
  executing the old turn) from misattributing one turn's outcome to the
  other turn's promptId.
- Durable settled results require chat recording to be enabled for the
  session. Live queue state and the recent terminal overlay remain available
  while the daemon session is resident even when recording is unavailable.
- This endpoint is a bounded turn-status lookup, not an exactly-once result
  store. An unexpected child exit before its record is appended, daemon hard
  stop, disabled recording, or permanent storage failure does not gain a
  cross-restart durability guarantee from the bridge.

Reads go through the `qwen/control/session/turn_status` ext-method on the
owning ACP child: it flushes the recording service (so a just-settled turn
is visible — the flush is best-effort and a recorder in a write-failure
state still falls through to the scan), then scans the transcript backward
from the tail with
`SessionTranscriptReader` for `turn_result` records — exact `promptId`
match, or the most recent record when no promptId is given. The scan is
bounded (10 pages x 500 records x 4 MiB per page) so a pathological lookup
cannot read a huge transcript end to end. Oversized pages fail the read;
they are not converted into a successful `turnResult: null` response.

Transcript persistence is asynchronous relative to the bridge's formal
terminal event. To prevent a completed prompt from briefly regressing to
`prompt_not_found`, each live `SessionEntry` retains recent formal terminal
statuses in insertion order. The map has a fixed limit of 64 entries,
independently of `eventRingSize`; eviction only removes the transient overlay,
so persisted records remain queryable.

## Bridge resolution order

`AcpSessionBridge.getSessionTurnStatus(sessionId, context?, promptId?)`:

1. Authorize the caller against the session (mirrors `/prompt`).
2. Live state wins: a prompt on `pendingPromptList` (not removed) has not
   settled, so no record can exist for it. With `promptId`, exact match;
   without, the running entry, then the queued FIFO head.
3. Otherwise request the persisted record and consult the bounded terminal
   overlay. For the same prompt, persisted prompt/result text enriches the
   bridge terminal without changing its formal outcome. For `current`, the
   newer `endedAt` wins when overlay and persistence refer to different
   prompts.
4. If neither source has an outcome, return `undefined` (with promptId → 404) or `{ state: 'idle' }` (current).

`PendingPromptEntry.startedAt` is stamped at FIFO dispatch (at creation
for a prompt admitted straight to running).

## Failure semantics

- Turn settlement never depends on recording: `recordTurnResult` is
  best-effort, and the Session settle path swallows recording errors.
- A transcript without `turn_result` records (session never settled a
  daemon turn, or recording disabled/failed) can still return recent formal
  outcomes from the live daemon overlay. After restart or overlay eviction,
  an outcome that was never persisted yields `idle` / `prompt_not_found`.
- Rewind clears the process-local terminal overlay and then follows the
  child's persisted active transcript branch. With recording disabled or
  failed, historical promptIds are therefore not retained across rewind.
- Removing either a queued or running prompt immediately publishes one
  authoritative `cancelled` terminal and makes it pollable. Later agent
  settlement or teardown cannot replace that outcome.
- A queued deadline publishes `error` with code
  `prompt_deadline_exceeded`; polling moves directly from `queued` to that
  error without an intermediate unknown result.
- A bridge deadline error remains authoritative if the agent later persists
  a generic cancelled record; persisted `resultText` may still enrich the
  error response.
- The ext-method throws for non-live sessions; the bridge routes it only to
  the owning child.
