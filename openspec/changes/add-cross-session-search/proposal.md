# add-cross-session-search

## Why

A workspace accumulates sessions over time — debugging runs,
feature spikes, daily standups with the agent. Each is a separate
JSONL transcript at `~/.qwen/projects/<cwd>/chats/<sessionId>.jsonl`.
After a few weeks, the operator has dozens; after a quarter,
hundreds. Finding "the conversation where we figured out the OAuth
flow" is an unscalable mix of `grep`, JSONL line counts, and
guesswork.

Upstream qwen-code has no cross-session search. Each session is a
file; there's no index, no ranking, no query language. The web
client (`add-remote-control` Phase 4) renders a per-session
transcript and nothing more. The terminal client likewise.

This change adds a first-class search over all transcripts in a
workspace, indexed by the daemon, queryable by a JSON API, with
relevance ranking, snippets, and scope-respecting result filtering.
It is intentionally **per-daemon** (one daemon = one workspace per
`add-remote-control` D6); cross-daemon aggregated search is in
`add-multi-workspace-client`.

## What Changes

- **New search index.** SQLite database at
  `~/.qwen/rc/search/<sanitized-cwd>.db` using FTS5 (BM25 ranking).
  Tables: `documents(session_id, event_id, kind, ts, text)` with a
  matching FTS5 virtual table on `text`.
- **Incremental ingestion.** The daemon watches each session's
  JSONL via `fsnotify` (debounced, batched). New JSONL lines are
  tokenised by `kind` (assistant text, user text, tool name +
  args, tool result outcome) and inserted into the index. The
  watcher restarts cleanly across daemon restarts; ingestion is
  idempotent on `(session_id, event_id)`.
- **Query API `GET /rc/search`.** Params: `q` (required), `kind`
  (`assistant|user|tool|all`, default `all`), `sessionId` (filter),
  `since` (ISO timestamp), `limit` (default 50, max 200). Returns
  ranked hits with snippet, sessionId, eventId, ts, kind, score.
- **Permission filtering.** Owner sees results across the entire
  workspace. Non-owner tokens see only sessions they have an
  active or historical attachment to (recorded via a small
  `token_session_history` table maintained on first attach).
  Share-scope tokens see only their locked session.
- **Operators.** FTS5 query syntax with phrase quoting, simple
  boolean (`AND`, `OR`, `NOT`), prefix wildcard (`oauth*`). Not
  regex. The daemon validates queries and emits clear errors for
  malformed input.
- **Reindex command.** `qwen rc search reindex` drops and rebuilds
  the index from JSONL. Useful when files have been edited out-of-
  band or when migrating after upgrading the index schema.
- **Bounded storage.** Hard cap on index size (default 256 MiB);
  oldest indexed sessions are evicted from the index when the cap
  is hit. JSONL files on disk are **not** deleted — only the FTS
  rows. A reindex can bring them back if the cap is raised.
- **Search modal in clients.** Web client adds a `Ctrl/Cmd-K`
  modal with search box, kind filter chips, and ranked results.
  Each hit is a clickable link that opens the session at that
  event. Terminal client adds a `:search` slash that displays
  results in a scrollable pane.

## Capabilities

### New Capabilities

- `cross-session-search` — per-workspace FTS5 index, ingestion
  watcher, query API with operators and permission filtering,
  reindex command, storage cap with eviction policy, client UX
  hooks.

## User Stories

**X1. "Where did we talk about that?"** Operator opens the web
client, hits Ctrl-K, types `oauth refresh AND error`. Three hits
appear, ranked, with snippets. Clicks the top one → opens that
session scrolled to the relevant event.

**X2. Filter by tool calls only.** Operator wants every time the
agent ran `bash` involving `git push`. Searches `"git push"` with
`kind: tool`. Sees the four sessions where this happened.

**X3. Audit-aware filtering.** A read-scope teammate searches
`secrets` from their browser. They get results only from sessions
they were attached to (never the operator's other sessions);
sessions they've never seen don't appear in their result list at
all (not even as "you don't have access").

**X4. Share-token search lockdown.** A share-token guest opens
Ctrl-K. The search box is present but the kind filter is locked,
and the only session searchable is the share's locked session.
Confusion-free.

**X5. Reindex after weird edit.** Operator manually edited a JSONL
to redact a leaked secret. Runs `qwen rc search reindex
<sessionId>` to refresh that one session's index entries. The
redacted text disappears from search results.

**X6. Eviction.** After a year of heavy use, the index hits its
256 MiB cap. The daemon evicts the oldest 64 MiB worth of
sessions' rows. Next search excludes those sessions; the operator
can reindex explicitly if they need them back.

## Impact

- **qwen-code repo**: new module
  `packages/cli/src/serve/remoteControl/search/` with the FTS5
  schema, ingestion watcher, query route. New CLI subcommand
  `qwen rc search {query, reindex, stats}`. Web client gets a
  search modal; terminal client gets a `:search` slash.
- **Storage**: one SQLite database per workspace under
  `~/.qwen/rc/search/`. JSONL files are read-only inputs; the
  index is derived and rebuildable.
- **Permission model**: piggybacks on the existing scope system
  plus a new `token_session_history` table tracking which token
  has attached to which session.
- **Independent from share/fork/multi-workspace**: this is a
  per-daemon feature. Cross-daemon search is in
  `add-multi-workspace-client` and works by querying each daemon
  independently and merging client-side.
- **Out of scope** (deliberately):
  - Semantic / vector search. FTS5 keyword search only. A future
    `add-embedding-search` could add embeddings.
  - Search across daemons (multi-host). Belongs to
    `add-multi-workspace-client`.
  - Regex. FTS5 doesn't support arbitrary regex; we don't try to
    bolt it on.
  - Full-text search of files in the workspace (the operator's
    code). Different problem, different index.
  - Live "as you type" autocomplete with sub-50 ms latency. The
    modal queries on submit (or 300 ms debounce on typing); we
    don't aim for IDE-grade speed.
  - Real-time index of in-flight tool args partway through a
    streaming call. We index on event terminal-state (matches
    JSONL line write).
