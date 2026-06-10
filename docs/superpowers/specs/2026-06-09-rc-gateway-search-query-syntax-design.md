# Design — rc-gateway search query syntax (cycle 27, add-cross-session-search operators)

**Proposal:** `add-cross-session-search` (core on-demand scan done cycle 19,
resolver unified cycle 23; this adds the query language).
**Date:** 2026-06-09.
**Branch:** `add-remote-control-spec`.

## Goal of this slice

Upgrade `GET /rc/search`'s query language from "AND of whitespace-separated
substrings" to the proposal's **phrase quoting + boolean `OR`/`NOT` + prefix
wildcard** (story X1: `oauth refresh AND error`). Pure, in-memory, single
module; backward-compatible (a plain space-separated query behaves exactly as
before).

## Deviation note

The proposal builds a **SQLite FTS5** index (BM25 ranking, tokenized matching)
in the daemon. We have no index — cycle 19 chose an on-demand JSONL scan
gateway-side (the daemon stays unmodified). This slice adds the **operator
grammar** on top of that scan as a pure matcher; the persistent FTS5 index,
BM25 relevance scoring, and the ingestion watcher remain deferred. So this is a
query-language upgrade, not an indexing change.

## Grammar (what we parse)

A query is a **disjunction of conjunctions**: top-level `OR` splits OR-groups;
within a group every term must match (implicit AND). A record is a hit when ANY
group fully matches.

Term kinds:

- **plain** `oauth` → case-insensitive **substring** of the record's searchable
  text (unchanged from cycle 19).
- **phrase** `"oauth refresh"` → substring of the whitespace-normalized phrase.
- **prefix** `oauth*` → matches a token **starting** with the stem, via an
  anchored `\b<stem>` regex (ASCII word boundary; stem regex-escaped → ReDoS-safe
  literal, no quantifier).
- **negated** `-term` or `NOT term` → the term must NOT match. Applies to any
  kind. A lone `-` token binds negation to a following phrase (so `-"foo bar"`
  works, as does `NOT "foo bar"`).

Operators are **UPPERCASE-ONLY**: `OR`, `NOT`, `AND` (the last a no-op, since
AND is the implicit default). Lowercase `or`/`not`/`and` are ordinary search
terms. This is deliberate (see D1) and matches FTS5, which requires uppercase
keywords.

## Decisions

### D1 — Uppercase-only operators (avoid the `not found` / `error or warning` flip)

If `not`/`or` were case-insensitive operators, the extremely common transcript
queries `not found` and `error or warning` would silently invert/relax meaning
(`NOT found` = records _lacking_ "found"; `error OR warning`). Uppercase-only
keeps every lowercase query a pure-AND substring search — preserving today's
behavior exactly — and only the explicit uppercase forms opt into boolean logic.

### D2 — Tolerant parse, never throws (fail-open for a search box)

The proposal says "the daemon validates queries and emits clear errors." For a
gateway search box we instead parse tolerantly and **never throw**: an unclosed
quote becomes a phrase-to-end; an empty stem (`*`) / empty group is dropped; an
all-empty parse yields zero groups → `searchTranscripts` returns `[]` (same as
the existing empty-query path). The route keeps its single `400 invalid_query`
guard for an empty `q`; no new error surface, no new async-throw path (consistent
with the package's recurring async-route-error discipline). Fail-open on a search
matcher means at worst odd-but-bounded results, never a hang or a crash.

### D3 — Substring plain vs word-boundary prefix (intentional asymmetry)

A plain `oauth` stays a substring match (matches `reoauth`, back-compat); a
`oauth*` is a word-boundary prefix (matches `oauthToken`, not `reoauth`). These
are NOT a subset relation — `*` is a distinct, more-precise operator, not
redundant sugar. Negation is **unary** (`-x` / `NOT x`), unlike FTS5's binary
`x NOT y`; an all-negation group (e.g. `NOT foo`) matches records lacking the
term. `\b` is ASCII-word-based.

### D4 — Single pure module, fail-safe wiring order

New `src/search/query.ts` (`parseQuery`, `matchesQuery`, types) lands FIRST with
its tests as inert code; `searchTranscripts` is repointed at it in a second
commit. A mid-cycle cut after commit 1 leaves a tested, unused parser. The seed
for snippet centering (first positive term's literal, lowercased; `''` when the
query is all-negation) is returned by `parseQuery` so `searchTranscripts` keeps
its existing `snippet(text, seed)` call shape.

## Files

- New `src/search/query.ts`: `QueryTerm`/`QueryPlan` types, `parseQuery(q)`,
  `matchesQuery(plan, hayLower)`.
- New `src/search/query.test.ts`: tokenizer + interpreter + matcher, incl.
  operator-case, negated phrase, prefix, empty-stem, empty-group, and
  combination cases (`a "b c" OR -d`, `oauth* OR token`, all-negation,
  `NOT "foo bar"`), plus the back-compat claim (plain words == AND-substring).
- `src/search/transcripts.ts`: replace the `terms` AND-substring logic with
  `parseQuery` + `matchesQuery`; pass `plan.seed` to `snippet`.
- `src/index.ts`: export the new public symbols if useful (optional).

## Verification

- vitest: query.test.ts (parser/matcher units) + transcripts.test.ts stays green
  unchanged (proves back-compat) + a couple of new operator integration cases on
  `searchTranscripts` (phrase, OR, NOT, prefix end-to-end against fixtures).
- `npm run typecheck|lint|build|test --workspace @qwen-code/rc-gateway`.
- `node scripts/rc-gateway-e2e.mjs` — stays green (no route/shape change; the
  query string just parses differently downstream).
- `git diff --name-only <start>..HEAD` → only `packages/rc-gateway/` + docs.

## Deferred (NOT in this slice)

SQLite FTS5 persistent index + BM25 relevance scoring + per-hit `score`, the
ingestion `fsnotify` watcher, non-owner attachment-scoped result filtering
(`token_session_history`), the storage cap + eviction, `qwen rc search reindex`,
the web Cmd-K modal. Also deferred within the grammar: parenthesised grouping,
binary `NOT`, `NEAR`, field-scoped terms, and column/weight tuning.
