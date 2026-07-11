# tasks — add-cross-session-search

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 1 (MVP round-trip) and
    > Phase 2 (pairing, scopes) are `completed`. Verify the
    > daemon's SQLite runtime has FTS5 enabled (sqlite ≥ 3.20,
    > built with `SQLITE_ENABLE_FTS5`). If not, document the
    > version requirement and update `add-remote-control`
    > Foundation tasks with a baseline note. Record
    > `SQLITE_VERSION=<v>` here.

## Phase 1 — Index schema and ingestion

**Effort:** ~2 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:** > Verify Phase 0 `completed`. Confirm the session manager > exposes an event-committed signal (Phase 1 of > `add-remote-control`). If it doesn't, add it and update > `add-remote-control/specs/remote-session-host/spec.md` > with a `Requirement: Event-committed signal for in-process
consumers` (drift note).

- [ ] **1.1 Index schema and migrations**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/search/schema/001_init.sql`,
    `packages/cli/src/serve/remoteControl/search/db.ts`
  - **Prompt:**
    > Implement schema per `design.md` `Index schema`. Tables:
    > `meta`, `documents` (with unique constraint), `fts` FTS5
    > virtual, triggers `documents_ai/ad/au`,
    > `token_session_history`, `session_meta`. Migration system
    > with `meta.schema_version`. Open the DB in WAL mode.
    > Acceptance: schema validates against a freshly-applied
    > migration; trigger behaviour tested with inserts and
    > deletes.

- [ ] **1.2 Canonicalisation**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/search/canonicalize.ts`
  - **Prompt:**
    > Map each JSONL event kind to a `documents.text` value per
    > `design.md` `Text canonicalisation`. Truncate per-field at
    > 4 KiB. Deterministic. Acceptance: golden-file test on a
    > corpus of 20 event shapes; outputs are byte-stable across
    > runs.

- [ ] **1.3 In-process ingest worker**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Subscribe to the session manager's event-committed signal. > Batch up to 100 events or 250 ms, whichever first. INSERT > into `documents`; idempotent via `INSERT … ON CONFLICT
(session_id, event_id) DO NOTHING`. Acceptance: load test > with 10k events/sec arrives at the index inside 1 s > end-to-end p95.

- [ ] **1.4 fsnotify fallback ingest**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Watch `<cwd>/chats/*.jsonl`. On change events (debounced
    > 2 s), compute the delta vs the highest indexed event_id for
    > that session and ingest only new lines. Acceptance: an
    > out-of-band `echo …line… >> <sid>.jsonl` becomes searchable
    > within 3 s.

## Phase 2 — Query API + permission filtering

**Effort:** ~1.5 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm scope guard exposes a
    > "lookup token session-visibility set" helper or implement
    > it inline. Decide whether bridge-scope tokens (from
    > `add-bridge-protocol`) get search; document the answer in
    > the spec.

- [ ] **2.1 Visible-sessions resolver**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/search/visibility.ts`
  - **Prompt:** > Pure function: given a token's scopes and id, return the > set of session ids visible to it. Owner: all. Share: lock > id. Else: `SELECT session_id FROM token_session_history
WHERE token_id = ?`. Acceptance: unit tests per scope.

- [ ] **2.2 `token_session_history` writer**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > On every SSE subscribe to `/session/:id/events`, upsert a
    > row in `token_session_history`. Idempotent. Acceptance: a
    > test subscribes the same token twice; row count stays 1.

- [ ] **2.3 `GET /rc/search` route**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/search/queryRoute.ts`
  - **Prompt:** > Params per spec. Validate `q` length ≤ 1024 and reject > regex chars outside phrases. Compose SQL with visible-set > filter, kind filter, ts filter, `MATCH` clause. ORDER BY > `bm25(fts)`. Compose snippets via `snippet(fts, 0, '<mark>',
'</mark>', '…', 32)` (the result is HTML-escaped plaintext > at the boundary). Acceptance: scenarios under `Requirement:
Query API`.

- [ ] **2.4 `GET /rc/search/stats` (operator diagnostics)**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Owner only. Returns: index bytes, document count, session
    > count, oldest indexed ts, newest indexed ts, ingest
    > backlog depth, last reindex job status. Useful for the
    > eviction-policy operator UX.

## Phase 3 — Reindex and eviction

**Effort:** ~1.5 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Decide whether reindex uses a
    > separate connection (write isolation) or shares the
    > primary. Default: separate connection in WAL mode so reads
    > continue uninterrupted.

- [ ] **3.1 Reindex route + background runner**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/search/reindex.ts`
  - **Prompt:**
    > `POST /rc/search/reindex { sessionId? }` → 202 Accepted
    > with `{ jobId }`. `GET /rc/search/reindex/:jobId` returns
    > `{ state, processed, total, errors }`. Job walks JSONL line
    > by line via streaming reader; deletes existing rows for the
    > affected sessions first; inserts canonicalised rows in
    > batches of 500. Owner only. Acceptance: scenarios under
    > `Requirement: Reindex`.

- [ ] **3.2 Eviction loop**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Background loop checks `PRAGMA page_count * page_size`
    > every 5 minutes. When > `maxIndexBytes`, score sessions by
    > `now - last_ts` desc, delete `documents` rows oldest-first
    > until `evictMarginBytes` is freed. VACUUM after. Set
    > `session_meta.evicted_at`. Acceptance: scenario "Eviction
    > evicts oldest whole-sessions".

- [ ] **3.3 Stale `token_session_history` GC**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Daily prune of rows where the token has been revoked > 30
    > days OR the session has been deleted. Idempotent.

## Phase 4 — Clients

**Effort:** ~2 days.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Confirm the web client's
    > modal system (or lack thereof) can host a search modal.

- [ ] **4.1 Web client Ctrl-K modal**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:**
    `packages/web-client/src/components/SearchModal.tsx`,
    `packages/web-client/src/api/search.ts`
  - **Prompt:**
    > Keyboard shortcut Ctrl/Cmd-K opens modal. Search box with
    > debounced (300 ms) calls to `/rc/search`. Result list:
    > snippet with `<mark>` highlights rendered safely, session
    > name, kind chip, relative ts. Clicking a result navigates
    > to `/ui/session/<sid>?event=<eid>` and scrolls to that
    > event. Kind filter chips (`assistant|user|tool|all`).
    > Syntax help button shows allowed operators. For share-
    > scope tokens, the kind filter and sessionId are locked.
    > Acceptance: Playwright test runs through search → click →
    > scroll.

- [ ] **4.2 Terminal client `:search` slash**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > `:search <query>` opens a scrollable results pane. Up/down
    > selects a hit; Enter jumps the attached client to that
    > session+event. `q` exits the pane.

- [ ] **4.3 `qwen rc search` CLI**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/commands/rc/search.ts`
  - **Prompt:** > Subcommands: > > - `query "<q>" [--kind …] [--session …] [--since …]
[--limit …] [--json]` — print hits. > - `reindex [<sessionId>] [--detach]` — start a reindex; on > foreground mode, render a progress bar. > - `stats` — print the diagnostics. > Output format: human table by default, JSON with `--json`.

## Phase 5 — Polish + docs

**Effort:** ~0.5 day.

- [ ] **5.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 4 `completed`. Compare every spec scenario
    > to the running daemon's behaviour; patch the delta where
    > drifted.

- [ ] **5.1 Operator docs section**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `docs/users/remote-control.md` (append)
  - **Prompt:**
    > "Searching across sessions" section: query syntax, kind
    > filters, scope rules, reindex flow, eviction policy and
    > how to raise the cap. Under 400 words.

- [ ] **5.2 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > Run `openspec archive add-cross-session-search`.

## Effort summary

| Phase     | Description                  | Estimate (days) |
| --------- | ---------------------------- | --------------- |
| 0         | Foundation                   | 0.5             |
| 1         | Schema + ingestion           | 2               |
| 2         | Query + permission filtering | 1.5             |
| 3         | Reindex + eviction           | 1.5             |
| 4         | Clients                      | 2               |
| 5         | Polish + docs + archive      | 0.5             |
| **Total** |                              | **8**           |
