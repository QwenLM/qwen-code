# Plan — search response `truncated` + `elapsedMs` (cycle 37)

See design: `../specs/2026-06-10-rc-gateway-search-truncated-elapsed-design.md`.

TDD, fail-safe commit order. All commands from repo root, absolute paths.

## Commit 1 — docs

`docs/superpowers/specs|plans/2026-06-10-rc-gateway-search-truncated-elapsed*`.

## Commit 2 — extract `searchTranscriptsDetailed` (INERT) + tests + barrel

`search/transcripts.ts`:

- add `export interface SearchResult { hits: SearchHit[]; truncated: boolean }`.
- rename the current `searchTranscripts` body to
  `export async function searchTranscriptsDetailed(...): Promise<SearchResult>`;
  the `plan.node === null` early return → `return { hits: [], truncated: false }`;
  keep the `Math.min/max` clamp inside; at the end
  `const total = hits.length; ... return { hits: hits.slice(0, limit),
truncated: total > limit }` (compare against the CLAMPED limit).
- `searchTranscripts` becomes:
  `return (await searchTranscriptsDetailed(chatsDir, query, opts)).hits;`
  (signature + `SearchHit[]` return + `SearchTimeoutError` propagation unchanged).

`index.ts`: also export `searchTranscriptsDetailed`, `type SearchResult`.

Tests → `transcripts.test.ts` (append): boundary truncated false/true at the
clamped limit; delegation (`searchTranscripts` hits deep-equal
`searchTranscriptsDetailed(...).hits`); no-match → `{hits:[],truncated:false}`.
Existing tests must stay green (behavior of `searchTranscripts` unchanged).

Verify: `npx vitest run --root packages/rc-gateway src/search/transcripts.test.ts`.

## Commit 3 — route emits `truncated` + `elapsedMs` LAST + route tests

`routes/search.ts`: import `searchTranscriptsDetailed`; `const nowMs = opts?.now
?? Date.now;` `const startedAt = nowMs();` call `searchTranscriptsDetailed(dir,
q, {kind, sessionId, limit, timeoutMs: ..., now: opts?.now})` inside the existing
try/catch; on success `const elapsedMs = Math.max(0, Math.round(nowMs() -
startedAt));` and `res.status(200).json({ hits: result.hits, truncated:
result.truncated, elapsedMs })`. Audit stays `{kind, resultCount: result.hits.length}`.
503/500 paths unchanged.

Route tests (`search.test.ts`): 200 body has `truncated` + integer `elapsedMs ≥ 0`
(real clock); constant injected `now` → `elapsedMs === 0`; on-disk set > limit →
`truncated:true`; (503 timeout path already covered, asserts no body fields).

## Verify (repo root)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

## Review → fix → push → memory

opus adversarial review on `git diff f14e61917..HEAD -- packages/rc-gateway/`;
apply fixes; push to `origin/add-remote-control-spec`; update both memory files.
