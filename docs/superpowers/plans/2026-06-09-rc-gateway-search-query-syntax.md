# Plan — search query syntax (cycle 27, add-cross-session-search operators)

Spec: `../specs/2026-06-09-rc-gateway-search-query-syntax-design.md`. TDD, two
commits, pure module inert first.

## Commit 1 — pure query parser/matcher (inert)

1. `src/search/query.ts`:
   - Types `QueryTerm = {kind:'plain'|'phrase'|'prefix'; value:string;
negated:boolean}`, `QueryPlan = {orGroups: QueryTerm[][]; seed: string}`.
   - `tokenize(q)` → `{type:'word'|'phrase'; text}[]` (quotes → phrase-to-`"`-or-
     end; runs of non-ws/non-`"` → word).
   - `parseQuery(q)` → interpret tokens: `OR`(uppercase) splits groups (reset
     pending-negate); `AND` no-op; `NOT`/lone `-` set pending-negate; word with
     leading `-` → negated, strip; trailing `*` → prefix (drop empty stem);
     else plain. Lowercase term values + normalized phrase. Drop empty groups;
     `seed` = first non-negated term's value or `''`.
   - `matchesQuery(plan, hayLower)` → `orGroups.length>0 &&
some(group → every(term → termMatch))`. plain/phrase = `includes`; prefix =
     `new RegExp('\\b'+escape(stem)).test(hay)`; negate flips. Escape helper.
2. `src/search/query.test.ts`: plain AND; phrase; prefix word-boundary
   (`oauth*` matches `oauthToken`, not `reoauth`); `-`/`NOT` negation; `NOT
"foo bar"` and `-"foo bar"`; uppercase-only (`error or warning` → 3 plain
   terms, not OR); OR groups; `oauth* OR token`; `a "b c" OR -d`; all-negation
   group; empty/`*`/`OR`-only → no groups; back-compat (`'a b'` plan == two
   plain AND terms).
3. typecheck/lint/build/test. Commit:
   `feat(rc-gateway): pure search query parser (phrase/OR/NOT/prefix, inert)`

## Commit 2 — wire into searchTranscripts

4. `transcripts.ts`: `const plan = parseQuery(query); if (!plan.orGroups.length)
return [];` replace `terms.every(...)` with `matchesQuery(plan, hay)`; snippet
   uses `plan.seed`.
5. `transcripts.test.ts`: keep all existing (back-compat) + add end-to-end
   phrase / OR / NOT / prefix cases against fixtures.
6. typecheck/lint/build/test + e2e. Commit:
   `feat(rc-gateway): /rc/search honors phrase/OR/NOT/prefix query operators`

## Then

opus review (parser edge cases, ReDoS-safety of the prefix regex, back-compat,
never-throws) → fix → push → update both memory files.
