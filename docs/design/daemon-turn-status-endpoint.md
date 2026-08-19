# Daemon turn-status endpoint

## Goal

Let clients that do not keep the session SSE stream open poll the state and raw final main answer of an admitted daemon prompt by `promptId`.

The feature is advertised by the always-on `session_turn_status` capability. It has no setting, flag, or environment variable.

## Scope and ownership

The read-only routes are Session-scoped:

- `GET /session/:id/turns/:promptId`
- `GET /session/:id/turns/current`

They resolve the live runtime that owns `sessionId`, apply the same client-id authorization as `/prompt`, and never scan another workspace or fall back to the primary runtime. The Session must already be live; polling does not load or resume an offline Session.

`current` returns the running prompt, otherwise the FIFO queued head, otherwise the newest settled result, otherwise `idle`. The exact route returns `404 prompt_not_found` when the live queue, the bounded bridge overlay, and the bounded active-transcript scan contain no matching result. This does not prove that the prompt never existed.

## Result semantics

States are `idle`, `queued`, `running`, `completed`, `cancelled`, and `error`. `queuedAt` is admission time while the prompt remains in the live queue or in-process overlay; persisted-only results can omit it. `startedAt` is present only after actual FIFO dispatch into Session/model execution. `endedAt` is terminal time.

`resultText` is the raw canonical final main answer: top-level, non-thought text from the last primary-model response block that does not contain a tool call. Text emitted before a tool call is discarded. Tool output, thought text, subagent stream updates, diagnostics, background messages, slash-command output, and future output from a sent sub-session are excluded. Optional message rewriting is downstream presentation and does not change this field. A completed turn can therefore have no `resultText` when the parent model produced no final text.

`promptText` and `resultText` are limited to 32,768 UTF-16 code units. A truncated prompt has `promptTextTruncated: true`; a truncated result has `resultTruncated: true` and `resultCode: "RESULT_TEXT_TRUNCATED"`. Error messages and codes are normalized without invoking unsafe getters and are limited to 4,096 and 256 code units respectively.

## Live and persisted sources

The bridge owns live FIFO state plus a fixed 64-entry terminal overlay. Formal terminal publication is first-writer-wins. Removed queued entries become terminal and are no longer projected as queued. A removed running entry remains `running` until Session settles it, because cancellation is cooperative and no terminal outcome exists yet. Entries with an already-published terminal are never projected as queued/running. Polling re-reads live state and the overlay after an awaited child read, including when that read fails, so a concurrent state change cannot regress to stale data. When overlay and transcript contain the same prompt, the overlay outcome remains authoritative and the transcript can enrich it with `resultText`, except when the overlay carries an error while the transcript records a settled non-error outcome for the same prompt: the transcript outcome then supersedes on the poll surface. This covers the deadline path, where the bridge latches `prompt_deadline_exceeded` while the agent keeps running and can still settle afterwards. Once a poll has combined the overlay with the child's persisted record for a promptId — whether merged or persisted-only — that answer is written back into the overlay, and later polls for the same promptId are served from it without re-scanning the transcript.

Terminal reporting is not monotonic across polls, by construction: both sources are bounded, and the persisted outcome supersedes a bridge-synthesized error. A deadline-exceeded prompt can therefore read `error` before settle and `completed` afterwards, and any settled result eventually leaves both the 64-entry overlay and the 10-page scan window, after which the exact route returns `404`. Field coverage can also narrow when only the persisted record remains (for example `queuedAt` is overlay-sourced). Clients should treat a backwards state transition or a `404` as bounded-window expiry rather than a new turn outcome.

Session is the only transcript writer. A daemon prompt that reaches `Session.prompt()` appends one best-effort `turn_result` system record through `ChatRecordingService`. The record stays on the active transcript chain so earlier bounded results remain queryable after later turns; forks omit it and reconnect any attached artifact record to its retained parent. Recording failure never changes the prompt lifecycle. Reads best-effort flush the recorder and walk at most 10 backward pages of 500 active records, with the existing 4 MiB page and snapshot limits. A single very large turn can consume that window, so an earlier result can return bounded not-found even when it remains in the JSONL. Invalid cursor, unavailable snapshot, oversized snapshot, and oversized page errors remain structured errors rather than becoming not-found.

Normal restart lookup therefore requires recording to be enabled, the append to have succeeded, the result to remain on the active branch and within the bounded scan window, and the Session to be loaded live again. Deleting the JSONL, disabling recording, a failed append, or leaving the bounded window removes that guarantee.

Prompts accepted only by the bridge but never dispatched into Session, including queued removal, queued deadline, close/kill cancellation, or forward failure, are available from the in-process overlay only. Unexpected process crashes and daemon shutdown do not trigger transcript backfill.

## History operations

A failed rewind keeps the overlay. A successful rewind clears it; the child reader's active transcript branch then decides which results remain queryable. Forking excludes `turn_result` records so a new Session cannot inherit source prompt identities.

## Non-goals

This is not an exactly-once or permanent result store. It adds no strict teardown persistence, close/kill write barrier, crash recovery journal, daemon transcript writer, offline workspace scan, promptId index, rewind coordinate map, or message-rewrite refactor.
