# Plan — Cycle 50: `GET /rc/sessions` (session listing with fork lineage)

Fail-safe, inert-first commit order. Every pre-final commit is
behavior-identical (new code is exported but nothing mounts/imports it),
so a mid-cycle cut always lands safe.

## Commit 1 — docs

`docs/superpowers/specs/2026-06-11-session-listing-design.md` +
`docs/superpowers/plans/2026-06-11-session-listing.md`.

## Commit 2 — pure + disk module (INERT: nothing imports it)

`packages/rc-gateway/src/sessions/sessionList.ts`:

- `MAX_LIST_SESSIONS = 500`.
- `SessionListItem { sessionId; parentSessionId?; forks: string[] }`,
  `SessionListResult { sessions; truncated }`.
- `readFirstRecord(chatsDir, id, opts?)` — bounded, byte-accumulate /
  decode-once first-line reader. `null` on ENOENT / empty / unparseable
  / over-cap.
- `assembleListing(entries)` — PURE: nodes + reverse `forks[]` index +
  deterministic sort; self-parent guarded.
- `listSessions(chatsDir, opts?)` — readdir (ENOENT → empty) → filter
  `.jsonl` → `isValidSessionId` → lexical sort → cap (`truncated`) →
  `readFirstRecord` + `parentOf` per id → `assembleListing`.

Add `'session_list_read'` to the `AuditAction` union AND the
`AUDIT_ACTIONS` array in `auditLog.ts` (inert — widens a type/array).

Tests `sessions/sessionList.test.ts`:

- `assembleListing` (pure): root + children → `forks[]`; orphan parent
  (child lists parentSessionId, missing parent not a node, child in no
  forks[]); multi-child deterministic order; self-ref no-crash; sort.
- `readFirstRecord` (temp dir): single record no trailing newline;
  multi-line takes line 1; multibyte char split across the read boundary
  decodes intact; ENOENT → null; first line over `maxBytes` → null.
- `listSessions` (temp dir): mixed roots/forks → correct tree; non-
  `.jsonl` + invalid-id files skipped; ENOENT dir → empty; cap →
  `truncated:true` + exactly `max` nodes.

## Commit 3 — route (INERT: exported, not mounted)

`packages/rc-gateway/src/routes/sessions.ts`:
`createSessionListRoute(resolveWorkspaceCwd, audit?)` — async,
try/catch-to-500. 502 on null cwd; 200 `{sessions, truncated}`; audits
`session_list_read { count, truncated }`.

Tests `routes/sessions.test.ts` (temp dir + `QWEN_RUNTIME_DIR`, mirroring
`routes/lineage.test.ts`): 200 tree; 502 unresolvable cwd; audit detail
has no session ids; OWNER-gate block (403 SESSION_READ before handler,
200 OWNER).

## Commit 4 — wire + e2e (FINAL: behavior change lands here)

- `server.ts`: mount `app.get('/rc/sessions', requireScope(OWNER,
audit), createSessionListRoute(async () => caps.workspaceCwd, audit))`.
- `scripts/rc-gateway-e2e.mjs`: after the lineage block (reuses the real
  parent+fork on disk), an OWNER token GETs `/rc/sessions` and asserts
  (tolerantly — the real dir holds other sessions) the parent item has
  `forks` containing the fork and the fork item has `parentSessionId ===
parentId`; a WRITE-not-OWNER token → 403.

## Verify

typecheck / lint / build / test (expect +N vitest) / e2e (expect +2) +
opus review → fix → push (explicit paths) → update both memory files.
