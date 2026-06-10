# Plan — share `max_uses` / `share_exhausted` (cycle 26, add-link-share L2)

Spec: `../specs/2026-06-09-rc-gateway-share-max-uses-design.md`. TDD, two
commits, fail-safe order (store inert first, wiring last).

## Commit 1 — TokenStore use-counter (inert, additive)

1. `tokenStore.ts`:
   - `TokenRecord`: add `maxUses?: number`, `uses?: number`.
   - `issueShare`: accept optional `maxUses`; persist `uses: 0` + `maxUses`.
   - New `consumeUse(id): Promise<{ ok: true; usesRemaining: number | null } |
{ ok: false; reason: 'exhausted' | 'not_found' }>` — synchronous guard +
     in-memory bump (no await between), then `await persist()`. `uses ?? 0`.
   - `ShareInfo`: add `maxUses?`, `uses: number`, `usesRemaining: number | null`;
     populate in `listShares()` (`uses ?? 0`).
2. `tokenStore.test.ts`: consumeUse bump→usesRemaining; exhaust→`{ok:false,
exhausted}`; unlimited (no maxUses)→ok, usesRemaining null; unknown id→
   not_found; a record persisted with no `uses` field reads back as uses 0 (not
   NaN) and consumes fine; listShares exposes the use fields.
3. Verify typecheck/lint/build/test. Commit:
   `feat(rc-gateway): share token use-counter (maxUses/consumeUse, inert)`

## Commit 2 — redemption endpoint + mint param (wiring)

4. `auditLog.ts`: add `share_redeemed`, `share_exhausted` to `AuditAction` +
   `AUDIT_ACTIONS`.
5. `routes/share.ts`:
   - `POST /`: read `maxUses`; if finite number → clamp `[1,100]` else undefined;
     pass to `issueShare`; add `maxUses` to `share_created` detail.
   - Export `createShareWhoamiHandler(store, audit?)`: parse `req.headers.cookie`
     for `rc_share_<id>`; if present → 200 metadata (no bump). Else `consumeUse`:
     not*found→404 (defensive); exhausted→410 `share_exhausted` + audit; ok→
     `res.cookie('rc_share*'+id, '1', {httpOnly:true, sameSite:'strict',
     maxAge:...})`+ audit`share_redeemed`+ 200 metadata. **Whole body in
try/catch → 500 if`!res.headersSent`.\*\*
6. `server.ts`: `app.get('/rc/share/whoami', requireScope(SHARE, audit),
createShareWhoamiHandler(deps.store, audit))` BEFORE the owner-gated
   `app.use('/rc/share', requireScope(OWNER), ...)`.
7. `routes/share.test.ts`: mount whoami behind a stub injecting a SHARE rcClient
   (id + sessionLockId + scopes). Tests: POST maxUses persisted + clamp(>100→100,
   <1→1); whoami first call → 200 usesRemaining decremented + share_redeemed +
   Set-Cookie; **second call WITH the forwarded Cookie → 200, uses unchanged**;
   maxUses:1 → first redeems, second fresh (no cookie) → 410 share_exhausted +
   audit; non-SHARE token → 403 (requireScope). server.test.ts: route ordering
   (a SHARE token reaches whoami, not the owner 403).
8. Verify typecheck/lint/build/test + e2e. Commit:
   `feat(rc-gateway): /rc/share/whoami redemption endpoint enforces maxUses`

## Then

opus adversarial review (focus: counter atomicity, cookie-forge bypass impact,
unfurl-consumption, async-error catch, exhausted-still-resolves correctness) →
fix → push → update both memory files.
