# Design — rc-gateway share `max_uses` / `share_exhausted` (cycle 26, add-link-share L2)

**Proposal:** `add-link-share` (link-share core — session-locked TTL guest
tokens — already done in an earlier cycle; this adds the use-count bound).
**Date:** 2026-06-09.
**Branch:** `add-remote-control-spec`.

## Goal of this slice

Bound a share link by **number of redemptions** (`max_uses`), the proposal's
story **L2** ("single-use, view-only; the second attempt to use the same URL
401s with `share_exhausted`"). A share carries an optional `maxUses`; each
distinct browser-session redemption consumes one use; once exhausted the next
redemption returns `410 Gone` with code `share_exhausted`.

## Deviation note

The proposal's design.md stores `max_uses`/`uses` as SQLite columns on the
daemon's `tokens.db` and bumps them with an atomic SQL `UPDATE ... WHERE uses <
max_uses`. We deliver the same semantics gateway-side: the counter lives on the
gateway's JSON `TokenStore` record and the atomic check-and-bump is a synchronous
in-memory mutation (single-threaded event loop — see D2). The daemon stays
unmodified; all edits inside `packages/rc-gateway/`.

## Decisions

### D1 — `uses` counts redemptions (browser sessions), NOT HTTP requests

Per the design's **D4**. Counting raw requests would make `maxUses: 5` mean
"five GETs," exhausted instantly by an SSE reconnect. Instead a use is consumed
**once per distinct browser session** at a dedicated, authenticated redemption
endpoint (D3), deduped by a redemption cookie (D4).

### D2 — Consumption lives ONLY at the redemption endpoint, never in `resolve()`

Two independent reasons, both load-bearing:

1. **Unfurl/prefetch safety (the real reason the endpoint is split).** When the
   owner pastes the share URL into Slack/iMessage/etc., an unfurl bot fetches
   `GET /ui/share/<token>` (the future bootstrap page) with **no** `Authorization`
   header. If a use were consumed on that public GET, a single paste would burn a
   use before the human ever clicks. By putting the bump behind
   `requireScope(SHARE)` on an authenticated XHR (`GET /rc/share/whoami`), only a
   real redemption by a token holder counts; link-unfurlers and prefetchers
   cannot consume.
2. **`resolve()` is the auth hot path.** It runs on every authenticated request;
   bumping a counter (and doing persist I/O) there would both re-introduce the
   request-counting bug D1 rejects and slow every call. It stays read-only w.r.t.
   `uses`.

**An exhausted share still `resolve()`s for an already-redeemed session.** The
design's state machine 410s only the _next_ redemption (a fresh browser session);
the session that pushed `uses` to `maxUses` keeps working until TTL/revoke.
Gating `resolve()` on `uses` would kill live sessions — so leaving it out is
correct, not merely convenient. `maxUses` is therefore a **soft browser-session
cap** (a raw bearer-token holder bypasses it); **TTL + revoke remain the hard
bounds**, exactly as the proposal's own D4 frames it.

### D3 — Redemption endpoint `GET /rc/share/whoami`, gated `requireScope(SHARE)`

The existing `/rc/share` router is owner-gated (`requireScope(OWNER)`), so the
guest-reachable redemption route must be mounted **separately and before it**,
behind `requireScope(SHARE)` (only share tokens carry `SHARE`). It returns the
watermark/bootstrap metadata the guest needs:
`{ sessionId, scope, label, expiresAt, usesRemaining }` (sessionId =
`rcClient.sessionLockId`; scope = `approve` if the token has `APPROVE` else
`view`). No secret material.

Behavior:

- **Redemption cookie present** (`rc_share_<id>` for THIS share id) → already
  counted this browser session → return metadata, do NOT bump.
- **Absent** → `store.consumeUse(id)`:
  - `exhausted` → `410 { code: 'share_exhausted' }` + audit `share_exhausted`.
  - `ok` → set the httpOnly redemption cookie (`SameSite=Strict`, `Max-Age`≈ttl),
    audit `share_redeemed`, return metadata with the post-bump `usesRemaining`.

The cookie is keyed by share id so redeeming share A doesn't suppress share B's
first bump in the same browser. The handler **catches its own async errors**
(persist can throw EACCES/ENOSPC — the recurring async-route bug class): wrap the
body, `if (!res.headersSent) res.status(500)`.

### D4 — `TokenStore.consumeUse(id)`: synchronous atomic check-and-bump

```
consumeUse(id):
  rec = find(id); if !rec → { ok: false, reason: 'not_found' }
  used = rec.uses ?? 0
  if rec.maxUses !== undefined && used >= rec.maxUses → { ok:false, reason:'exhausted' }
  rec.uses = used + 1            // in-memory bump FIRST (synchronous)
  await persist()               // the only await — after the guard+bump
  return { ok:true, usesRemaining: rec.maxUses === undefined ? null : rec.maxUses - rec.uses }
```

The guard and the increment are synchronous with **no `await` between them**, so
the single-threaded event loop cannot interleave a second request between check
and bump — this is the JS equivalent of the design's atomic SQL `UPDATE` and
needs **no explicit lock**. `uses` is normalized via `?? 0` on every read so a
pre-existing `tokens.json` record (written before this cycle, no `uses` field)
can never read as `NaN`/ghost-exhausted.

### D5 — `maxUses` on mint, clamped [1, 100]; `undefined` = unlimited

`POST /rc/share` accepts an optional `maxUses`; a finite number is clamped to
`[1, 100]` (design table), anything else → `undefined` (unlimited, today's
behavior). Threaded through `issueShare`. `share_created` audit detail gains
`maxUses`.

### D6 — `ShareInfo` + audit surface

`listShares()`/`ShareInfo` gain `maxUses?: number`, `uses: number`, and computed
`usesRemaining: number | null` (for the watermark + `qwen rc share list`). New
audit actions `share_redeemed` and `share_exhausted` are added to the
`AuditAction` union and `AUDIT_ACTIONS` runtime list.

### D7 — Fail-safe wiring order (survives a mid-cycle cut)

- **Commit 1 (inert):** `TokenStore` — `maxUses`/`uses` fields, `consumeUse`,
  `ShareInfo` additions, `issueShare` optional `maxUses` — plus tests. Nothing
  calls `consumeUse` yet and the route doesn't pass `maxUses`, so existing
  behavior is unchanged. Purely additive, backward-compatible reads.
- **Commit 2 (wiring):** the `whoami` redemption endpoint + its mount (before the
  owner-gated share router) + `POST /rc/share` `maxUses` param + audit enum +
  tests. A cut after commit 1 leaves tested, unused counter code wired to nothing.

## Files

- `src/tokenStore.ts`: `TokenRecord.maxUses?`/`uses?`; `issueShare` opt `maxUses`;
  `consumeUse(id)`; `ShareInfo`/`listShares` use-count fields.
- `src/tokenStore.test.ts`: consumeUse (bump, exhaust, unlimited, not_found,
  back-compat `uses` undefined), listShares use fields.
- `src/auditLog.ts`: add `share_redeemed`, `share_exhausted`.
- `src/routes/share.ts`: `POST` accepts/clamps `maxUses`; export the redemption
  handler (`createShareWhoamiRoute` or similar) used by the mount.
- `src/routes/share.test.ts`: maxUses minted + clamped; whoami bumps once; cookie
  forwarded by hand so refresh does NOT re-bump; exhaustion → 410 share_exhausted
  - audit; non-SHARE token 403.
- `src/server.ts`: mount `GET /rc/share/whoami` (requireScope(SHARE)) before the
  owner-gated `/rc/share`.
- `src/index.ts`: export any new public symbols if needed.

## Verification

- vitest: store (consumeUse atomic bump/exhaust/unlimited/not_found/back-compat;
  listShares fields) + routes (mint maxUses + clamp; whoami first-bump; cookie
  dedup with hand-forwarded Set-Cookie; 410 share_exhausted; non-share 403; own
  async-error catch). **The cookie test MUST read `res.headers.get('set-cookie')`
  from call 1 and pass it as `Cookie` on call 2** — Node `fetch` has no cookie
  jar, so without that the "no re-bump" assertion passes vacuously.
- `npm run typecheck|lint|build|test --workspace @qwen-code/rc-gateway`.
- `node scripts/rc-gateway-e2e.mjs` — stays green (no new e2e surface; the
  redemption path needs a share token + the live daemon's session, covered by
  units).
- `git diff --name-only <start>..HEAD` → only `packages/rc-gateway/` + docs.

## Honesty note (live effect)

With the `/ui/share/<token>` bootstrap page deferred (browser-only, a later
slice), **nothing calls `whoami` in the live browser flow yet**, so `max_uses` is
inert end-to-end until that page lands — same shape as cycle 25's
`task.completed` note. The server core (counter + endpoint + enforcement) is
fully unit-tested and headless-verified; the browser redemption flow is
**verified-locally-only** once the bootstrap page exists.

**Known limitation (cookie dedup, opus review MINOR):** the `rc_share_<id>`
cookie only suppresses a re-bump _after_ the first response sets it. Two
redemptions from the same browser arriving before that round-trip completes
(parallel first-paint XHRs, or an SSE bootstrap firing concurrently) each see no
cookie and each burn a use — so `uses` can over-count a single browser session.
This never _exceeds_ `maxUses` (not a double-spend) and `maxUses` is a soft cap
by design; the only call pattern that could trigger it is the deferred
`/ui/share/<token>` bootstrap page, which doesn't exist yet. When that page
lands, have it issue a single serial whoami before any parallel fetch, or move
to a server-stored redemption marker, to make the "once per browser session"
guarantee exact.

## Deferred (NOT in this slice)

`/ui/share/<token>` bootstrap HTML (sessionStorage + `history.replaceState` URL
scrub), the watermark banner + hide-write-UI (browser), L4 `share_id` audit
tagging on every guest action + `--share-id` filter, `qwen rc share` CLI,
`ttlSec` clamping [300, 2592000] (separable), server-stored redemption hash
(we use a self-contained per-id cookie instead — documented deviation).
