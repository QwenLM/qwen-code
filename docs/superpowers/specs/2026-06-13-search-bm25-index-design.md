# BM25 full-text search index — slice 1 (cycle 88)

## Goal

Add a relevance-ranked (BM25) full-text search over a workspace's JSONL
transcripts, backed by SQLite FTS5 via the native `better-sqlite3` (user
authorized the native dep). **Slice 1 is daemon-free and CLI-only**: an index
engine + a `reindex` CLI + a `search --rank` mode. The HTTP `/rc/search` route
and the live substring scanner are UNTOUCHED — wiring an opt-in `?rank=bm25`
route mode (with the synchronous-better-sqlite3-blocks-the-event-loop concern
handled) is a deferred slice 2.

## Why this is a new mode, not a replacement

The live scanner (`transcripts.ts`) does **substring**, recency-sorted matching
with boolean/phrase/prefix operators (`parseQuery`). The index does
**BM25-ranked** matching. With the FTS5 `trigram` tokenizer the per-term
matching is case-insensitive **substring** (close to the scanner), AND-ed across
terms — but `--rank` drops the boolean/phrase/prefix operators and ranks by
relevance, not recency. So it is complementary, never a drop-in; the two share
`recordText`/`KIND_MAP` so they index/search the EXACT same content and map
`kind` identically — they differ only in ranking + operator support + the
trigram floor below.

## Tokenizer choice: `trigram` (not the default `unicode61`)

`unicode61` treats a space-less CJK run as a single token, so a substring like
`令牌` inside `令牌然后重试` would never match — unacceptable for a Qwen
(CJK-heavy) product. `trigram` indexes overlapping 3-char windows of any script,
giving case-insensitive substring matching incl. CJK. Its one limitation: a
query **term shorter than 3 chars** has no trigram and cannot match via the
index — uniform across scripts (English `ok`/`id` and 2-char CJK words like
`令牌` alike). This is documented, tested, and the `--rank` CLI prints a hint
pointing to the default scan (which has no length floor) when a short term
yields nothing. NO silent cap.

## Injection safety

A raw user query is NEVER passed to FTS5 MATCH. `toFtsMatch` splits on
whitespace, strips `"` from each term, drops terms with no letter/number
(`/[\p{L}\p{N}]/u` — any script), and wraps each survivor in double quotes so
FTS5 operators (`OR`/`NOT`/`NEAR`) and syntax chars (`*`/`(`) are inert. An
all-empty query → `null` → no results (never an FTS5 syntax error).

## Schema (single FTS5 table)

`records(body, file UNINDEXED, sessionId UNINDEXED, eventId UNINDEXED, kind
UNINDEXED, ts UNINDEXED, tsKey UNINDEXED) tokenize='trigram'`. `body` is the
searchable text (shared `recordText`); the rest are returned-with-hit metadata
and WHERE filters. `tsKey` is the epoch-ms `padStart(16,'0')` so a since/until
range compares lexically on an affinity-less FTS5 text column exactly as a
numeric compare would; an unparseable timestamp stores `''` and is excluded
whenever a bound is active (mirrors the scanner). Filters (`kind`/`sessionId`/
`since`/`until`) are WHERE clauses beside MATCH, so they behave identically to
the scanner. `truncated` is reported by over-fetching one row past the clamped
limit (no separate COUNT).

## At-rest privacy

The index is a new at-rest copy of raw transcript content (prompts, tool
output). `SearchIndex.open` creates the containing dir `0700` and the db `0600`;
any transient SQLite journal sibling lives in the `0700` dir (unreachable by
other users). The dir is keyed to the same `sanitizeCwd(cwd)` as the chats dir
(`resolveSearchIndexDir`), so two workspaces can't read each other's index.

## Native isolation

`searchIndex.ts` is the ONLY module importing `better-sqlite3`, and it is
imported solely via dynamic `await import()` from the `reindex` / `search --rank`
CLI branches — never from the barrel, the gateway app, or the e2e. So
`qwen serve` and the running gateway never load the native addon, and a
native-load failure can't take it down. The dep is `optionalDependencies` +
`MODULE_NOT_FOUND` is caught in the CLI with an actionable hint, so a failed
native build never breaks `npm install` of the gateway / `qwen serve`.

## Reindex

Full drop+rebuild in one transaction (incremental mtime reindex is a deferred
follow-up). Missing dir / unreadable file / corrupt line are skipped, never
thrown; records with empty searchable text (e.g. `custom_title` system records)
are skipped (they can never be a hit).

## Verification (daemon-free, like the search CLI)

Unit tests over fixture transcripts in a temp dir: BM25 ranks a denser match
first; `kind`(tool→tool_result)/`sessionId`/`since`/`until` filter through the
index; full-rebuild reindex picks up a changed file and drops removed rows;
0700/0600 perms; CJK substring (≥3 chars) found, <3-char floor documented;
`toFtsMatch` injection cases. Dist smoke: real `qwen rc reindex` + `search
--rank` over a temp chats dir → ranked output, dir 700 / file 600, and the plain
scan still works without loading the native addon.

## Deferred (slice 2+)

`?rank=bm25` route mode (with event-loop offload), web-UI rank toggle,
incremental mtime reindex, auto-reindex-on-staleness, boolean operators over the
index, `--json` CLI output.
