# RC Gateway — Link Share Core (Cycle 18)

> **For agentic workers:** TDD, `- [ ]` steps. All inside `packages/rc-gateway/` (+ repo-root `scripts/rc-gateway-e2e.mjs`). ZERO edits outside it. Stay on branch `add-remote-control-spec` (do NOT branch). Run git/npm from repo root `/home/evan/projects/qwen-code`.

**Goal:** Session-locked, TTL-bounded share tokens (view/approve) + owner mint/list/revoke routes + session-lock & expiry enforcement.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-link-share-design.md` — full contract. Implement as written.

**Conventions:** license headers; `.js` imports; commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: SHARE scope + audit actions

- [ ] `src/scopes.ts`: `export const SHARE: RcScope = 'share';` + add to `KNOWN_SCOPES`. Export `SHARE` from `src/index.ts`.
- [ ] `src/auditLog.ts`: add `'share_created'`, `'share_revoked'` to the union + `AUDIT_ACTIONS`.
- [ ] typecheck. Commit: `feat(rc-gateway): share scope + share audit actions`.

### Task 2: TokenStore.issueShare + expiry/lock in resolve (TDD)

**Files:** `src/tokenStore.ts` (+ extend `tokenStore.test.ts`); export `ShareInfo` type from `src/index.ts`.

- [ ] Failing tests per design's `tokenStore.test.ts` bullets (issueShare stamps fields; resolve not-expired→scopes+sessionLockId; resolve expired (advance an injectable nowFn)→null; listShares returns only share records with `expired`; normal issue → resolve sessionLockId undefined).
- [ ] Implement: add optional `expiresAt?`, `sessionLockId?`, `parentId?` to `TokenRecord`. `async issueShare({scopes,label,sessionLockId,ttlSec,parentId})` (mirror `issue`, stamp `expiresAt = this.nowFn()+ttlSec*1000` + the lock + parentId; return `{id,token,expiresAt}`). Change `resolve` return to `{id,scopes,sessionLockId?}|null`; inside the match loop, BEFORE returning a match, `if (rec.expiresAt !== undefined && this.nowFn() >= rec.expiresAt) continue;` and on match return `sessionLockId: rec.sessionLockId`. Add `ShareInfo` interface + `listShares()` (filter `r.sessionLockId !== undefined`, map to the metadata incl. `expired`).
- [ ] Tests pass. Commit: `feat(rc-gateway): session-locked TTL share tokens in token store`.

### Task 3: bearerResolve sessionLockId + enforceSessionLock (TDD)

**Files:** `src/auth.ts` (+ extend `auth.test.ts` if present, else cover via routes/server tests). Export `enforceSessionLock` from `src/index.ts`.

- [ ] `bearerResolve`: set `req.rcClient = { id, scopes, sessionLockId }` from the resolve result. Extend the request typing (`RcClient`/the augmented Request) to carry optional `sessionLockId`.
- [ ] Add `export function enforceSessionLock(audit?: AuditRecorder): RequestHandler` per the design (lock set && `!== req.params.id` → 403 `session_locked` + a `scope_denied` audit `{reason:'session_locked', path}`; else next).
- [ ] Failing+impl test: enforceSessionLock with matching/ mismatching/ absent lock. (A unit test building a fake req/res, or via the server test in Task 5.)
- [ ] typecheck/lint. Commit: `feat(rc-gateway): session-lock enforcement middleware`.

### Task 4: share routes (TDD)

**Files:** `src/routes/share.ts` (+ `share.test.ts`); export `createShareRouter` from `src/index.ts`.

- [ ] Failing test per design's `routes/share.test.ts` (mini app, injected OWNER `req.rcClient`, real TokenStore temp + a fake/real ConnectionRegistry + fake audit). POST view→201 {id,token,url:'/ui/share/'+token,expiresAt}+audit share_created; POST approve→issued token resolves WITH approve scope (resolve the returned token via the store); bad body (no sessionId / ttlSec 0)→400; GET→lists; DELETE→204+share_revoked+`registry.evict(id)` called; DELETE unknown→404.
- [ ] Implement `createShareRouter(store, registry, audit?)` per the design. Import `SHARE, SESSION_READ, APPROVE` from `../scopes.js`.
- [ ] Tests pass. Commit: `feat(rc-gateway): owner share mint/list/revoke routes`.

### Task 5: wiring (TDD via server.test)

**Files:** `src/server.ts`, `src/server.test.ts`.

- [ ] In `createGatewayApp`: import `enforceSessionLock`, `createShareRouter`, `OWNER`. Mount `enforceSessionLock(audit)` AFTER `requireScope(...)` (and after any existing per-route middleware) on the events, permission, and prompt routes. Mount `app.use('/rc/share', requireScope(OWNER, audit), createShareRouter(deps.store, registry, audit))`.
- [ ] `server.test.ts`: mint a share for `s1` (owner token → POST /rc/share {sessionId:'s1', ttlSec:3600}); using the returned token: `GET /rc/session/s1/events` → NOT 403 (reaches route — may 200/stream); `GET /rc/session/s2/events` → 403 session_locked; `POST /rc/session/s1/prompt {prompt:'x'}` → 403 (no write scope). Also: GET /rc/share lists it; non-owner POST /rc/share → 403.
- [ ] typecheck/lint/build/test green. Commit: `feat(rc-gateway): wire session-lock + share routes`.

### Task 6: e2e + full verification

- [ ] `scripts/rc-gateway-e2e.mjs`: owner mints a share for a bogus session id → 201 with token+url; GET /rc/share lists it; that share token on `/rc/session/<different>/events` → 403 session_locked; DELETE /rc/share/:id → 204. Bump summary count.
- [ ] From repo root run ALL: `npm run typecheck && npm run lint && npm run build && npm run test` (each `--workspace @qwen-code/rc-gateway`) → green; then `node scripts/rc-gateway-e2e.mjs` → pass.
- [ ] Commit: `test(rc-gateway): e2e link-share checks`.

## Self-review checklist

- Share token: scopes `[SHARE, session:read(, approve)]` + sessionLockId + expiresAt + parentId; NEVER write/owner.
- `resolve` rejects expired (now>=expiresAt) → 401; returns sessionLockId on match. Normal tokens unaffected (no expiry/lock).
- `enforceSessionLock` 403s a share token on a different session; mounted AFTER requireScope on events/permission/prompt; non-locked tokens pass.
- Share routes owner-gated; POST validates sessionId+ttlSec; DELETE evicts via registry + 404 unknown.
- 2 audit actions in union+AUDIT_ACTIONS; share_created detail has shareId/sessionId/scope/label (no token/hash).
- Back-compat: resolve/req.rcClient type changes are additive; all prior 222 tests green. Zero files outside packages/rc-gateway/ except the e2e script.
