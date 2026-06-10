# Cycle 32 — Search query: parenthesised grouping + length cap — design

## Context

`add-cross-session-search` design.md ("Query syntax", line 208) lists the
accepted grammar: single terms, `"phrase"`, boolean `AND`/`OR`/`NOT`, prefix
`term*`, and **parens `(oauth OR auth) AND error`**. Cycle 27 shipped all of
these EXCEPT parens (its plan was a flat disjunction-of-conjunctions —
top-level `OR`, implicit `AND`, no nesting). This cycle adds parenthesised
grouping. It also adds the **query length cap** the threat table (line 412)
calls for (`> 1024 chars → 400`), which cycle 27 never implemented.

Binary `NOT` (`db NOT migration`) already works today: `NOT` sets a pending
negation that binds to the next atom inside the implicit-AND group, so
`db NOT migration` == `db AND (NOT migration)`. No change needed there.

Field qualifiers (`text:foo`) are in the design's **Rejected** list — NOT
built (a single searchable column; the substring scanner has no fields).

## Deviation from the proposal

The proposal targets SQLite FTS5 (which parses parens natively). We have the
cycle-19 on-demand substring scanner instead, so we parse + evaluate the
grammar ourselves. Same accepted surface, gateway-clean. FTS5/BM25/index,
the per-query 2s scan timeout, and `qwen rc search` CLI stay deferred.

## Decisions

- **D1 — Evaluate a boolean AST tree directly; do NOT normalize to DNF.**
  The flat `orGroups: QueryTerm[][]` shape only existed because cycle 27's
  grammar had no nesting. Parens introduce arbitrary nesting whose natural
  form is a tree (`or` / `and` / `not` / `atom` nodes), evaluated recursively
  per record (`and` = every child matches, `or` = some child, `not` = negate,
  `atom` = substring/prefix). Tree size is O(query length); per-record eval is
  linear. This **eliminates the DNF expansion blow-up** (`(a OR b) AND (c OR d)
AND …` → 2ⁿ groups) entirely — there is no group cap / overflow fallback to
  design, and it is less code than DNF-with-cap. `QueryPlan` changes from
  `{ orGroups, seed }` to `{ node: QueryNode | null, seed }` (`null` = empty
  query → matches nothing).

- **D2 — Precedence: `OR` lowest, then `AND` (implicit between adjacent
  atoms), then `NOT`/atom/parens — exactly what the cycle-27 flat parser
  implements.** `a OR b AND c` → `a OR (b AND c)`; `a b OR c` →
  `(a AND b) OR c`. Getting this right makes **every existing query produce
  identical results**, so the cycle-27 behavioral tests pass unchanged
  (the back-compat oracle).

- **D3 — The parser stays TOTAL (never throws, never loops).** Recursive
  descent over the cycle-27 token stream, extended with `(` / `)` tokens.
  Malformed parens degrade gracefully: an unclosed `(` groups the rest; a
  stray `)` is ignored; `()`, `(NOT)`, `a AND`, `OR b`, `NOT` alone all yield
  a sane (possibly empty) plan. No exception, no infinite loop.

- **D4 — `seed` (snippet centering) stays "first non-negated atom in source
  order".** Captured during the parse (a single mutable field set on the first
  positive atom), not by post-walking the tree.

- **D5b — Bare parens are now grouping syntax; a literal paren must be
  quoted.** The spec's own example `(oauth OR auth) AND error` has no space
  after `(`, so a `(` must split off the following word — which means a
  code-search query like `getUser(` no longer matches the literal substring
  "getUser(" (cycles 19/27 treated it as one word). The escape hatch is phrase
  quoting: `"getUser("` is a phrase → literal substring, parens and all
  (phrases are captured before paren tokenization). This is the FTS5 mental
  model and is documented as an intentional deviation from the cycle-19
  substring behavior. **The deviation applies to ANY paren-bearing query, not
  just a trailing `(`** — e.g. `error(foo)` was a literal substring match and
  now parses as `error AND foo` (a false-positive widening here, since both
  substrings are still present; a query whose parenthesised sub-token does not
  also appear standalone is where results genuinely change). All queries
  WITHOUT parens are unchanged. The route's 1024-char cap also bounds parser
  recursion depth (~3 frames per `(`; V8 overflows ~2124 nested parens → ~2x
  margin) — see the note in `routes/search.ts`; do not raise it without making
  the parser iterative or adding a depth guard.

- **D5 — Query length cap is a SEPARATE, first commit, at the route.** Trimmed
  `q.length > 1024` → `400 query_too_long`. It bounds **parse/tree cost**, not
  scan cost (scan is bounded by transcript volume; the per-query 2s timeout is
  the real scan-DoS guard and stays deferred — do not overclaim). Banks a
  cheap spec-compliant win independent of the grouping work.

## Implementation & commit order

1. **Docs** (this spec + plan).
2. **Length cap (route):** `routes/search.ts` — after computing the trimmed
   `q`, `if (q.length > 1024) → 400 { code: 'query_too_long' }` (before the
   parse/scan). Tests in `routes/search.test.ts`.
3. **Parens via tree-eval (`search/query.ts`):** add `(`/`)` to `tokenize`;
   replace the flat parser with a recursive-descent boolean parser producing
   `QueryNode`; rewrite `matchesQuery` to recurse the tree; change `QueryPlan`.
   Update the two consumers: `transcripts.ts` (`plan.orGroups.length === 0` →
   `plan.node === null`; `matchesQuery`/`seed` unchanged in call shape).
   Existing `query.test.ts` behavioral assertions stay green; only assertions
   that inspect `orGroups` structurally are rewritten to assert via
   `matchesQuery` (behavioral). New tests: grouping semantics + parser totality
   on malformed parens.

## Deferred (not this cycle)

- SQLite FTS5/BM25 index + per-hit score; fsnotify ingestion watcher; storage
  cap + eviction; non-owner attachment-scoped filtering; `qwen rc search
reindex`; web Cmd-K modal; per-query 2s scan timeout; `NEAR`; the regex-char
  (`[ ] { } /`) rejection (we are not FTS5 → no injection risk; those chars are
  harmless substring literals today).

## Verification

`typecheck/lint/build/test --workspace @qwen-code/rc-gateway` +
`node scripts/rc-gateway-e2e.mjs`. New tests: `(a OR b) AND c` matches `a c` /
`b c` but not `a` / `c` alone; nested `((a OR b) AND c) OR d`; precedence
parity with the un-parenthesised form; malformed-paren totality
(`(`, `)`, `()`, `((a)`, `a)`, `(NOT)`); all cycle-27 behavioral tests
unchanged; route 400 `query_too_long` at 1025 chars, OK at 1024.
