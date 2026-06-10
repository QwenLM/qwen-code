# Cycle 32 plan — Search query: parenthesised grouping + length cap

TDD. Two green commits (no inert-then-wire ceremony — pure module already
imported by searchTranscripts; advisor: that pattern is for hot/auth paths).
All commands from repo root, absolute paths, no `--no-verify`.

## Commit 1 — docs

`docs(rc-gateway): spec+plan for search query grouping + length cap (cycle 32)`

## Commit 2 — query length cap (route)

`feat(rc-gateway): cap search query at 1024 chars (query_too_long)`

1. `routes/search.ts`: after `const q = ...trim()...` and the empty check,
   add `if (q.length > 1024) { res.status(400).json({ error: 'Query too long',
code: 'query_too_long' }); return; }`.
2. `routes/search.test.ts`: a 1025-char q → 400 `query_too_long`; a 1024-char
   q → not that error (200 or proceeds); empty still `invalid_query`.

## Commit 3 — parenthesised grouping via boolean AST

`feat(rc-gateway): support parenthesised grouping in search queries`

1. `search/query.ts`:
   - `tokenize`: emit `paren` tokens for `(` and `)` (a lone `(`/`)` is its own
     token; `(abc` → `(` then word `abc`). Keep WS-skip == word-stop predicate.
   - New `QueryNode` = `{ t: 'and' | 'or'; kids: QueryNode[] }` |
     `{ t: 'atom'; term: QueryTerm }`. `QueryTerm` unchanged (kind/value/negated).
   - Recursive descent (precedence OR < AND < atom/paren):
     `parseOr` → `parseAnd` (`OR`-split) → sequence of `parseAtom` joined by
     implicit AND; `parseAtom` handles `NOT`/`-` prefix, `(` → recurse
     `parseOr` then consume optional `)`, phrase, word (`*` prefix / plain).
     Track a cursor over tokens; EOF / stray `)` end the current level. Total:
     never throw, always advance.
   - `QueryPlan` → `{ node: QueryNode | null; seed: string }`. `seed` set to
     the first positive atom's value during parse.
   - `matchesQuery(plan, hayLower)`: `plan.node === null` → false; else
     `evalNode(node, hay)` — `and`/`or` over kids, `atom` via the existing
     `termMatch`. Keep the prefix-regex WeakMap (now keyed by the atom's
     QueryTerm).
2. `search/transcripts.ts`: `plan.orGroups.length === 0` → `plan.node === null`.
3. `search/query.test.ts`: keep all behavioral (`matchesQuery`) assertions;
   rewrite any that inspect `orGroups` structurally to assert via
   `matchesQuery`. Add:
   - `(a OR b) AND c`: matches "a c", "b c"; not "a", "c", "b".
   - precedence parity: `a OR b AND c` ≡ `a OR (b AND c)`.
   - nested: `((a OR b) AND c) OR d`.
   - totality: `(`, `)`, `()`, `((a)`, `a)`, `(NOT)`, `a AND`, `OR b`, `NOT`,
     unbalanced-deep — none throw; sane plan.
   - back-compat: an all-lowercase query with literal `(`/`)`… note `(` is now
     a token, so `foo(bar)` tokenizes as `foo` `(` `bar` `)`. Document this in
     the design as a deviation from cycle-19 (a literal paren in a query is now
     grouping syntax). Verify a plain query without parens is unchanged.

## Review + verify

- `advisor` before declaring done.
- opus adversarial review on `git diff <cycle-start>..HEAD` — dimensions:
  parser totality (no throw/loop on any malformed paren/operator input),
  precedence parity / cycle-27 back-compat, eval correctness (and/or/not
  nesting), the `foo(bar)`-now-tokenizes-as-grouping back-compat change is
  documented + acceptable, length cap placement + privacy (no q in audit),
  ReDoS-safety of the prefix regex unchanged, no new unguarded await.
- Fix + regression tests.
- From repo root: typecheck/lint/build/test + e2e. `git diff --name-only`
  shows only `packages/rc-gateway/` + `docs/superpowers/`.
- Push; update both memory files (correct the "field-scoped terms" note — spec
  rejects it; and the "NEAR" note — not in accepted grammar).
