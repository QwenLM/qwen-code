# Daemon session source metadata

## Motivation

Daemon clients need to identify which integration created a session after the
daemon restarts. Live-only bridge metadata is insufficient because live entries
are rebuilt from the persisted transcript on load or resume.

## API

`POST /session` accepts two optional immutable fields:

- `sourceType`: a lowercase source token (`[a-z][a-z0-9_-]{0,63}`).
- `sourceId`: a non-empty identifier of at most 256 characters. It is valid
  only when `sourceType` is present.

The fields are returned by session creation, status, and workspace session-list
responses. Existing sessions omit both fields. Under `sessionScope: single`, an
attach returns the existing session's source and never adopts the attaching
request's source.

Workspace session lists accept `sourceType` and optional `sourceId` query
parameters. `sourceId` requires `sourceType`; when both are present they are
matched together. Source filters are not combined with the organized view.

Daemon scheduled tasks tag their dedicated session with
`sourceType: "scheduled_task"` and the durable task id as `sourceId`.

## Persistence

A fresh session stores one `session_source` system record near the head of its
JSONL transcript:

```json
{
  "type": "system",
  "subtype": "session_source",
  "systemPayload": {
    "sourceType": "web_shell",
    "sourceId": "window-1"
  }
}
```

The bridge asks the session child to append this record through an awaited ACP
control method, matching the existing `parent_session` persistence boundary.
The create response exposes `sourcePersisted` so a caller can detect a degraded
live-only source if recording fails.

`SessionService` reads the record while scanning the transcript head for list
responses and before load/resume so restored live summaries retain the source.

## Branching

Forked transcripts must not copy `session_source`; otherwise a new branch would
claim the original session's creator. A branch has no source until its creation
path explicitly assigns one.

## Compatibility

Both fields are optional. Older transcripts and clients remain valid. REST,
ACP-over-HTTP, and the TypeScript SDK forward creation and list-filter fields.
Daemons that implement the fields advertise `session_source_metadata`; the SDK
checks this capability before sending source metadata or source filters so an
older daemon cannot silently ignore them and return unfiltered results.
Values are attribution only and must not be used as an authorization signal
because clients can supply them.

If a client disconnects before receiving a newly-created session, the daemon
removes both the live session and its newly-written transcript. A concurrent
attach prevents both operations, preserving the session for the attached
client.
