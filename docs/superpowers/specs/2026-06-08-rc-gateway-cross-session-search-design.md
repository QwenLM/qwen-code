# Remote-Control Gateway — Cross-Session Search Core (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 19)
**Scope:** Owner-only full-text search over the workspace's session transcripts via
an on-demand scan of the on-disk JSONL files. The core of `add-cross-session-search`.
Builds on cycle 10 (capabilities → workspaceCwd).

## Deviation / context

Proposal builds a persistent SQLite FTS5 index (BM25) with incremental fsnotify
ingestion inside the daemon, plus per-token permission filtering. We deviate (zero
upstream edits): the gateway reads the **same on-disk JSONL transcripts the daemon
already writes** (`~/.qwen/projects/<encoded-cwd>/chats/<sessionId>.jsonl`) and
scans them on demand. No index, no new dependency, no daemon coupling — appropriate
for the homelab scale (dozens–hundreds of sessions). FTS5/persistent index, ranking
(BM25), incremental ingestion, the web Cmd-K modal, and non-owner permission
filtering are **deferred**.

This cycle is fully unit-testable with synthetic JSONL fixtures — no live daemon or
model turn needed.

## This cycle's scope (and deferrals)

**In:** `searchTranscripts(chatsDir, query, opts)` (parse JSONL, AND-match terms,
return ranked-by-recency hits with snippets); `resolveChatsDir(workspaceCwd)`;
owner-gated `GET /rc/search`; `search_performed` audit (count only, never the query
text).

**Deferred:** SQLite FTS5 + BM25 + persistent/incremental index; FTS5 boolean/phrase/
prefix syntax (MVP = case-insensitive AND of whitespace terms); non-owner/
attachment-history permission filtering + share-token-locked filtering (MVP is
**owner-only**); reindex CLI; storage caps; the web search modal.

## Decisions

1. **On-demand scan, owner-only.** `GET /rc/search` is gated by `requireScope(
OWNER)`. Transcripts can contain anything; restricting search to the owner is the
   safe MVP. (Non-owner attachment-scoped search is a later slice.)
2. **JSONL record shape** (from the daemon's `ChatRecordingService`): each line is
   `{ uuid, parentUuid, sessionId, timestamp(ISO), type:'user'|'assistant'|
'tool_result'|'system', cwd, message?:{ role, parts?:[{ text? }] } }`. Searchable
   text = the concatenation of `message.parts[].text` (whitespace-collapsed).
   Corrupt/non-JSON lines are skipped.
3. **Query = case-insensitive AND of whitespace-separated terms.** A record matches
   if its text contains every term. (Phrase/boolean/prefix → later.)
4. **Kind filter** maps `user→'user'`, `assistant→'assistant'`, `tool→'tool_result'`,
   `all→any`. Default `all`.
5. **Recency-ranked, snippet'd.** Hits sorted by `timestamp` desc; `limit` default
   50, cap 200. Each hit carries a ≤200-char single-line snippet centered on the
   first matched term.
6. **Path resolution:** `resolveChatsDir(cwd) = ~/.qwen/projects/<cwd with every
'/' and '.' replaced by '-'>/chats` (the observed encoding). A missing dir →
   empty results (no throw).
7. **Audit `search_performed { kind, resultCount }`** — NEVER the query text (it
   may contain sensitive terms).

## Components

### `src/search/transcripts.ts` — new

```ts
export interface SearchHit {
  sessionId: string;
  eventId: string; // the record uuid
  kind: string; // record.type
  ts: string; // ISO timestamp
  snippet: string; // <=200 chars, single line
}
export interface SearchOptions {
  kind?: string;
  sessionId?: string;
  limit?: number;
}
export function resolveChatsDir(workspaceCwd: string): string;
export function searchTranscripts(
  chatsDir: string,
  query: string,
  opts?: SearchOptions,
): Promise<SearchHit[]>;
```

- `searchTranscripts`: `readdir(chatsDir)` for `*.jsonl` (missing dir → `[]`); for
  each file, read + split lines; parse each as a record (skip on JSON error); derive
  `text` from `message.parts[].text`; apply `sessionId` filter (record.sessionId) and
  `kind` filter (record.type) when set; lowercase-AND-match the terms; on match push
  a hit with a snippet. Sort `ts` desc, clamp to `limit` (default 50, max 200).
- `snippet(text, firstTerm)`: collapse whitespace; find the term (case-insensitive);
  take a window of ~160 chars centered on it; prefix/suffix `…` when truncated; hard
  cap 200.

### Route `src/routes/search.ts` — new

`createSearchRoute(resolveDir: () => Promise<string | undefined>, audit?):
RequestHandler` for `GET /rc/search`:

- Parse `q` (required, non-empty after trim → else `400 invalid_query`), `kind`
  (validate ∈ {user,assistant,tool,all} default all → else 400), `sessionId`
  (optional), `limit` (parse int, default 50, clamp 1..200).
- `const dir = await resolveDir(); if (!dir) → 200 { hits: [] }` (no workspace).
- `const hits = await searchTranscripts(dir, q, { kind, sessionId, limit })`.
- audit `search_performed { kind, resultCount: hits.length }`.
- `200 { hits }`.

### Audit (`src/auditLog.ts`)

Add `'search_performed'` to the union + `AUDIT_ACTIONS`.

### Wiring (`src/server.ts`)

`app.get('/rc/search', requireScope(OWNER, audit), createSearchRoute(async () => {
try { const caps = await deps.daemon.capabilities(); return caps.workspaceCwd ?
resolveChatsDir(caps.workspaceCwd) : undefined } catch { return undefined } },
audit));`

(Resolver swallows daemon errors → empty results, never 500.)

## Error model

| Condition                  | Response                 |
| -------------------------- | ------------------------ |
| Missing/empty `q`          | `400 invalid_query`      |
| Bad `kind`                 | `400 invalid_kind`       |
| Non-owner                  | `403 insufficient_scope` |
| No workspace / missing dir | `200 { hits: [] }`       |
| OK                         | `200 { hits }`           |

## Testing strategy (TDD)

**`transcripts.test.ts`** (write JSONL fixtures to a temp dir):

- a record whose assistant text contains "oauth flow" → matched by `q=oauth flow`
  (AND of terms), snippet contains the term; `q=oauth missing` (a term absent) → no
  hit (AND semantics).
- `kind=user` returns only user records; `kind=tool` maps to tool_result.
- `sessionId` filter restricts to one session.
- corrupt line skipped; missing dir → `[]`; `limit` clamps; recency sort (newer ts
  first).
- snippet ≤200 chars, single line (newlines collapsed).
- `resolveChatsDir('/home/u/proj')` → `…/.qwen/projects/-home-u-proj/chats`;
  `'/home/u/.x'` → `-home-u--x`.

**`routes/search.test.ts`** (mini app, injected OWNER rcClient, injected resolveDir
→ a fixture dir): `q` hit → 200 {hits} + audit search_performed{kind,resultCount}
(no query text in the audit); missing q → 400; bad kind → 400; resolveDir→undefined
→ 200 {hits:[]}.

**`server.test.ts`**: owner token → `GET /rc/search?q=x` → 200 {hits:[]} (real
daemon stub has no transcripts); non-owner → 403.

**e2e:** owner token → `GET /rc/search?q=test` against the real daemon → 200 with a
`hits` array (likely empty for the e2e workspace). (Pure gateway read.)

## Privacy / security

- Owner-only. Snippets return transcript content to the owner, who already has full
  session access — no new exposure.
- The audit never stores the query text (only kind + count) — a search term could
  itself be sensitive.
- Path traversal: `sessionId`/`kind`/`q` never build a filesystem path; only
  `resolveChatsDir(workspaceCwd)` (from the trusted daemon capability) does, and it
  encodes the whole cwd into a single dir segment.

## File boundary

All within `packages/rc-gateway/`. New: `src/search/transcripts.ts` (+test),
`src/routes/search.ts` (+test). Modified: `src/auditLog.ts` (1 action), `src/server.ts`
(wire), `src/index.ts` (exports), `src/server.test.ts`, `scripts/rc-gateway-e2e.mjs`.
Zero upstream edits.

## Follow-on

Later slices: a persistent SQLite FTS5 index + incremental ingestion for scale +
BM25 ranking + boolean/phrase/prefix syntax; non-owner attachment-scoped + share-
locked permission filtering; the web Cmd-K search modal; reindex CLI. Then the next
proposal.
