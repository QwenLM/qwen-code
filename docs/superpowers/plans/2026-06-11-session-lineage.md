# Cycle 47 plan — `GET /rc/session/:id/lineage`

Fail-safe commit order: pure module + tests FIRST (inert — nothing imports it),
route + server wiring LAST (the new route's try/catch lands WITH the route).

## Commit 1 (docs)

- `docs/superpowers/specs/2026-06-11-session-lineage-design.md`
- `docs/superpowers/plans/2026-06-11-session-lineage.md`

## Commit 2 — pure walk module (inert)

- New `src/sessions/lineage.ts`:
  - `interface LineageNode { sessionId: string }`
  - `interface LineageResult { sessionId: string; chain: LineageNode[]; truncated: boolean }`
  - `parentOf(records: ForkRecord[] | null): string | null` — first record's
    `forkedFrom.sessionId` if it's a string, else null.
  - `const MAX_LINEAGE_DEPTH = 100`
  - `async walkLineage(startId, { readRecords, isValidId, maxDepth? }): Promise<LineageResult | null>`
    - returns `null` when the START transcript is missing (readRecords(start)
      === null) -> route maps to 404.
    - chain accumulates self-first; visited set; cap; truncate-on-missing-parent
      / cycle / invalid-parent-id.
- New `src/sessions/lineage.test.ts`: root (no forkedFrom), 1-deep, N-deep,
  missing start -> null, missing mid-parent -> truncated, cycle -> truncated,
  depth cap -> truncated, invalid forkedFrom id -> truncated, non-string
  forkedFrom -> root.

## Commit 3 — route + wiring (behavior change)

- New `src/routes/lineage.ts`: `createLineageRoute(resolveWorkspaceCwd, audit)`
  - try/catch around the whole body (-> 500 `lineage_failed`).
  - invalid start id -> 404 `session_not_found`.
  - resolve cwd; undefined -> 502 `daemon_unavailable`.
  - `walkLineage` with `readParentRecords` + `isValidSessionId`.
  - null -> 404 `session_not_found`; else 200 + audit `session_lineage_read`
    `{ depth, truncated }`.
- `src/auditLog.ts`: add `session_lineage_read` to the union AND `AUDIT_ACTIONS`.
- `src/routes/lineage.test.ts`: 200 chain (capturing temp chats dir), 404
  missing, 404 invalid id, 502 no cwd, audit shape (depth+truncated only, no ids).
- `src/server.ts`: mount
  `app.get('/rc/session/:id/lineage', requireScope(OWNER, audit), createLineageRoute(resolveCwd, audit))`
  reusing the same `deps.daemon.capabilities().workspaceCwd` resolver shape used
  by the fork/search routes.

## Verify

- typecheck / lint / build / test (expect +~14 vitest)
- e2e (the existing fork scenario already writes a real parent+fork on disk;
  optionally extend e2e to GET the fork's lineage and assert chain=[fork,parent]
  — only if low-risk; otherwise the route is covered by unit tests + the
  server mount is type-checked).
- opus review on `git diff <base>..HEAD -- packages/rc-gateway/`.
