# cross-session-search — spec delta

## ADDED Requirements

### Requirement: Per-workspace FTS5 index

The daemon SHALL maintain a SQLite FTS5 index at
`~/.qwen/rc/search/<sanitized-cwd>.db` containing one row per
indexed event across all sessions in the workspace. The index
SHALL be created on first run, migrated forward on schema bumps,
and opened in WAL mode for concurrent reads during writes.

The schema MUST include:

- `documents(rowid, session_id, event_id, kind, ts, text)` with
  `UNIQUE (session_id, event_id)`.
- `fts` FTS5 virtual table mirroring `documents.text`, tokeniser
  `unicode61 remove_diacritics 2`.
- `token_session_history(token_id, session_id, first_seen)` for
  permission filtering.
- `session_meta(session_id, name, ended, first_ts, last_ts,
evicted_at)`.

#### Scenario: Fresh install creates schema

- **GIVEN** no index file exists for workspace `W`
- **WHEN** the daemon starts
- **THEN** the file is created with the current schema
- **AND** `meta.schema_version` equals the current version

#### Scenario: Schema migrations are forward-only

- **GIVEN** an index at schema version `N`
- **WHEN** the daemon starts with schema version `N+1` available
- **THEN** the daemon applies the migration to `N+1`
- **AND** the index remains queryable
- **AND** downgrading to a daemon expecting `N` is rejected with
  a clear error

### Requirement: Ingestion is incremental and idempotent

The daemon SHALL ingest events into the index via two paths:

1. **Primary**: an in-process subscription to the session
   manager's event-committed signal, batched up to 100 events or
   250 ms, whichever comes first.
2. **Fallback**: an fsnotify watcher on `<cwd>/chats/*.jsonl` with
   2 s debounce that re-ingests new lines for any session whose
   highest indexed `event_id` lags the file's current count.

Both paths SHALL be idempotent on `(session_id, event_id)`. Re-
ingesting the same event MUST NOT create duplicate rows.

#### Scenario: In-process ingest within 1 s

- **GIVEN** a session is producing events at 10/sec
- **WHEN** the daemon writes event `E` to JSONL
- **THEN** within 1 s, a row for `E` exists in `documents`

#### Scenario: Out-of-band edit is picked up

- **GIVEN** the daemon is running but did not write event `E`
- **WHEN** an external process appends event `E` to the JSONL
- **THEN** within 3 s, a row for `E` exists in `documents`

#### Scenario: Duplicate ingest is a no-op

- **WHEN** the same event is processed by both the in-process and
  fsnotify paths
- **THEN** exactly one row exists for that `(session_id,
event_id)`

### Requirement: Canonicalised text per event kind

Each indexed event SHALL be converted to `documents.text` via a
deterministic canonicaliser:

- `user`: the raw user message text.
- `assistant`: the raw assistant text (no tool-call envelope).
- `tool` (call): `"<tool name> <args canonicalised to flat
space-separated path=value pairs>"`; args truncated at 4 KiB.
- `tool_result`: outcome label (e.g., `ok`, `error`) followed by
  the first 4 KiB of stderr/stdout.

The canonicaliser MUST be byte-stable: identical input across
runs produces identical `text`.

#### Scenario: Tool call canonicalisation is stable

- **WHEN** the same tool call `edit_file path=src/x.ts
line_start=4 line_end=8` is indexed twice
- **THEN** both `documents.text` values are byte-identical

### Requirement: Query API

`GET /rc/search` SHALL accept:

| Param       | Type   | Required | Default | Notes                                              |
| ----------- | ------ | -------- | ------- | -------------------------------------------------- |
| `q`         | string | yes      | -       | FTS5 query. Max length 1024.                       |
| `kind`      | enum   | no       | `all`   | `assistant`, `user`, `tool`, `tool_result`, `all`. |
| `sessionId` | string | no       | -       | Restricts to one session.                          |
| `since`     | ISO ts | no       | -       | Lower bound on `ts`.                               |
| `limit`     | int    | no       | 50      | Max 200.                                           |

The response SHALL be:

```jsonc
{
  "hits": [
    {
      "sessionId":    "<sid>",
      "sessionName":  "<name or null>",
      "eventId":      <int>,
      "ts":           "<ISO>",
      "kind":         "assistant" | "user" | "tool" | "tool_result",
      "snippet":      "...<mark>oauth</mark> refresh...",
      "score":        <number, lower is better with bm25>
    }
  ],
  "truncated":  <bool>,
  "elapsedMs":  <int>
}
```

The query SHALL be filtered by the caller's visible-session set
(see "Permission filtering"). Excluded sessions MUST NOT appear
in the response under any circumstance.

Queries SHALL have a per-query timeout (default 2 s); exceeded
queries return `503 Service Unavailable` with code
`search_timeout`.

#### Scenario: Owner queries across all sessions

- **GIVEN** workspace `W` has 3 sessions
- **WHEN** an owner-scope token queries `q=oauth`
- **THEN** the response includes hits from any of the 3 that
  match
- **AND** hits are ordered by BM25 score ascending (lower is
  better)

#### Scenario: Phrase query is honoured

- **WHEN** a query `q="oauth refresh"` runs
- **THEN** results match the phrase only, not the bag-of-words
  "oauth" near "refresh"

#### Scenario: Boolean operators work

- **WHEN** a query `q=oauth AND error NOT migration` runs
- **THEN** results contain `oauth` and `error` and do not contain
  `migration`

#### Scenario: Prefix wildcard

- **WHEN** a query `q=oauth*` runs
- **THEN** results match terms beginning with `oauth` (e.g.,
  `oauth`, `oauth2`, `oauthlib`)

#### Scenario: Regex characters rejected

- **WHEN** a query `q=oauth.*refresh` runs (regex chars outside
  phrase quotes)
- **THEN** the response is `400 Bad Request` with code
  `query_unsupported`

#### Scenario: Excessively long query rejected

- **WHEN** a query with `q` longer than 1024 chars runs
- **THEN** the response is `400 Bad Request` with code
  `query_too_long`

#### Scenario: Snippet contains highlight markers

- **GIVEN** a result hit matching `q=oauth`
- **WHEN** the response is built
- **THEN** the `snippet` field contains `<mark>` and `</mark>`
  around the matched term

### Requirement: Permission filtering

The set of sessions visible to a query SHALL be computed per
caller:

- `owner` scope: all sessions in the workspace.
- `share` scope: only the session identified by the token's
  `session_lock_id`.
- `bridge` scope: sessions present in `token_session_history` for
  that bridge's token.
- `write`, `approve`, `read` scopes: sessions present in
  `token_session_history` for that token.

The visible-session filter SHALL be applied as a hard SQL `AND`;
no fallback path SHALL return rows outside the set. Even when the
caller specifies `sessionId=<not_visible>`, the response MUST be
empty (not 403, not error).

`token_session_history` SHALL be updated on first SSE subscribe
to any session.

#### Scenario: Read-scope sees only attached sessions

- **GIVEN** read-scope token `T` has attached only to session
  `S1` in workspace with sessions `S1, S2, S3`
- **WHEN** `T` queries `q=anything`
- **THEN** every hit's `sessionId` equals `S1`

#### Scenario: Share token is locked

- **GIVEN** share-scope token locked to `S1`
- **WHEN** it queries `q=anything` with `sessionId=S2`
- **THEN** the response has zero hits
- **AND** no information about `S2` leaks (no count, no error)

#### Scenario: Token-session-history records on subscribe

- **WHEN** token `T` subscribes to `/session/S/events` for the
  first time
- **THEN** a row `(T, S, <ts>)` exists in
  `token_session_history`
- **AND** subsequent subscribes do not duplicate the row

### Requirement: Reindex on demand

`POST /rc/search/reindex { sessionId? }` (owner scope) SHALL
start a background reindex job. When `sessionId` is present, only
that session is rebuilt; when absent, the entire workspace is
rebuilt. The response is `202 Accepted` with `{ jobId }`.

`GET /rc/search/reindex/:jobId` SHALL return
`{ state: "running"|"complete"|"failed", processed, total,
errors[] }`.

The reindex MUST NOT block reads — searches continue to run
against whatever is currently indexed during the job.

#### Scenario: Single-session reindex

- **GIVEN** session `S` has 1000 events in JSONL but only 500
  in the index (e.g., after manual edit)
- **WHEN** an owner posts `/rc/search/reindex { sessionId: "S" }`
- **AND** the job completes
- **THEN** the index has 1000 rows for `S`

#### Scenario: Full reindex preserves visibility tables

- **WHEN** a full reindex runs
- **THEN** `token_session_history` rows are NOT deleted
- **AND** `session_meta` rows are preserved (only their `last_ts`
  may be recomputed)

### Requirement: Bounded index with whole-session eviction

The daemon SHALL enforce a cap on index size (default
`maxIndexBytes = 268435456` / 256 MiB). When the cap is exceeded,
the eviction process SHALL:

1. Score each session by `now - last_ts` (older = higher score).
2. Delete `documents` rows for the oldest sessions until at least
   `evictMarginBytes` (default 64 MiB) is freed.
3. Record `evicted_at` for each evicted session in
   `session_meta`.
4. VACUUM the database.

JSONL files on disk MUST NOT be deleted by eviction. The operator
can reindex any evicted session to bring its rows back.

The eviction runner SHALL execute at most every 5 minutes and
SHALL skip if the cap is not exceeded.

#### Scenario: Eviction evicts oldest whole-sessions

- **GIVEN** index size is 257 MiB with 10 sessions whose
  `last_ts` ranges from 1d to 90d old
- **WHEN** eviction runs
- **THEN** the oldest sessions (90d, 80d, ...) are evicted until
  ≥ 64 MiB is freed
- **AND** their `session_meta.evicted_at` is set
- **AND** their JSONL files on disk are untouched

#### Scenario: Reindex restores an evicted session

- **GIVEN** session `S` was evicted yesterday
- **WHEN** an owner reindexes `S`
- **THEN** `documents` rows for `S` reappear
- **AND** `session_meta.evicted_at` is cleared

### Requirement: Diagnostics endpoint

`GET /rc/search/stats` (owner scope) SHALL return:

```jsonc
{
  "indexBytes":      <int>,
  "maxIndexBytes":   <int>,
  "documentCount":   <int>,
  "sessionCount":    <int>,
  "ingestBacklog":   <int>,
  "lastReindexJob": { "id": "...", "state": "complete", "finishedAt": "<ISO>" } | null,
  "schemaVersion":   <int>,
  "oldestIndexedTs": "<ISO>",
  "newestIndexedTs": "<ISO>"
}
```

#### Scenario: Stats reflect a recent ingest

- **GIVEN** the daemon just ingested 500 events
- **WHEN** an owner requests `GET /rc/search/stats`
- **THEN** `documentCount` increased by 500 vs the prior call
- **AND** `newestIndexedTs` matches the most recent event's ts

### Requirement: Operator CLI for search

The CLI SHALL expose:

- `qwen rc search query "<q>" [--kind …] [--session …] [--since
…] [--limit …] [--json]` — print hits. Default human-readable
  table with snippet, session name, kind, relative ts, score.
- `qwen rc search reindex [<sessionId>] [--detach]` — start a
  reindex; foreground mode renders a progress bar.
- `qwen rc search stats` — print diagnostics.

#### Scenario: CLI query returns same hits as HTTP API

- **WHEN** the CLI runs `qwen rc search query "oauth"` and the
  corresponding `GET /rc/search?q=oauth` is fetched
- **THEN** the two result sets are equal in `sessionId`,
  `eventId`, and order

### Requirement: Web client search modal

The web client SHALL provide a Ctrl/Cmd-K modal containing:

- A search input that calls `/rc/search` with a 300 ms debounce
  on typing OR on `Enter`.
- A kind-filter chip row (`assistant`, `user`, `tool`,
  `tool_result`, `all`).
- A results list rendering: snippet (with `<mark>` highlights
  rendered as plain bolded spans, not raw HTML); session name;
  kind chip; relative timestamp; click-to-navigate.
- A syntax help affordance documenting accepted operators.

For share-scope tokens, the modal MUST disable the kind filter
and MUST NOT show the session list (the share is locked to one
session, which is implicit).

#### Scenario: Click on result navigates to the event

- **GIVEN** a hit with `sessionId=S, eventId=42`
- **WHEN** the user clicks it
- **THEN** the web client navigates to
  `/ui/session/S?event=42`
- **AND** the chat surface scrolls event 42 into view

### Requirement: Terminal client `:search` slash

The terminal client SHALL provide a `:search <query>` slash that
opens a scrollable results pane. Up/down arrow keys select a hit;
Enter detaches from the current session and attaches to the hit's
session at the hit's event. `q` exits the pane without
navigating.

#### Scenario: Search → attach flow

- **WHEN** the user runs `:search oauth` and selects a hit in
  session `S2`
- **THEN** the terminal client detaches from the current session
  and attaches to `S2` scrolled to the hit's event
