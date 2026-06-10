# Cycle 34 plan — search per-query scan timeout (→ 503 `search_timeout`)

TDD. Fail-safe commit order: scanner deadline INERT (commit 2), route wiring +
catch ATOMIC (commit 3). See the design doc for D1–D6.

## Commit 1 — docs

> `docs(rc-gateway): cycle 34 spec+plan — search per-query scan timeout`

## Commit 2 — transcripts.ts: injectable deadline, throw SearchTimeoutError (inert)

Tests first in `src/search/transcripts.test.ts`:

- throws `SearchTimeoutError` when the injected `now` passes the deadline
  (temp dir with ≥1 `.jsonl`; `timeoutMs: 2000`, `now` returns `0` then a huge
  value → the file-loop-top check throws before collecting).
- INERTNESS: `timeoutMs` UNSET + a `now` that always returns a huge value →
  does NOT throw, returns hits normally (proves commit 2 can't throw into the
  still-uncatching route).
- within budget: `now` returns small increasing values < deadline → completes,
  returns the expected hits.
- (optional) `timeoutMs: NaN`/`0`/`-1` → disabled (no throw) — guards D4.

Implementation in `src/search/transcripts.ts`:

- `export class SearchTimeoutError extends Error` (name `'SearchTimeoutError'`).
- `SearchOptions` += `timeoutMs?: number`, `now?: () => number`.
- at scan start: `const clock = opts.now ?? Date.now;`
  `const hasDeadline = typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0;`
  `const deadline = clock() + (opts.timeoutMs ?? 0);` `let scanned = 0;`
- file loop top: `if (hasDeadline && clock() > deadline) throw new SearchTimeoutError();`
- line loop: `if (hasDeadline && (++scanned & 1023) === 0 && clock() > deadline) throw new SearchTimeoutError();`
- update the JSDoc "Never throws" line to: never throws on I/O/parse errors;
  throws ONLY `SearchTimeoutError`, and only when `timeoutMs` is set and exceeded.

Verify subset: `npx vitest run --root packages/rc-gateway src/search/transcripts.test.ts`.

> `feat(rc-gateway): search scan deadline + SearchTimeoutError (inert, opt-in)`

## Commit 3 — search.ts route: pass timeout + catch → 503 (ATOMIC)

Tests first in `src/routes/search.test.ts` (extend `mount` to accept opts so a
test can inject `timeoutMs`/`now`):

- a small `timeoutMs` + a `now` that jumps past it (real temp-dir fixture,
  scanned through the real `searchTranscripts`) → `503` with code
  `search_timeout`; audit has `search_performed { kind, timedOut:true }` and
  NO query text.
- the existing 200 path is unaffected (default 2000, real clock).

Implementation in `src/routes/search.ts`:

- signature → `createSearchRoute(resolveDir, audit?, opts?: { timeoutMs?: number; now?: () => number })`.
- `const SEARCH_TIMEOUT_MS = 2000;` (module const).
- replace the bare `const hits = await searchTranscripts(...)` with:
  ```ts
  let hits;
  try {
    hits = await searchTranscripts(dir, q, {
      kind,
      sessionId,
      limit,
      timeoutMs: opts?.timeoutMs ?? SEARCH_TIMEOUT_MS,
      now: opts?.now,
    });
  } catch (err) {
    if (err instanceof SearchTimeoutError) {
      void audit?.record({
        action: 'search_performed',
        actorTokenId: req.rcClient?.id,
        detail: { kind, timedOut: true },
      });
      res
        .status(503)
        .json({ error: 'Search timed out', code: 'search_timeout' });
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Search failed', code: 'search_error' });
    }
    return;
  }
  ```
- import `SearchTimeoutError` from `../search/transcripts.js`.

Full verify: typecheck / lint / build / test + `node scripts/rc-gateway-e2e.mjs`.

> `feat(rc-gateway): enforce 2s search scan timeout → 503 search_timeout`

## Then

advisor (done-check) → opus adversarial review on `git diff 9ec551fb5..HEAD`
(dimensions: inertness of commit 2 / can it throw into an uncatching path; the
atomic timeout-arg+catch; deadline correctness + the Number.isFinite guard;
audit privacy/no query text/no new action; back-compat of the default-no-timeout
path; async-route hygiene; the readFile caveat is documented-not-a-bug) → apply
fixes → re-verify → push → update both memory files.
