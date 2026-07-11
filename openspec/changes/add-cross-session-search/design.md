# Design — add-cross-session-search

## Context

`add-remote-control` produced per-session JSONL transcripts as the
canonical history layer, with the daemon as a thin runtime over
them. Search has historically been a missing layer: the JSONL is
human-readable, but not queryable at workspace scale. Operators
fall back to shell tools (`rg`, `jq`) for any retrospective
lookup, which (a) doesn't surface ranking, (b) doesn't respect the
scope model, (c) duplicates effort across clients (web vs
terminal), and (d) returns nothing useful without intimate
knowledge of the file format.

The right primitive is a full-text index maintained by the daemon
itself, queryable over HTTP, with scope filtering baked in. SQLite
FTS5 is a pragmatic choice: bundled with sqlite-the-runtime
everybody already has, BM25 ranking, snippet generation, simple
operators, no external dependencies.

This is per-daemon. Cross-daemon search is the multi-workspace
client's problem (it queries each daemon independently and merges).
Keeping search single-daemon avoids cross-process coordination,
identity federation, and trust transitivity issues that would
otherwise have to be designed.

## Goals / Non-Goals

**Goals:**

- Fast retrospective lookup across all sessions in a workspace.
- Ranked results with snippets.
- Scope-respecting: tokens see results only for sessions they have
  scope on.
- Incremental: index updates within seconds of a JSONL line being
  written.
- Survives daemon restart: index is on disk; no rebuild on startup
  unless flagged.
- Bounded storage with a documented eviction policy.
- Reindexable on demand without taking the daemon offline.
- Same query API used by terminal client, web client, and
  multi-workspace client.

**Non-Goals:**

- Cross-daemon coordination.
- Semantic / vector embeddings.
- Regex queries.
- Search of workspace files (operator's code on disk). Different
  problem.
- Live as-you-type latency goals. ~300 ms post-debounce is fine.
- Edits to the underlying JSONL through the search interface (the
  index is read-only from the operator's perspective).
- A search-driven UI for _navigating_ a single session (existing
  per-session scroll already does that).

## Architecture

```
   Daemon
   ──────
   ┌────────────────────────────────────────────────────────────┐
   │ JSONL files (canonical)                                    │
   │   ~/.qwen/projects/<sanitized-cwd>/chats/<sid>.jsonl   ◄─┐ │
   └─────────────────────────────────────────────────────────┼─┘
                                                             │
                                                             │ writes
   ┌─────────────────────────────────────────────────────────┼─┐
   │ Session manager (existing)                              │ │
   │ - appends to JSONL on each event                        │─┘
   │ - emits SSE event_committed { session_id, event_id }    │
   └────────────────────────────┬────────────────────────────┘
                                │
                                │ direct in-process call
                                │ (no fs-watch latency penalty)
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │ Search ingestion worker                                 │
   │   - subscribes to event_committed                       │
   │   - batches up to 100 events or 250 ms                  │
   │   - INSERT INTO documents/FTS                            │
   │   - idempotent on (session_id, event_id)                │
   │   - on disk: ~/.qwen/rc/search/<cwd-hash>.db            │
   │   - additional fsnotify watcher on .jsonl files          │
   │     for out-of-band edits (debounced 2 s, re-indexes      │
   │     affected lines)                                      │
   └─────────────────────────────────────────────────────────┘

   GET /rc/search?q=…&kind=…&sessionId=…&since=…&limit=…
        │
        ▼
   ┌─────────────────────────────────────────────────────────┐
   │ Search query handler                                    │
   │   1. parse + validate q (FTS5 syntax-check)              │
   │   2. compute visibleSessionIds for caller's token        │
   │       - owner: all sessions in workspace                 │
   │       - share: [session_lock_id]                         │
   │       - other: token_session_history lookup              │
   │   3. SQL: SELECT … FROM documents JOIN fts USING(rowid)  │
   │       WHERE session_id IN (:visible)                     │
   │         AND fts MATCH :q                                 │
   │         AND ts >= :since                                 │
   │         AND kind = :kind                                 │
   │       ORDER BY bm25(fts) ASC LIMIT :limit                │
   │   4. snippet(fts, …) for each hit                        │
   │   5. project: { sessionId, eventId, ts, kind, snippet,    │
   │                  score, sessionName }                     │
   └─────────────────────────────────────────────────────────┘
```

## Index schema

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- documents: one row per indexed event
CREATE TABLE documents (
  rowid       INTEGER PRIMARY KEY,
  session_id  TEXT    NOT NULL,
  event_id    INTEGER NOT NULL,
  kind        TEXT    NOT NULL,  -- 'assistant' | 'user' | 'tool' | 'tool_result'
  ts          INTEGER NOT NULL,  -- unix epoch ms
  text        TEXT    NOT NULL,  -- canonicalised searchable text
  UNIQUE (session_id, event_id)
);
CREATE INDEX idx_documents_session   ON documents(session_id);
CREATE INDEX idx_documents_ts        ON documents(ts);
CREATE INDEX idx_documents_kind      ON documents(kind);

-- FTS5 virtual table, content-less for size; we manage content
-- explicitly via triggers to keep `text` in sync.
CREATE VIRTUAL TABLE fts USING fts5(
  text,
  content='documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO fts(fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO fts(fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE token_session_history (
  token_id    TEXT    NOT NULL,
  session_id  TEXT    NOT NULL,
  first_seen  INTEGER NOT NULL,
  PRIMARY KEY (token_id, session_id)
);

CREATE TABLE session_meta (
  session_id  TEXT PRIMARY KEY,
  name        TEXT,
  ended       INTEGER NOT NULL DEFAULT 0,
  first_ts    INTEGER,
  last_ts     INTEGER
);
```

## Text canonicalisation

Each JSONL event becomes one `documents.text` value. The
canonicalisation step:

- `user` text: the raw user message.
- `assistant` text: the raw text (without tool call envelope).
- `tool` (call): `<tool name> <args canonicalized to flat space-
separated string with JSON path hints, e.g.,
"edit_file path=src/auth/login.ts line_start=45 line_end=67">`.
  Args that are large blobs are truncated at 4 KiB.
- `tool_result`: a short outcome description, e.g., `ok`, `error
<stderr first 4 KiB>`. Big files indexed are truncated.

The transformation is implemented in
`packages/cli/src/serve/remoteControl/search/canonicalize.ts` and
unit-tested. Canonicalisation is deterministic — reindexing the
same JSONL produces byte-identical `text` values.

## Permission filtering

The `visibleSessionIds` set for a caller is computed once per query:

| Scope     | Visible sessions                                                  |
| --------- | ----------------------------------------------------------------- |
| `owner`   | All sessions in the workspace                                     |
| `write`   | Sessions where this token has an entry in `token_session_history` |
| `approve` | Same as `write`                                                   |
| `read`    | Same as `write`                                                   |
| `share`   | The single `session_lock_id` only                                 |
| `bridge`  | Sessions the bridge has subscribed to (history table)             |

`token_session_history` is updated on first attach to any
session's events. The first SSE subscribe inserts a row; this is
cheap and idempotent.

Queries are SQL-parameterised with the visible set; no result
leaks past the filter even on operator queries that try to
specify `sessionId=<not_visible>` (the filter is a hard AND, not
a fallback).

## Query syntax

FTS5 native, with operator escaping. Accepted features:

- Single terms: `oauth`
- Phrase: `"oauth refresh"`
- Boolean: `oauth AND error`, `error OR exception`,
  `db NOT migration`
- Prefix: `oauth*`
- Parens: `(oauth OR auth) AND error`

Rejected:

- Regex: characters `[ ] { } /` outside phrase quotes → 400 with
  code `query_unsupported`.
- Column qualifiers (`text:foo`): not supported; FTS schema has
  one column.
- Very long queries (> 1024 chars): 400 with code `query_too_long`.

## Eviction policy

Hard cap on the SQLite database size (default 256 MiB).
Configurable via `~/.qwen/rc/config.toml`:

```toml
[search]
maxIndexBytes = 268435456  # 256 MiB
evictMarginBytes = 67108864  # 64 MiB; eviction frees at least this much
```

When the file exceeds `maxIndexBytes`, an eviction pass runs:

1. Score each session by `(now - last_ts)`; oldest first.
2. Delete `documents` rows for those sessions (triggers cascade to
   FTS).
3. Stop once at least `evictMarginBytes` is freed.
4. Vacuum.

Evicted sessions remain in `session_meta` (so we know they
existed) with an `evicted_at` timestamp. Their JSONL files are
**not** touched. Subsequent searches return zero hits from those
sessions until the operator runs `qwen rc search reindex
<sessionId>` to bring them back.

## Reindex

`POST /rc/search/reindex { sessionId? }` (owner-only) drops and
rebuilds:

- If `sessionId` present: delete `documents` rows for that
  session, then re-tokenise its JSONL line by line.
- If absent: drop the whole `documents` and `fts` content, then
  walk every JSONL in the workspace.

The operation runs in a background task; while in progress, the
endpoint returns `202 Accepted` with a job id; status is queryable
via `GET /rc/search/reindex/:jobId`. Searches against a partially-
reindexed database still work — they just return whatever is
currently indexed.

CLI surface: `qwen rc search reindex [<sessionId>]` blocks until
the job completes (with a progress bar) or returns immediately
if `--detach`.

## Decisions

### D1 — SQLite FTS5 over external search engine

**Choice**: Use SQLite's bundled FTS5 module. One file, no daemon,
no JVM, no separate process to manage.

**Alternative considered**: Embed Tantivy (Rust), or run a sidecar
Meilisearch / Typesense.

**Why**: The scale is tiny — at most a few hundred MiB of text
per workspace, queried interactively by one human. FTS5 is fast
enough (BM25 ranking, snippet support, sub-50 ms queries for
realistic corpora) and adds zero operational burden. The
`add-remote-control` daemon already links sqlite for the token
store; no new dependency.

**Cost**: FTS5 lacks some niceties (no per-language stemming, no
vector search). Acceptable; we noted those in non-goals.

### D2 — Ingest from session manager in-process, not from

fsnotify only

**Choice**: The primary ingestion path is a direct subscription
to the session manager's event-committed signal. fsnotify is a
secondary path that catches out-of-band edits.

**Alternative considered**: fsnotify only.

**Why**: fsnotify-only has latency (debounce delay), reliability
gaps (some filesystems batch or miss events), and requires
diffing the file to find the new bytes. In-process gives sub-
second indexing latency for the common case where the daemon
itself writes the JSONL. fsnotify is the safety net for human
edits or external writers.

**Cost**: Two ingest paths to keep idempotent. Helped by the
`UNIQUE (session_id, event_id)` constraint.

### D3 — Scope-based filtering on `token_session_history`, not

on per-session ACL

**Choice**: A token can search sessions it has attached to.
Attachment history is recorded on first SSE subscribe.

**Alternative considered**: Per-session ACL where the owner
explicitly grants read access to specific sessions.

**Why**: Attachment history is a natural proxy for "this user has
seen this session." It's automatic — no extra UX. It's also
historically accurate: a token revoked tomorrow doesn't lose
search visibility on what it did see (mirroring the audit log's
behaviour).

**Cost**: A token that briefly attached and never came back can
still search that session. Mitigation: the owner can revoke and
delete tokens; the history table is keyed by token id and
removable.

### D4 — FTS5 query syntax exposed directly

**Choice**: Pass user query through to FTS5 with light
validation. Document the syntax for operators.

**Alternative considered**: A custom query language that we
translate to FTS5.

**Why**: FTS5's syntax is small and intuitive; reinventing it is
make-work. We do guardrail it (reject regex chars, length limit)
to avoid surprising syntax errors and quote injection.

**Cost**: Some users expect Google-style implicit AND; FTS5
defaults to that. Some users expect regex; we reject. Documented.

### D5 — Eviction by session, not by row age

**Choice**: When the cap is hit, evict whole sessions (oldest
first) rather than individual rows.

**Alternative considered**: Evict the oldest rows regardless of
session.

**Why**: Partial-session indexing produces confusing results
("why does this session show 3 hits but I remember 30?"). Whole-
session eviction is honest: the session is either fully indexed
or it isn't. The UI can render "Not in index — run `qwen rc
search reindex <id>` to include this session" for evicted
sessions.

**Cost**: A single huge session can't be partially trimmed.
Bounded by JSONL size in practice.

### D6 — JSONL is the source of truth; index is derived

**Choice**: The index is always rebuildable from JSONL. JSONL is
canonical.

**Alternative considered**: Index stores extracted text
authoritatively; JSONL becomes secondary.

**Why**: Two reasons: (a) JSONL was already the canonical store
from `add-remote-control`'s point of view, and upstream
`qwen --resume` depends on it; (b) keeping the index disposable
means corruptions, schema upgrades, and operator mistakes are all
recoverable by reindex. The whole point of derived data is to be
re-derivable.

**Cost**: Reindex is non-trivial for very large workspaces (≈ 1 s
per MiB of JSONL on a modern disk). Acceptable; rare operation.

### D7 — In-process query handler, not a subprocess

**Choice**: Run the query handler in the daemon's main process.

**Alternative considered**: Spawn a child process per query for
isolation.

**Why**: FTS5 query latency is in milliseconds and CPU bounded.
Subprocess overhead dwarfs query time. The whole daemon already
runs queries against its own SQLite (the tokens store); adding
the search DB is symmetric.

**Cost**: A pathological query could in theory pin a thread.
Mitigation: query length cap, a per-query timeout (default
2 s, configurable).

## Persistence

| Artifact                                    | Format      | Notes                                           |
| ------------------------------------------- | ----------- | ----------------------------------------------- |
| `~/.qwen/rc/search/<sanitized-cwd>.db`      | SQLite+FTS5 | One per workspace. Single file.                 |
| `~/.qwen/rc/config.toml` `[search]` section | TOML        | Eviction knobs, query timeout, debounce window. |
| Reindex job state                           | In-memory   | Restart resets jobs (callers retry).            |

## Threat model

| Attacker                              | Capability                                | Mitigation                                                                            |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Read-scope token enumerates sessions  | Discover sessions by snippet leak         | Hard filter on `token_session_history`; sessions never attached → never searchable.   |
| Share-token searches across workspace | Bypass session lock                       | `visibleSessionIds = [session_lock_id]`; SQL hard filter.                             |
| Malicious query DoS                   | Pathological regex-like patterns          | FTS5 syntax only; query length cap; per-query timeout 2 s.                            |
| Reindex run while serving             | Lock contention                           | SQLite WAL mode; reads don't block reindex's writes; reindex batches in transactions. |
| Index leak via backup                 | `*.db` file exfil reveals all transcripts | Same threat surface as JSONL itself; index doesn't add a new surface.                 |
| Disk fill via large session corpus    | DOS                                       | `maxIndexBytes` cap + automatic eviction.                                             |
| Out-of-band edits to JSONL            | Cached index lies                         | fsnotify watcher re-indexes affected lines; reindex CLI for forceful refresh.         |
| Snippet leaks sensitive content       | Result snippet shows secret               | Out of scope to redact; operator's responsibility. Document this.                     |

## Risks / Trade-offs

| Risk                                  | Likelihood | Impact | Mitigation                                                                                                   |
| ------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| Ingestion lag during heavy load       | M          | L      | Batching with 250 ms / 100-event window keeps throughput high; debug counter exposed via `/rc/search/stats`. |
| FTS5 query syntax surprise            | M          | L      | Documented; the modal shows syntax help.                                                                     |
| Index corruption                      | L          | M      | Reindex is the recovery path; SQLite WAL mode reduces corruption risk.                                       |
| Sensitive content surfaced in snippet | M          | M      | Documented operator responsibility; no automatic redaction.                                                  |
| Token history table grows unbounded   | L          | L      | Pruned on token revoke + 30-day GC of orphaned rows.                                                         |
| fsnotify on macOS / WSL flakiness     | M          | L      | Direct in-process ingest is primary; fsnotify is fallback only.                                              |

## Open questions

1. **Should we expose `kind: tool_args` separately from `kind:
tool`?** Many searches want to find tool calls by _name_ but
   not by _args_. v1: combine into `tool`; revisit.

2. **Should bridge-scope tokens (from `add-bridge-protocol`) be
   able to search?** They have `write+approve+read`; by the table
   above, they would see sessions in `token_session_history`. The
   sub-actor doesn't get to search on its own behalf — only the
   bridge does, with bridge-wide visibility. Documented in spec.

3. **Should we support `--explain` or `--score-debug` for the CLI
   `qwen rc search query`?** Useful for tuning. v1 prints score
   alongside the snippet; further introspection is deferred.

4. **Stemming and language model.** FTS5's default `unicode61`
   tokeniser doesn't stem. For English-heavy users this is fine
   ("oauth\*" prefix covers plurals). Internationalisation is
   open; revisit if real users hit pain.

5. **Should `since` accept eventId as well as ISO timestamp?**
   Useful for "everything after a known point." v1: ISO only;
   eventId is per-session anyway.

6. **Snippet length and HTML escaping.** Default snippet 64 tokens
   on each side with `[…]` ellipsis; HTML-escaped before return.
   Operators rendering custom UIs should treat snippets as plain
   text.
