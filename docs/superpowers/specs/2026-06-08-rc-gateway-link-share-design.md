# Remote-Control Gateway — Link Share Core (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 18)
**Scope:** Session-locked, TTL-bounded guest-access tokens with mint/list/revoke
routes — the core of `add-link-share` (stories L1 quick-approval-handoff, L3
live-revoke). Builds on cycles 1–2 (pairing/tokens/registry), 6/7 (vote/prompt).

## Deviation / context

Proposal extends the daemon's pairing system + token DB. We deviate (zero upstream
edits): share tokens live in the gateway-owned `TokenStore`, enforced by gateway
middleware. The URL-as-credential bootstrap page, watermark, max-uses counting,
`qwen rc share` CLI, and audit-by-share-id filter are **deferred to later slices** —
this cycle ships the security core (mint a session-locked expiring view/approve
token; enforce the lock + TTL; list; revoke + evict).

## This cycle's scope (and deferrals)

**In:** a `share` scope; `TokenStore` gains optional `expiresAt`, `sessionLockId`,
`parentId` per record + `issueShare()`; `resolve()` rejects expired tokens and
returns `sessionLockId`; an `enforceSessionLock` middleware; `POST /rc/share`,
`GET /rc/share`, `DELETE /rc/share/:id` (owner-gated); audit `share_created`,
`share_revoked`.

**Deferred:** `max_uses` counting (story L2 single-use); the `GET /ui/share/<token>`
bootstrap HTML (sessionStorage + URL scrub) + watermark banner; `qwen rc share`
CLI; per-action `share_id` audit tagging + `--share-id` filter; SSE lifecycle
frames. (The mint route returns the raw token + a `/ui/share/<token>` URL string;
wiring the bootstrap page is the next slice.)

## Decisions

1. **A share token is a normal `TokenStore` token** with: scopes `[SHARE,
session:read]` (view) or `[SHARE, session:read, approve]` (approve-elevated);
   `sessionLockId` = the one session it may touch; `expiresAt` = now + ttl;
   `parentId` = the owner token that minted it. It **never** gets `write` or
   `owner` (guests cannot prompt or manage). The `SHARE` scope is an identity
   marker (lets list/UI distinguish shares and is reserved for future
   guest-only gating); functional access comes from the concrete `session:read`/
   `approve` scopes so existing routes work unchanged.
2. **TTL enforced in `resolve()`.** A token with `expiresAt && now >= expiresAt`
   resolves to `null` → 401 (same as an unknown token). No background sweeper
   needed; expiry is checked at use. (A future slice can prune expired records.)
3. **Session lock enforced by middleware**, not by scope. `enforceSessionLock`
   runs after `requireScope` on the session routes: if `req.rcClient.sessionLockId`
   is set and `!== req.params.id` → `403 session_locked`. Non-share tokens (no
   lock) pass unaffected.
4. **Revoke evicts live streams** (reuse the cycle-2 `ConnectionRegistry`): a
   revoked share id aborts its open SSE — story L3.
5. **Back-compat:** all new record fields are optional; `resolve`'s return type
   gains optional `sessionLockId`; `req.rcClient` gains optional `sessionLockId`.
   Existing tokens (no expiry, no lock) behave exactly as before.

## Components

### Scope (`src/scopes.ts`)

`export const SHARE: RcScope = 'share';` add to `KNOWN_SCOPES`.

### TokenStore (`src/tokenStore.ts`)

- `TokenRecord` gains optional `expiresAt?: number`, `sessionLockId?: string`,
  `parentId?: string`. (`TokenInfo` unchanged; new metadata exposed via
  `listShares`.)
- `issueShare(opts: { scopes: RcScope[]; label: string; sessionLockId: string;
ttlSec: number; parentId: string }): Promise<{ id: string; token: string;
expiresAt: number }>` — like `issue` but stamps `expiresAt = nowFn() +
ttlSec*1000`, `sessionLockId`, `parentId`.
- `resolve(authHeader)` → `{ id, scopes, sessionLockId? } | null`. Skip a record
  (treat as no-match) when `rec.expiresAt !== undefined && this.nowFn() >=
rec.expiresAt`. On match, include `sessionLockId: rec.sessionLockId`.
- `listShares(): ShareInfo[]` — records with `sessionLockId` set, mapped to
  `{ id, label, scopes, sessionLockId, expiresAt, parentId, createdAt, expired }`
  (`expired = expiresAt !== undefined && now >= expiresAt`). Metadata only.

### Auth (`src/auth.ts`)

- `bearerResolve`: set `req.rcClient = { id, scopes, sessionLockId }` (include the
  resolved lock).
- New `export function enforceSessionLock(audit?): RequestHandler` →
  `(req,res,next) => { const lock = req.rcClient?.sessionLockId; if (lock && lock
!== req.params.id) { void audit?.record({action:'scope_denied', actorTokenId:
req.rcClient?.id, detail:{reason:'session_locked', path:req.path}}); return
res.status(403).json({error:'Session locked', code:'session_locked'}); } next();
}`. (Reuses the existing `scope_denied` audit action — no new action for the
  block.)
- Extend the `RcClient`/request typing to carry optional `sessionLockId`.

### Share routes (`src/routes/share.ts`) — new

`createShareRouter(store: TokenStore, registry: ConnectionRegistry, audit?):
Router`, mounted at `/rc/share` under `requireScope(OWNER)`:

- `POST /` body `{ sessionId, ttlSec, label?, scope?: 'view'|'approve' }`:
  validate `sessionId` non-empty string + `ttlSec` finite > 0 (else `400
invalid_share`); `scopes = scope==='approve' ? [SHARE,SESSION_READ,APPROVE] :
[SHARE,SESSION_READ]`; `const { id, token, expiresAt } = await store.issueShare(
{scopes, label: label ?? 'share', sessionLockId: sessionId, ttlSec, parentId:
req.rcClient.id})`; audit `share_created {shareId:id, sessionId, scope:
scope??'view', label}`; `201 { id, token, url: '/ui/share/'+token, expiresAt }`.
- `GET /` → `200 { shares: store.listShares() }`.
- `DELETE /:id` → `const rec = store.listShares().find(s=>s.id===req.params.id)`;
  if absent → 404; `await store.revoke(id)`; `registry.evict(id)`; audit
  `share_revoked {shareId:id}`; `204`.

### Audit (`src/auditLog.ts`)

Add `'share_created'`, `'share_revoked'` to the union + `AUDIT_ACTIONS`.

### Wiring (`src/server.ts`)

- Mount `enforceSessionLock(audit)` AFTER `requireScope(...)` on the three session
  routes (events, permission, prompt) — so a share token can only reach its locked
  session.
- Mount `app.use('/rc/share', requireScope(OWNER, audit), createShareRouter(
deps.store, registry, audit))`.

## Error model

| Condition                                  | Response                            |
| ------------------------------------------ | ----------------------------------- |
| Share token past TTL                       | `401` (resolve → null)              |
| Share token for a different session        | `403 session_locked`                |
| Share token on the prompt route (no write) | `403 insufficient_scope`            |
| Mint with bad sessionId/ttl                | `400 invalid_share`                 |
| Revoke unknown share id                    | `404`                               |
| Mint ok                                    | `201 { id, token, url, expiresAt }` |

## Testing strategy (TDD)

**`tokenStore.test.ts` (extend):** `issueShare` stamps expiresAt/sessionLockId/
parentId; `resolve` of a not-yet-expired share → returns scopes + sessionLockId;
`resolve` of an expired share (advance nowFn) → null; `listShares` returns only
share records with `expired` computed; a normal `issue` token has no sessionLockId
and `resolve` returns `sessionLockId: undefined`.

**`auth.test.ts` (or routes):** `enforceSessionLock` — a req with
`rcClient.sessionLockId='s1'` and `params.id='s1'` → next; `params.id='s2'` → 403
session_locked + scope_denied audit; no lock → next.

**`routes/share.test.ts`:** POST (owner) view → 201 {id,token,url,expiresAt} + audit
share_created; POST approve → token resolves with APPROVE scope; bad body → 400;
GET → lists it; DELETE → 204 + share_revoked + registry.evict called; DELETE unknown
→ 404.

**`server.test.ts` (extend):** mint a share (owner) for `s1`; use its token on
`GET /rc/session/s1/events` → reaches the route (not 403); on `GET
/rc/session/s2/events` → 403 session_locked; on `POST /rc/session/s1/prompt` → 403
(no write). A share with ttlSec then advanced clock isn't testable via HTTP (real
clock) — covered by the tokenStore unit test.

**e2e:** owner mints a share for a bogus session → 201 with a token + url; GET /rc/share
lists it; the share token on `/rc/session/<other>/events` → 403 session_locked;
DELETE → 204. (Pure gateway.)

## File boundary

All within `packages/rc-gateway/`. New: `src/routes/share.ts` (+test). Modified:
`src/scopes.ts`, `src/tokenStore.ts` (+test), `src/auth.ts` (+test), `src/auditLog.ts`
(2 actions), `src/server.ts` (mounts), `src/index.ts` (exports), `src/server.test.ts`,
`scripts/rc-gateway-e2e.mjs`. Zero upstream edits.

## Follow-on

Next link-share slices: `max_uses` counting + `share_exhausted` (L2); the
`GET /ui/share/<token>` bootstrap page (sessionStorage + `history.replaceState` URL
scrub) + the web-client share watermark + hiding write UI for share tokens; per-action
`share_id` audit tagging + `qwen rc audit --share-id` (L4); `qwen rc share` CLI;
share lifecycle SSE frames. Then the next proposal (e.g. `add-cost-tracking` or
`add-cross-session-search`).
