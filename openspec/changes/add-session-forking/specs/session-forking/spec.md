# session-forking — spec delta

## ADDED Requirements

### Requirement: Fork endpoint

The daemon SHALL accept `POST /session/:id/fork` from `write`-scope
tokens with body:

```jsonc
{
  "fromEventId": 8,
  "name":        "back-up-and-retry",
  "transcript":  "include" | "summary" | "empty"
}
```

`fromEventId` SHALL be required and SHALL refer to an event that
exists in the parent session's JSONL transcript AND is in a
terminal state (its emitting prompt has a `stopReason` or is
otherwise complete). If `fromEventId` is unknown the response SHALL
be `400 Bad Request` with code `fromEventId_unknown`. If
`fromEventId` is mid-prompt the response SHALL be `409 Conflict`
with code `fork_mid_prompt`. `name` is optional; when present it
SHALL be unique within the workspace.

The response on success SHALL be:

```jsonc
{
  "sessionId":       "<newSid>",
  "parentSessionId": "<parentSid>",
  "parentEventId":   8,
  "forkedAt":        "<ISO>",
  "transcriptMode":  "include" | "summary" | "empty",
  "name":            "back-up-and-retry"
}
```

After the response, the new session SHALL be a regular daemon-
hosted session: all session-scoped routes apply identically to it.

#### Scenario: Fork from a completed event with include mode

- **GIVEN** session `S` has JSONL lines 1..20 and event 15 is
  terminal
- **WHEN** a write-scope token posts `/session/S/fork {
fromEventId: 15, transcript: "include", name: "branch-a" }`
- **THEN** the response is `200` with a new `sessionId` `S'`
- **AND** the new JSONL at
  `~/.qwen/projects/<cwd>/chats/<S'>.jsonl` begins with the fork
  header line and contains a verbatim copy of `S`'s lines 1..15
- **AND** `GET /workspace/<cwd>/sessions` lists `S'` with
  `parentSessionId: "S", parentEventId: 15`

#### Scenario: Forking mid-prompt is rejected

- **GIVEN** session `S` is currently streaming a tool call started
  at event 16
- **WHEN** a client posts `/session/S/fork { fromEventId: 17, ...
}` where event 17 is mid-stream
- **THEN** the response is `409 Conflict` with code
  `fork_mid_prompt`

#### Scenario: read-scope cannot fork

- **GIVEN** a `read`-scope token attached to session `S`
- **WHEN** it posts `/session/S/fork`
- **THEN** the response is `403 Forbidden` with code
  `scope_required: write`

#### Scenario: Name collision is rejected

- **GIVEN** a session named `main` already exists in workspace `W`
- **WHEN** any client posts a fork with `name: "main"`
- **THEN** the response is `409 Conflict` with code `name_taken`

### Requirement: JSONL fork header

The first line of every fork's JSONL transcript SHALL be a single
JSON object:

```jsonc
{
  "type":            "fork",
  "parentSessionId": "<parentSid>",
  "parentEventId":   8,
  "forkedAt":        "<ISO>",
  "transcriptMode":  "include" | "summary" | "empty",
  "forkedByTokenId": "tkn_xxx"
}
```

The header line MUST be valid JSONL parseable by upstream
`qwen --resume`-compatible tooling without error; tooling that
doesn't recognise `type: "fork"` SHALL treat it as a no-op metadata
record and proceed to subsequent lines normally.

#### Scenario: Fork header is the first line

- **WHEN** a fork is created
- **THEN** line 1 of the new JSONL begins with `{ "type": "fork",`
- **AND** lines 2..N (for `include`) are the verbatim parent
  transcript lines 1..fromEventId

### Requirement: Transcript modes

#### `include`

The daemon SHALL copy parent JSONL lines `1..fromEventId`
byte-for-byte into the new session's JSONL after the fork header.
The copy SHALL be performed by streaming I/O without loading the
full file into memory.

##### Scenario: Include preserves bytes

- **GIVEN** parent JSONL bytes `B` for lines 1..N
- **WHEN** a fork is created with `transcript: "include",
fromEventId: N`
- **THEN** the new JSONL contains the fork header, then bytes `B`
  verbatim, then nothing else
- **AND** `sha256` of bytes after the header equals `sha256(B)`

#### `summary`

The daemon SHALL execute an out-of-band ACP call to the parent's
agent requesting a summary of context up to `fromEventId`. The
call SHALL have a default timeout of 30 s. On timeout or any
agent-side error, the response SHALL be `502 Bad Gateway` with
code `fork_summary_failed`. On success, the new JSONL SHALL
contain the fork header, then exactly one assistant-shape line:

```jsonc
{
  "type": "assistant",
  "text": "<summary text>",
  "meta": { "kind": "fork_summary" },
}
```

The summary SHALL also be returned in the fork response body as
`summaryText` for caller visibility.

##### Scenario: Summary mode produces a one-line context

- **WHEN** a fork is created with `transcript: "summary"`
- **THEN** the new JSONL has exactly two lines: header + summary

##### Scenario: Summary timeout returns 502

- **GIVEN** the parent's agent does not respond within 30 s
- **WHEN** the summary call is in flight
- **THEN** the daemon aborts the call
- **AND** the fork endpoint returns `502 Bad Gateway` with code
  `fork_summary_failed`
- **AND** no JSONL file is created for the failed fork

#### `empty`

The daemon SHALL write only the fork header. The new agent child
starts with no prior conversation context.

##### Scenario: Empty mode JSONL has one line

- **WHEN** a fork is created with `transcript: "empty"`
- **THEN** the new JSONL contains exactly one line (the header)

### Requirement: Independent lifecycle

After fork creation, the new session's state SHALL be independent
of the parent's. Prompts queued in the parent's FIFO MUST NOT
affect the fork; ending the parent session MUST NOT end the fork;
ending the fork MUST NOT affect the parent.

#### Scenario: Parent stays alive after fork

- **GIVEN** a fork is created from session `S`
- **WHEN** the fork issues prompts
- **THEN** the parent's JSONL is unchanged
- **AND** the parent's WAL receives no events caused by the fork's
  activity

#### Scenario: Ending the parent does not end the fork

- **WHEN** the parent's session is explicitly ended via
  `/session/<parent>/end`
- **THEN** the fork continues running
- **AND** the fork's lineage chain still resolves the parent's
  sessionId (just rendered as ended)

### Requirement: Lineage metadata in listing

`GET /workspace/:cwd/sessions` SHALL include, per session:

- `parentSessionId` — string or null
- `parentEventId` — integer or null
- `forkedAt` — ISO timestamp or null
- `transcriptMode` — string or null
- `forks` — array of sessionIds that name this session as parent

#### Scenario: Listing includes lineage

- **GIVEN** session `S` has forks `F1` and `F2`
- **WHEN** any token with `read` scope requests
  `/workspace/<cwd>/sessions`
- **THEN** `S`'s record has `forks: ["F1", "F2"]`
- **AND** `F1`'s record has `parentSessionId: "S"`,
  `parentEventId: <number>`, `forkedAt: <ISO>`, `transcriptMode:
<string>`

### Requirement: Lineage chain endpoint

`GET /session/:id/lineage` SHALL return:

```jsonc
{
  "sessionId": "<id>",
  "chain": [
    { "sessionId": "<id>",      "name": "<name>",   "forkedAtEvent": null },
    { "sessionId": "<parent>",  "name": "<name>",   "forkedAtEvent": <n> },
    ...
  ],
  "truncated": false
}
```

The chain SHALL be capped at 100 levels; deeper chains SHALL set
`truncated: true` and include the first 100 entries from the
target back toward root.

#### Scenario: Chain truncates at deleted parent

- **GIVEN** session `C`'s parent JSONL `P` has been deleted from
  disk
- **WHEN** any client requests `/session/C/lineage`
- **THEN** the chain stops at `C` (the deleted parent is not
  in the chain)
- **AND** `truncated: false`

#### Scenario: 100-level chain truncates

- **GIVEN** a chain of 150 forks of forks
- **WHEN** lineage is requested from the deepest leaf
- **THEN** the chain has exactly 100 entries
- **AND** `truncated: true`

### Requirement: SSE fork events

The daemon SHALL emit two new event types:

- `session_forked` — emitted to the **fork's** SSE stream as its
  first event. Data: `{ parentSessionId, parentEventId,
transcriptMode, forkedAt, forkedByTokenId, name }`.
- `child_forked` — emitted to the **parent's** SSE stream when a
  fork branches off. Data: `{ childSessionId, parentEventId,
forkedAt, name, forkedByTokenId }`.

Both events SHALL be replayable via `Last-Event-ID` per the
existing WAL semantics.

#### Scenario: Fork emits session_forked first

- **WHEN** a client subscribes to a newly-created fork's events
- **THEN** the first SSE frame is `session_forked` with all
  required fields

#### Scenario: Parent subscribers see child_forked

- **GIVEN** clients `A` and `B` are attached to session `S`
- **WHEN** client `A` forks `S` at event 8
- **THEN** clients `A` and `B` both receive a `child_forked` event
  with `childSessionId: <new>, parentEventId: 8`

### Requirement: Audit captures fork

Every successful fork SHALL produce an audit entry with action
`session.fork` carrying `parentSessionId`, `parentEventId`,
`transcriptMode`, `newSessionId`, `name`, and the issuing
`tokenId`. Failed forks (any 4xx/5xx) SHALL also be audited with
the error code in `outcome`.

#### Scenario: Fork is auditable by identity

- **WHEN** token `T` successfully forks `S` at event 8
- **THEN** the audit entry includes `tokenId: T`, `action:
"session.fork"`, `parentSessionId: "S"`, `parentEventId: 8`,
  `newSessionId: "<S'>"`

### Requirement: Operator CLI for fork management

The CLI SHALL expose:

- `qwen rc fork <sessionId> --from-event <id> [--mode
include|summary|empty] [--name <name>]` — create a fork. Prints
  new sessionId to stdout. If the active client is currently
  attached, also switches the attachment to the new session.
- The terminal client's `:fork` slash command SHALL accept the
  same flags and default `--mode include` and `--from` to the
  latest terminal event in the active session.
- `qwen rc sessions` SHALL render forks as a tree indented under
  their parents.

#### Scenario: `:fork` from inside terminal client

- **GIVEN** the terminal client is attached to session `S`
- **WHEN** the user types `:fork --mode summary --name try-b`
- **THEN** the client posts `/session/S/fork` with the latest
  terminal event id and `transcript: "summary"`
- **AND** on success the client detaches from `S` and attaches to
  the new fork
