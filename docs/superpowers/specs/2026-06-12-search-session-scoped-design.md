# Cycle 76 — Session-scoped search for session-locked (share) tokens

Proposal: `add-cross-session-search`. The on-demand JSONL search (`GET /rc/search`,
cycles 19/23/27/32/34/37) is OWNER-only. The proposal's **non-owner
attachment-scoped filtering** (the daemon design keys it on a per-token
`token_session_history`) lets a non-owner search only the sessions it may see.
This cycle delivers that for the gateway's one kind of non-owner token: a
session-locked **share** token.

## Deviation note

The daemon design gives each token a HISTORY of attached sessions and filters
search to that set. Our gateway's share token (cycle 18) is locked to exactly ONE
session (`sessionLockId`), so "attachment-scoped" collapses to "that one
session". No `token_session_history` table; the lock IS the scope. No daemon
change.

## The security crux (advisor focus)

A session-locked token must be able to search ONLY its locked session, and the
`sessionId` it searches must be **forced server-side from `sessionLockId`** —
NEVER read from a client-supplied `?sessionId`. This is the cycle-18 leak class
(a share token reaching cross-session data) re-examined for search: a guest must
not be able to pass `?sessionId=<someone-else>` and read another transcript.

## Mechanism

1. **Mount** (`server.ts`): `requireScope(OWNER)` → `requireScope(SESSION_READ)`.
   Both an owner (boot grant includes `session:read`) and a share (issued with
   `session:read`) hold it; a session-locked share can now REACH the handler. A
   plain `session:read`-only token (no OWNER, no lock) also reaches the handler
   but is rejected in-handler (below). `/rc/search` has no `:id` param, so the
   `enforceSessionLock` middleware does not apply — the in-handler forcing is the
   sole confinement.
2. **In-handler authorization** (`routes/search.ts`), evaluated FIRST (before any
   query processing, so an unauthorized caller learns nothing):
   - `lock = req.rcClient?.sessionLockId`.
   - If `lock !== undefined` (session-locked share) → **force `sessionId = lock`**,
     ignore `req.query.sessionId` entirely. Allowed.
   - Else require OWNER in-handler: `req.rcClient.scopes.includes(OWNER)` else
     `403 insufficient_scope` + audit `scope_denied {required: owner}` (mirrors
     `requireScope`, carrying actorTokenId/shareId/shareLabel). `sessionId` then
     comes from `?sessionId` as before.
3. The scanner already restricts results by `sessionId` (`transcripts.ts:208`:
   `if (opts.sessionId && rec.sessionId !== opts.sessionId) continue`), so a
   forced `sessionId = lock` returns ONLY the locked session's hits. (It still
   scans the dir's files, but every returned hit + snippet is from the locked
   session — no leak.)

## Decisions

1. Owner behaviour is BYTE-IDENTICAL: an owner is never session-locked, so
   `lock === undefined` → the in-handler OWNER check passes → `sessionId` from the
   query exactly as before. The mount loosening + in-handler OWNER check together
   are equivalent to the old `requireScope(OWNER)` for owners, and additionally
   admit session-locked shares.
2. The forced `sessionId` is the lock, full stop — `?sessionId` from a share is
   neither honoured nor error'd (silently overridden), the simplest non-leaking
   rule.
3. Guest search rows are share-attributable: the success + timeout audits gain
   `shareId`/`shareLabel` from `req.rcClient` (undefined → omitted for owners),
   so `GET /rc/audit?shareId=` (cycle 31, L4) surfaces a guest's searches with
   the share label. Detail gains `sessionScoped:true` on the share path for the
   "why" feed. No new AuditAction.

## Fail-safe commit order

docs → **route handler authz INERT** (add the lock-forcing + in-handler OWNER
check while the mount is STILL `requireScope(OWNER)`: owners are never locked, so
`lock===undefined` and the OWNER check passes → behaviour-identical; shares still
403 at the mount) + unit tests → **mount loosen LAST** (`OWNER`→`SESSION_READ`)

- server.test integration (share searches its own session; share's `?sessionId`
  override ignored; non-owner-non-locked → 403; owner unchanged). Splitting this
  way means there is never a transient state where the mount admits shares without
  the in-handler confinement.

## Verification

vitest: handler unit — locked token forces sessionId=lock (ignores query
sessionId); non-locked non-owner → 403 scope_denied; owner uses query sessionId.
server.test — share token (issued with sessionLock) `GET /rc/search?q=...` →
200 hits only from its session; same share with `?sessionId=other` → still only
its own session; a plain session:read token → 403; owner unchanged. typecheck/
lint/build. e2e: add a share-token-scoped search assertion if cheap, else leave
45 (the OWNER search e2e must stay green).

## Deferred

Multi-session attachment history (we only have a single lock); a distinct
`search_denied` audit (reuses `scope_denied`); FTS5/BM25 index; the search CLI
(cycle 83).
