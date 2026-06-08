# Remote-Control Gateway — WebPush Part 1: VAPID + Subscriptions (Design)

**Date:** 2026-06-07
**Status:** Proposed (cycle 8)
**Scope:** The gateway-owned backend for WebPush notifications — self-managed VAPID
keypair and token-bound push-subscription CRUD. This is **part 1 of 2** of the
`add-webpush-notifications` proposal. Part 2 (cycle 9) is the send pipeline +
service worker + web-client enrollment.

## Relationship to the OpenSpec proposal

`add-webpush-notifications` is a ~7–8 day proposal whose `design.md` puts VAPID,
subscriptions, and the sender **inside the daemon** (`packages/cli/src/serve/
remoteControl/webpush/`) and bumps the daemon's token-store schema. We **deviate**
to honor the zero-upstream-edits invariant:

- VAPID keypair is **gateway-owned**, stored at `~/.qwen/rc/vapid.json` (not PEM
  files in the daemon). web-push uses base64url keys, so JSON is the natural format.
- The application-server (public) key is exposed via a **gateway route**
  (`GET /rc/push/vapid`), since we cannot add a `remoteControl.webpush` block to
  the daemon's `/capabilities`.
- Subscriptions live in a **gateway-owned store** (`~/.qwen/rc/push-subscriptions.json`),
  bound to the gateway's own token ids — not a `push_subscriptions` table in the
  daemon's token DB.

The user-facing capability (a device can enroll for push) is identical; only the
host of the state differs. The send pipeline (cycle 9) will feed off the gateway's
own persistent daemon-SSE subscription so it can push when no browser tab is open.

## This cycle's slice (and non-goals)

**In:** VAPID generate-or-load + persist; expose public key; 4 subscription
routes (subscribe / list-own / delete-own, with owner `?all=true`); 2 audit
actions. All gateway-side, fully unit-testable, **no browser dependency**.

**Out (→ cycle 9):** the send pipeline (queue, retry, 410-removal), payload
builder, per-subscription preferences / quiet-hours / rate-limit, the service
worker, and the web-client "Enable notifications" enrollment UI. Also out: VAPID
rotation command, send-test command (proposal Phase 4).

## Decisions

1. **VAPID via the `web-push` library** (pinned `web-push@^3.6.7`, `@types/web-push`
   devDep — both already installed). `generateVAPIDKeys()` for keygen;
   `setVapidDetails`/`sendNotification` are cycle 9.
2. **Keys stored as base64url JSON** at `~/.qwen/rc/vapid.json`, mode **0600**
   (the private key is a secret). Generated lazily on first access; reused
   thereafter. The private key is **never** returned by any route and **never**
   logged/audited.
3. **Subscriptions gated by `session:read`** — being paired-and-able-to-watch
   implies "can be notified." No new scope (avoid proliferation; the boot grant
   already includes `session:read`). Owner-only operations (`?all=true` listing,
   deleting another token's subscription) are checked **inside** the route against
   `req.rcClient.scopes` including `owner`.
4. **Subscriptions are token-bound and de-duplicated by endpoint.** Re-subscribing
   the same `(tokenId, endpoint)` returns the existing record id instead of
   creating a duplicate (idempotent enrollment).
5. **Subject** from env `QWEN_RC_WEBPUSH_SUBJECT`, default `mailto:noreply@<hostname>`
   (used by the sender in cycle 9; resolved + stored by the VAPID store now so the
   contract is stable).
6. **Audit logs ids only, never endpoints.** A push subscription endpoint is a
   capability URL to the user's device — treat it as sensitive. Audit detail
   carries `{ subscriptionId }`, never the endpoint or keys.

## Components

### VAPID store (`src/webpush/vapid.ts`) — new

```ts
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}
export class VapidStore {
  static open(filePath: string, subject?: string): Promise<VapidStore>;
  getApplicationServerKey(): string; // base64url public key (for clients)
  getKeys(): VapidKeys; // for the sender (cycle 9)
  getSubject(): string; // mailto:/https: subject
}
```

- `open()` reads `filePath`; if absent or malformed, calls
  `webpush.generateVAPIDKeys()` and writes `{ publicKey, privateKey }` JSON with
  mode 0600 (mkdir -p the dir first). Returns a store holding the keys in memory.
- `subject` defaults to `process.env.QWEN_RC_WEBPUSH_SUBJECT ?? 'mailto:noreply@' + hostname()`.
- The private key is held in memory and exposed only via `getKeys()` (consumed by
  the cycle-9 sender). No route exposes it.

### Push subscription store (`src/pushStore.ts`) — new

```ts
export interface PushSubscriptionRecord {
  id: string; // random 128-bit hex
  tokenId: string; // owning token id
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
}
export class PushStore {
  static open(filePath: string, nowFn?: () => number): Promise<PushStore>;
  add(
    tokenId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): Promise<PushSubscriptionRecord>;
  listFor(tokenId: string): PushSubscriptionRecord[];
  listAll(): PushSubscriptionRecord[];
  get(id: string): PushSubscriptionRecord | undefined;
  remove(id: string): Promise<boolean>; // persists; false if absent
}
```

- JSON file at the given path, mode 0600. `add()` de-dups by `(tokenId, endpoint)`:
  if a record with the same tokenId+endpoint exists, return it unchanged. Persist is
  **awaited** before resolving (durability lesson from cycle 2's revoke fix).
- `id` is a random 128-bit hex (crypto.randomBytes), like the token-store id style.

### Audit actions (`src/auditLog.ts`)

Add `'push_subscribed'` and `'push_unsubscribed'` to the `AuditAction` union and
`AUDIT_ACTIONS`.

### Routes (`src/routes/push.ts`) — new

All mounted after the prompt route, each `requireScope(SESSION_READ, audit)`:

- **`GET /rc/push/vapid`** → `200 { applicationServerKey }`. (Lets a paired client
  call `pushManager.subscribe({ applicationServerKey })`.)
- **`POST /rc/push/subscribe`** body `{ subscription: { endpoint, keys:{ p256dh, auth } } }`:
  validate all three are non-empty strings (else `400 invalid_subscription`); store
  bound to `req.rcClient.id`; `201 { id }`. Audit `push_subscribed {subscriptionId}`.
- **`GET /rc/push/subscriptions`** → `200 { subscriptions: [{ id, endpoint, createdAt }] }`
  for the caller's own. If `?all=true`: require `owner` scope (else `403
insufficient_scope`), return all records including `tokenId`.
- **`DELETE /rc/push/subscriptions/:id`**: look up by id. If not found → `404`. If
  found and (owned by caller **or** caller has `owner`) → remove → `204` + audit
  `push_unsubscribed {subscriptionId}`. If found but owned by another and caller
  lacks `owner` → `404` (do not reveal existence).

### Wiring (`src/server.ts`)

`createGatewayApp` builds `VapidStore` and `PushStore` (paths from new optional
`GatewayDeps.vapidPath` / `pushStorePath`, defaulting under `~/.qwen/rc/`). Because
their `open()` is async, either (a) make a small async factory the CLI awaits, or
(b) pass already-opened stores in via deps. **Decision:** add an async
`createGatewayApp` variant is overkill — instead `VapidStore`/`PushStore` are
constructed by the **caller** (cli.ts / tests) via their async `open()` and passed
in through `GatewayDeps` (`deps.vapid`, `deps.pushStore`). This keeps
`createGatewayApp` synchronous (matching today) and makes the stores trivially
mockable in tests. Routes are mounted after `requireScope` setup.

### CLI (`src/cli.ts`)

Before building the app, `await VapidStore.open(...)` and `await PushStore.open(...)`
and pass them in deps. Add one banner line: `webpush: enabled (key …<8 chars>)`.

### Stub daemon

No change — push routes never touch the daemon.

## Error model

| Condition                                   | Response                   |
| ------------------------------------------- | -------------------------- |
| Missing/invalid bearer                      | `401 unauthorized`         |
| Token lacks `session:read`                  | `403 insufficient_scope`   |
| `?all=true` without `owner`                 | `403 insufficient_scope`   |
| Malformed subscription body                 | `400 invalid_subscription` |
| Delete unknown / not-owned-and-not-owner id | `404 not_found`            |
| Subscribe ok                                | `201 { id }`               |
| Delete ok                                   | `204`                      |

## Testing strategy (TDD)

**`src/webpush/vapid.test.ts`:** first `open()` on a temp path generates + persists
a keypair (file exists, mode 0600, valid base64url public key); a second `open()`
reuses the same keys (no regeneration); malformed file → regenerates; subject
honors the env var and falls back to `mailto:noreply@<hostname>`; `getKeys()`
returns a private key but no route/serialization path exposes it.

**`src/pushStore.test.ts`:** add → listFor returns it; add same (tokenId,endpoint)
twice → one record, same id (idempotent); add same endpoint under a different
tokenId → distinct record; listAll spans tokens; remove returns true then false;
persistence survives reopen (await durability).

**`src/routes/push.test.ts` (mini express app, injected `req.rcClient`):**

- `GET /rc/push/vapid` → 200 with the store's key.
- subscribe valid → 201 + audit `push_subscribed`; malformed → 400.
- list-own returns only caller's; another token's are absent.
- `?all=true` as non-owner → 403; as owner → all incl. tokenId.
- delete own → 204 + audit; delete other's as non-owner → 404; as owner → 204.
- audit entries contain the subscriptionId and **no endpoint string** (assert
  serialized entry excludes the endpoint).

**`src/server.test.ts`:** boot with injected stores; mint a `session:read` token;
subscribe round-trip returns 201 and `GET` lists it; a token without `session:read`
→ 403.

**Manual e2e (`scripts/rc-gateway-e2e.mjs`):** with the boot owner token, `GET
/rc/push/vapid` → 200 with a key, then subscribe a synthetic subscription → 201,
list → contains it, delete → 204. (Pure gateway; the real daemon only needs to be
up for the gateway to boot.)

## File boundary / isolation

All within `packages/rc-gateway/` — zero upstream-file edits. New: `src/webpush/
vapid.ts` (+test), `src/pushStore.ts` (+test), `src/routes/push.ts` (+test).
Modified: `src/auditLog.ts` (2 actions), `src/server.ts` (deps + wire), `src/cli.ts`
(open stores + banner), `src/index.ts` (exports), `src/server.test.ts`,
`scripts/rc-gateway-e2e.mjs`, `package.json` (web-push deps — already added).

## Follow-on

Cycle 9 (`add-webpush-notifications` part 2): the gateway's persistent daemon-SSE
pump → payload builder (metadata-only, ≤140-char summary) → `web-push` sender with
exponential backoff + 410/404-removal → service worker (`public/sw.js`) push +
notificationclick (approve/deny via the cycle-6 vote route) → web-client "Enable
notifications" enrollment. Browser delivery is **verified-locally-only** (headless
WSL can't exercise a real push service); gateway-side sender logic is unit-tested
with a fake transport. Then cycle 10: prefs / quiet-hours / rate-limit / coalescing.
