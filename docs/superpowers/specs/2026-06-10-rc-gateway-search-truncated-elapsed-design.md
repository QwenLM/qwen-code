# rc-gateway — search response `truncated` + `elapsedMs` (cycle 37)

## Context

`add-cross-session-search` spec (`specs/cross-session-search/spec.md:106-123`) — the
response SHALL be `{ hits: [...], truncated: <bool>, elapsedMs: <int> }`. Cycles
19/23/27/32/34 shipped the scanner + query language + scan-timeout, but the route
still returns only `{ hits }`. This cycle adds the two missing top-level fields.

- `truncated`: were there MORE matches than the returned `limit` (the result set
  was capped)? The scanner already collects ALL matches, recency-sorts, then
  `slice(0, limit)` — so the full match count is known before the slice.
- `elapsedMs`: wall-clock spent serving the search.

(`score` / bm25 per-hit ranking stays deferred — we are a recency-sorted
substring/boolean scanner, not an FTS5/bm25 index. Out of scope, as in cycle 19.)

## Deviation from the daemon-centric spec

The spec frames this as the daemon's `/rc/search`; we deliver it gateway-side in
the existing `routes/search.ts` + `search/transcripts.ts`. No upstream edit.

## Decisions

- **D1 — Additive via a new `searchTranscriptsDetailed`; `searchTranscripts`'s
  `SearchHit[]` contract is UNCHANGED.** Extract the scan body into
  `searchTranscriptsDetailed(chatsDir, query, opts): Promise<SearchResult>` where
  `SearchResult = { hits: SearchHit[]; truncated: boolean }`. `searchTranscripts`
  becomes a one-line delegate: `return (await searchTranscriptsDetailed(...)).hits`.
  This keeps EVERY pre-cycle caller/test byte-identical (cycle 34 chose the same
  zero-ripple discipline). `truncated = totalMatches > limit`, computed from the
  full sorted array before the `slice(0, limit)`.
- **D2 — `elapsedMs` is measured at the ROUTE, not in the scanner.** The scanner's
  cycle-34 "clock is never read unless a timeout is opted in" contract is
  preserved exactly: `searchTranscriptsDetailed` reads the clock ONLY on the
  existing deadline path. The route times its own call with
  `nowMs = opts?.now ?? Date.now`: `const t0 = nowMs(); …; elapsedMs =
Math.max(0, Math.round(nowMs() - t0))`. `Math.max(0, …)` guards a
  non-monotonic clock; `Math.round` keeps it an int per the spec. **NOTE
  (advisor): the route's injected `now` is ALSO passed to the scanner as the
  deadline clock, so a route test must NOT pin a positive elapsed via a sequence
  clock — the scanner consumes intermediate reads (deadline is on by default),
  draining the sequence → NaN. Use a CONSTANT injected `now` (scanner reads it
  repeatedly, deadline never hit, `elapsedMs = const - const = 0`) for the
  deterministic case, and a real clock for the "integer ≥ 0" wiring assertion.**
- **D3 — Timeout path is unchanged.** A `SearchTimeoutError` still maps to `503
search_timeout` (cycle 34) and carries NO `truncated`/`elapsedMs` (it's an
  error, not a result). `truncated` is strictly about the `limit` cap, orthogonal
  to the scan-time budget.
- **D4 — Audit unchanged.** Still `search_performed{kind,resultCount}` (and the
  cycle-34 `{kind,timedOut:true}` on 503). No new field, no `truncated`/`elapsedMs`
  in the audit (privacy: counts/kind only; timing is not security-relevant and
  adds nothing to the audit).

## Safety / fail-safe

- Pure-additive read-path. `searchTranscriptsDetailed` is the same pure scan as
  before (same swallow-all-I/O, same single `SearchTimeoutError` throw). The
  public `searchTranscripts` return shape and throw behavior are unchanged → zero
  ripple, the route is the only behavioral change.
- No new throw path at the route: `elapsedMs` is pure arithmetic over a total
  clock; the existing try/catch around the search call (cycle 34) still wraps the
  one throwing call.
- Fail-safe commit order: docs → refactor scanner into
  `searchTranscriptsDetailed` + `SearchResult` + barrel + detailed unit tests
  (route still calls `searchTranscripts` → INERT) → route emits
  `truncated`/`elapsedMs` LAST + route tests.

## Tests

- `searchTranscriptsDetailed`: boundary — `total === limit → truncated:false`,
  `total === limit+1 → truncated:true` (compares against the CLAMPED limit, which
  stays inside the function); `hits` identical to what `searchTranscripts` returns
  for the same args (delegation proof); a no-match query → `{hits:[],
truncated:false}` (the `plan.node === null` early return becomes
  `{hits:[],truncated:false}`, NOT `[]`).
- route: 200 body has `truncated` + integer `elapsedMs ≥ 0` (real clock, no
  injected `now` — exercises the wiring); a CONSTANT injected `now` → `elapsedMs
=== 0` (deterministic; the scanner reads the same value so the deadline never
  trips); `truncated:true` surfaces through the real route when the on-disk set
  exceeds `limit`; the 503 timeout path still omits both.

## Deferred (search, unchanged)

`score`/bm25 + SQLite FTS5 index, fsnotify ingestion watcher, non-owner
attachment-scoped filtering, storage cap+eviction, `qwen rc search reindex`
(202+jobId), web Cmd-K modal, NEAR, `config.toml [search] timeout` knob.
