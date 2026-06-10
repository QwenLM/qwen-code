# Cycle 34 — Cross-session search: per-query scan timeout (→ 503 `search_timeout`) — design

## Context

The `add-cross-session-search` spec (spec.md:130) requires: "Queries SHALL have
a per-query timeout (default 2 s); exceeded queries return `503 Service
Unavailable` with code `search_timeout`." Its threat table (design.md:412) names
this the real DoS guard against a "Malicious query DoS — pathological patterns".
Cycle 32 added the 1024-char query length cap but explicitly noted it bounds
PARSE/tree cost, not SCAN cost — the per-query timeout is the scan-DoS guard,
and was deferred. This cycle adds it.

## Deviation from the proposal

The proposal targets SQLite FTS5 (whose own query executor enforces a timeout).
We have the cycle-19 on-demand substring scanner (`searchTranscripts`), so we
enforce a wall-clock deadline across the scan loop ourselves. Same observable
contract: a query that exceeds the budget returns `503 { code:'search_timeout' }`.

## Decisions

- **D1 — Signal the timeout by THROWING `SearchTimeoutError`, not by changing the
  return type.** `searchTranscripts` keeps returning `SearchHit[]`; on deadline
  exceed it throws a typed error the route maps to 503. This avoids rippling a
  return-shape change into the cycle-19/23/27/32 callers/tests. A timeout is a
  503 ERROR response — it never rides in the success object — so this is not a
  dead-end even though the spec's SUCCESS shape later grows `truncated`/`elapsedMs`.

- **D2 — Default is NO timeout in the scanner; the `2000`ms default lives in the
  ROUTE.** `searchTranscripts(dir, q, { timeoutMs?, now? })`: when `timeoutMs` is
  absent/non-finite/≤0 there is NO deadline, NO clock reads, and the function
  NEVER throws (its existing "never throws on I/O/parse errors" contract is
  preserved for every existing caller). The throw is reachable ONLY when a caller
  opts in. `createSearchRoute` supplies `timeoutMs: 2000` (a named const;
  `config.toml [search] timeout` knob deferred).

- **D3 — Commit ordering is fail-safe AND the timeout-arg + the route try/catch
  are ATOMIC.** Commit 2 adds the scanner deadline — inert, because no caller
  passes `timeoutMs` yet, so it cannot throw into the still-uncatching route.
  Commit 3 adds BOTH `timeoutMs: 2000` to the call AND the surrounding try/catch
  in the SAME commit — splitting "pass the timeout" from "add the catch" would
  reintroduce the recurring async-route-hang bug (an uncaught throw hangs the
  request; `server.ts` has no global error middleware). A test proves inertness:
  `timeoutMs` unset + a `now()` returning a huge value → does NOT throw.

- **D4 — Deadline-check granularity: at the top of each FILE iteration + every
  ~1024 scanned lines.** Covers both many-small-files and one-huge-file. The
  `now()` clock is INJECTED (`opts.now`, default `Date.now`) so the throw is
  deterministically testable without real sleeps. `timeoutMs` guarded by
  `Number.isFinite(t) && t > 0` so NaN/Infinity/0/negative DISABLE the timeout
  (never instant-timeout-everything).

- **D5 — Honesty caveat (stated so the reviewer doesn't flag it): the deadline
  bounds SCAN/MATCH work, not a single file's `readFile`.** A pathologically huge
  single file blocks in `readFile` before any check fires. That is pre-existing
  and out of scope — transcripts are DAEMON-written, not attacker-controlled; the
  threat model the spec names is a malicious QUERY, not a malicious FILE.

- **D6 — On timeout: audit `search_performed { kind, timedOut:true }` (no
  resultCount, no query text) then 503.** Reuses the existing `search_performed`
  action (detail is free-form → NO `AuditAction`/`AUDIT_ACTIONS` change). The
  catch also has a defensive non-timeout branch → 500 (the async-route guard).

## Implementation & commit order

1. **Docs** (this spec + plan).
2. **`search/transcripts.ts` (inert):** export `class SearchTimeoutError`; add
   `timeoutMs?`/`now?` to `SearchOptions`; compute `hasDeadline`/`deadline` from
   `now()`; throw `SearchTimeoutError` at the file-loop top and every 1024 lines
   when `now() > deadline`. Default (no `timeoutMs`) path unchanged → all existing
   tests green. Tests in `transcripts.test.ts`: throws when the injected clock
   passes the deadline; does NOT throw when `timeoutMs` unset even with a huge
   clock (inertness); completes normally within budget.
3. **`routes/search.ts` (wire last, atomic):** `createSearchRoute(resolveDir,
audit?, opts?: { timeoutMs?; now? })`; pass `timeoutMs: opts?.timeoutMs ?? 2000`
   and `now: opts?.now` to `searchTranscripts` INSIDE a `try`; `catch` →
   `SearchTimeoutError` → audit `{kind,timedOut:true}` + `503 {code:'search_timeout'}`;
   any other error → `500 {code:'search_error'}` if `!res.headersSent`. Tests in
   `search.test.ts`: a tiny `timeoutMs` + a jumping `now` → 503 `search_timeout`
   - the timeout audit; the normal 200 path unaffected (default 2000).

## Deferred (not this cycle)

`truncated` + `elapsedMs` success-response fields; the `config.toml [search]
timeout` knob; FTS5/BM25 index + per-hit score; fsnotify ingestion watcher;
non-owner attachment-scoped filtering; storage cap + eviction; `qwen rc search
reindex`; web Cmd-K modal; `NEAR`. Bounding a single huge file's `readFile`
(out of scope per D5).

## Verification

`typecheck/lint/build/test --workspace @qwen-code/rc-gateway` +
`node scripts/rc-gateway-e2e.mjs`. New tests per commits 2 & 3 above; all
existing search tests unchanged (default no-timeout).
