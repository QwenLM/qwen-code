# Cycle 31 plan — Link-share L4: `share_id`/`share_label` audit tagging

TDD, bite-sized. Fail-safe commit order: inert schema/read-side first, then
additive lifecycle tagging, then the auth-path wiring last. All commands from
repo root with absolute paths. No `--no-verify`.

## Commit 1 — docs

`docs(rc-gateway): spec+plan for share_id/share_label audit tagging (cycle 31)`

- the design + this plan.

## Commit 2 — INERT/functional: schema + read side (no producers)

`feat(rc-gateway): add shareId/shareLabel audit fields + GET /rc/audit?shareId filter`

1. `auditLog.ts`:
   - `AuditEntry`: add `shareId?: string`, `shareLabel?: string` (doc both:
     never secret; shareId is a token id, shareLabel the operator label).
   - `AuditQuery`: add `shareId?: string`.
   - `AuditLog.query`: after the `actor` filter, add the union filter:
     ```ts
     if (q.shareId !== undefined)
       out = out.filter(
         (r) =>
           r.shareId === q.shareId ||
           r.actorTokenId === q.shareId ||
           (typeof r.detail?.shareId === 'string' &&
             r.detail.shareId === q.shareId),
       );
     ```
2. `routes/audit.ts`: parse `const shareId = req.query.shareId;` →
   `if (typeof shareId === 'string' && shareId.length > 0) q.shareId = shareId;`
3. Tests (`auditLog.test.ts`, `routes/audit.test.ts`):
   - query `{shareId:X}` matches a row with top-level `shareId:X`, a row with
     `actorTokenId:X`, a row with `detail.shareId:X`; excludes an unrelated row.
   - `detail.shareId` non-string (number/object) does NOT match (typeof guard).
   - route maps `?shareId=X` → query; empty/absent → no filter.

## Commit 3 — lifecycle-row tagging (no auth touch)

`feat(rc-gateway): tag share lifecycle audit rows with shareId+shareLabel`

1. `routes/share.ts`:
   - `share_created`: add `shareId: id, shareLabel: label` (top-level).
   - `share_revoked`: add `shareId: id, shareLabel: rec.label` (`rec` from the
     existing `listShares().find`).
   - whoami `share_redeemed` + `share_exhausted`: add `shareId: id,
shareLabel: info.label`.
2. Tests (`routes/share.test.ts`): a minted share's `share_created` row has
   `shareId`+`shareLabel`; revoke row likewise; whoami redeem/exhaust rows
   likewise. Filtering `GET /rc/audit?shareId=<id>` returns the lifecycle rows
   with the label.

## Commit 4 — WIRE auth (hot path, LAST): rcClient enrichment + guest-row stamping

`feat(rc-gateway): stamp share label on guest view/approve/push audit rows`

1. `tokenStore.ts` `resolve()`: return type gains `shareLabel?: string`; on a
   match, include `shareLabel: rec.label` only when `rec.sessionLockId !==
undefined` (else omit). DECISION logic unchanged.
2. `types.ts`: `rcClient?: { id; scopes; sessionLockId?; shareId?: string;
shareLabel?: string }`.
3. `auth.ts` `bearerResolve`: after `req.rcClient = resolved;` — when
   `resolved.sessionLockId !== undefined`, set
   `req.rcClient.shareId = resolved.id; req.rcClient.shareLabel = resolved.shareLabel;`
   (Keep `resolved` spread minimal — assign explicitly so a non-share token
   never gets the fields.)
4. Stamp guest rows with `shareId: req.rcClient?.shareId, shareLabel:
req.rcClient?.shareLabel`:
   - `routes/sessionEvents.ts`: `session_attached` + `session_detached`
     (capture `shareId`/`shareLabel` into locals alongside `actorTokenId` at
     handler top, since `req` is in scope in the finally too).
   - `routes/permission.ts`: `permission_voted`.
   - `routes/push.ts`: `push_subscribed`, `push_unsubscribed`,
     `push_prefs_updated`.
5. Tests:
   - `tokenStore.test.ts`: resolve() of a share returns `shareLabel`; resolve()
     of a normal token has `shareLabel === undefined`.
   - `auth.test.ts` (or a small new one): bearerResolve sets rcClient.shareId/
     shareLabel for a share token, leaves them undefined for a normal token.
   - `routes/sessionEvents.test.ts` + `routes/permission.test.ts`: with a share
     token (minted via issueShare), the emitted audit rows carry the share
     label; with a normal token they don't. Use the stub/capturing daemon +
     a real `TokenStore.issueShare`.

## Review + verify

- `advisor` before declaring done.
- opus adversarial review on `git diff 036241d63..HEAD` — dimensions: audit
  privacy (no new secret class), filter soundness (no false positives/cross-
  share bleed), resolve()/auth correctness (decision unchanged, no perf/΅
  timing regression, share-vs-normal discrimination), back-compat (old rows
  lack fields, still queryable), async-route hygiene (no new unguarded await),
  the D6 `--share-id == --actor` degradation is intended not a leak.
- Apply fixes + regression tests.
- From repo root: `npm run typecheck|lint|build|test --workspace
@qwen-code/rc-gateway` + `node scripts/rc-gateway-e2e.mjs`.
- `git diff --name-only 036241d63..HEAD` shows only `packages/rc-gateway/` +
  `docs/superpowers/`.
- Push; update both memory files.
