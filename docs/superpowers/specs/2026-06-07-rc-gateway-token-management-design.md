# Remote-Control Gateway — Token Management (Design)

**Date:** 2026-06-07
**Status:** Proposed (cycle 2)
**Scope:** Owner-authorized token lifecycle on the gateway: list, mint, revoke — with immediate eviction of a revoked token's live streams. Builds directly on the cycle-1 walking skeleton.

## Context

Cycle 1 shipped `packages/rc-gateway/` (`@qwen-code/rc-gateway`): pairing code →
scoped token → authenticated, scope-gated SSE proxy of the daemon's
`/session/:id/events`, all via the unmodified `qwen serve` daemon and
`@qwen-code/sdk`. See `2026-06-06-rc-gateway-walking-skeleton-design.md`.

The current `TokenStore` can `issue` and `resolve` tokens but cannot **list** or
**revoke** them, and there is no way for an operator to manage the tokens they've
handed out. The only scope is `session:read`, which is insufficient to gate
management operations. This cycle fills that gap.

## Goal of this cycle

> The workstation owner can see every token they've issued, mint new scoped
> tokens directly, and revoke any token — and revoking a token immediately tears
> down any SSE stream that token currently has open.

## Non-goals (this cycle)

- No audit log of token operations (separate follow-on cycle).
- No capability advertisement endpoint.
- No scope _hierarchy_ — `owner` is just another flat scope, not "owner implies
  everything." Management routes check for `owner` explicitly.
- No token expiry / TTL (tokens live until revoked).
- No CORS / browser exposure (still loopback + non-browser clients this cycle).

## Decisions (from brainstorming)

1. **Management is gated by a new `owner` scope.** Reuses the existing
   scoped-token + `requireScope` machinery rather than a parallel admin-auth
   mechanism. The boot pairing code grants `[owner, session:read]`.
2. **Revocation is immediate-eviction.** Because the only protected route is a
   long-lived SSE stream, "future requests only" revocation would let a
   just-revoked client keep streaming. Revoke therefore also aborts the token's
   open streams, via an in-memory connection registry.
3. **Owner minting is included, scope-clamped.** An owner can mint tokens
   directly (not only via pairing), but only with scopes the owner itself holds.

## Components

### Scopes (`src/scopes.ts`)

- Add `export const OWNER: RcScope = 'owner'`.
- Add `export const KNOWN_SCOPES: readonly RcScope[] = [OWNER, SESSION_READ]`
  (used to reject unknown scope names at mint time).

### TokenStore additions (`src/tokenStore.ts`)

- `list(): TokenInfo[]` where `TokenInfo = { id; scopes; label; createdAt }`.
  Returns metadata only — never `tokenHash`, never the raw token.
- `revoke(id: string): boolean` — removes the record with that id, persists,
  returns `true` if a record was removed, `false` if no such id.
- (`issue` and `resolve` are unchanged.)

### ConnectionRegistry (`src/connectionRegistry.ts`) — new

A small, standalone, synchronously-testable component tracking active streams
per token id.

- Internal: `Map<string /*tokenId*/, Set<AbortController>>`.
- `register(tokenId: string, ctrl: AbortController): () => void` — adds the
  controller; returns an `unregister` closure that removes it (and drops the
  Set when empty).
- `evict(tokenId: string): void` — calls `.abort()` on every controller for that
  id, then clears them.

### Routes (`src/routes/tokens.ts`) — new, all `requireScope(OWNER)`

- `GET /rc/tokens` → `200` `store.list()`.
- `POST /rc/tokens { scopes?, label? }` → mint:
  - `scopes` defaults to `[SESSION_READ]` when omitted.
  - Each requested scope must be in `KNOWN_SCOPES`, else `400 { code: 'invalid_scope' }`.
  - Each requested scope must be in the caller's own `req.rcClient.scopes`
    (clamp — no granting above your level), else `403 { code: 'insufficient_scope' }`.
  - On success: `store.issue(scopes, label ?? 'unnamed')` → `200 { id, token, scopes }`.
    The raw token is returned exactly once and never logged.
- `DELETE /rc/tokens/:id` → `store.revoke(id)`; if removed → `registry.evict(id)`
  then `204` (no body); else `404 { code: 'token_not_found' }`.

### Eviction wiring (reuse, not new machinery)

The cycle-1 SSE route already creates an `AbortController` for client-disconnect
(`req.on('close') → abort.abort()`). This cycle:

- `createSessionEventsRoute(daemon, registry)` gains the registry.
- On connect (after auth, so `req.rcClient.id` is known) it calls
  `const unregister = registry.register(req.rcClient.id, abort)`, and calls
  `unregister()` when the request closes.
- `registry.evict(id)` fires that same controller → the existing catch path
  aborts the upstream `subscribeEvents` and `res.end()`s the downstream stream.
  Eviction therefore travels the exact path already tested for client-disconnect.

### Assembly (`src/server.ts`)

`createGatewayApp` constructs the single `ConnectionRegistry` and passes it to
both `createSessionEventsRoute(daemon, registry)` and the tokens routes. New
pipeline (additions in **bold**):

```
express.json()
GET  /rc/health                              (open)
POST /rc/pair/redeem                         (code-gated)
app.use(bearerResolve)
GET    /rc/session/:id/events  requireScope(session:read)   (now registers in registry)
GET    /rc/tokens              requireScope(owner)          ← new
POST   /rc/tokens              requireScope(owner)          ← new
DELETE /rc/tokens/:id          requireScope(owner)          ← new
```

### CLI (`src/cli.ts`)

Boot pairing code now grants `[OWNER, SESSION_READ]` (was `[SESSION_READ]`), so
the first redeemed token can manage tokens.

## Data flow (revoke a live client)

1. Owner client: `DELETE /rc/tokens/<id>` with an `owner`-scoped bearer.
2. `requireScope(owner)` passes → `store.revoke(id)` removes the record and
   persists (all future requests with that token now `401`).
3. `registry.evict(id)` aborts that token's open SSE controller(s).
4. Each aborted stream: upstream `subscribeEvents` cancelled, downstream SSE
   response `end()`ed. Gateway returns `204`.

## Error model

| Condition                          | Response                             |
| ---------------------------------- | ------------------------------------ |
| Non-owner hits any `/rc/tokens*`   | `403 { code: 'insufficient_scope' }` |
| Missing/invalid bearer             | `401 { code: 'unauthorized' }`       |
| Mint with an unknown scope name    | `400 { code: 'invalid_scope' }`      |
| Mint with a scope the caller lacks | `403 { code: 'insufficient_scope' }` |
| Revoke an unknown id               | `404 { code: 'token_not_found' }`    |
| Successful revoke                  | `204` (no body)                      |

Self-revoke is allowed (an owner may revoke its own token and lock itself out;
recovery is restarting the gateway for a fresh boot pairing code).

## Testing strategy (TDD)

**Unit:**

- `TokenStore.list` — returns `{id, scopes, label, createdAt}` only; asserts the
  serialized result contains no `tokenHash` and no raw token.
- `TokenStore.revoke` — removes by id, persists across reopen, returns
  `true`/`false`; revoked token no longer `resolve`s.
- `ConnectionRegistry` — `register` then `evict` aborts the controller;
  `unregister` prevents later eviction; multiple controllers per id all abort;
  unknown id evict is a no-op.

**Integration (gateway app + stub daemon):**

- `GET /rc/tokens` as owner → 200 lists issued tokens (metadata only); as a
  `session:read`-only token → 403.
- `POST /rc/tokens` as owner with `[session:read]` → 200, returned token then
  works on the events route; with an unknown scope → 400; with `[owner]` from a
  caller lacking owner → 403 (clamp).
- `DELETE /rc/tokens/:id` as owner → 204; the revoked token then → 401 on the
  events route; revoking unknown id → 404.
- **Eviction behavioral test:** with the hold-open stub daemon, open an SSE
  stream using token A, then `DELETE /rc/tokens/<A.id>` as owner; assert the
  open stream closes (downstream ends) and the stub observes its upstream
  request aborted (`stub.eventsAbortedByClient`).

**Existing tests:** the cycle-1 `sessionEvents.test.ts` calls
`createSessionEventsRoute(daemon)` — update those call sites to pass a fresh
`ConnectionRegistry`. `server.test.ts` is unaffected (it mints `[session:read]`
codes via pairing, which still works).

## File boundary / isolation

All changes remain within `packages/rc-gateway/` — still zero upstream-file
edits. New files: `src/connectionRegistry.ts` (+ test), `src/routes/tokens.ts`
(+ test). Modified: `src/scopes.ts`, `src/tokenStore.ts` (+ test),
`src/routes/sessionEvents.ts` (+ test call sites), `src/server.ts` (+ test),
`src/cli.ts`, `src/index.ts` (export new public symbols).

## Follow-on cycles (still not now)

Audit log (revocation is a security event worth recording), capability
advertisement, scope hierarchy, token TTL/expiry, CORS + hosted web client,
durable WAL, SSE fan-out multiplexer, `qwen rc` TUI, bridges.
