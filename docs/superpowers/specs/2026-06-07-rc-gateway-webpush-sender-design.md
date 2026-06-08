# Remote-Control Gateway — WebPush Part 2: Send Machinery (Design)

**Date:** 2026-06-07
**Status:** Proposed (cycle 9)
**Scope:** The gateway-side "given an event, deliver a push" machinery — payload
builder, web-push sender (retry + dead-subscription removal), notifier fan-out
(scope-filtered), and an owner-gated `POST /rc/push/test` to exercise it. **Part 2
of 3** of `add-webpush-notifications`. Builds on cycle 8 (VAPID + subscriptions).

## Relationship to the proposal / deviation

Same gateway deviation as cycle 8: this lives in `packages/rc-gateway/`, not the
daemon. This cycle implements proposal Phase 2.1 (payload), 2.2 (sender + retry),
2.3 (scope-gated filtering), and a slice of Phase 4.2 (send-test). **Out (→ cycle
10):** the live `SessionEventPump` that auto-triggers the notifier from daemon SSE.
**Out (→ cycle 11):** the service worker + web-client enrollment. **Out (later):**
per-subscription preferences / quiet-hours / rate-limit / coalescing (Phase 2.4).

Browser delivery cannot be exercised in headless WSL (no real push service), so
the sender's network path is **verified-locally-only**; all logic is unit-tested
behind an **injected transport** (a fake `sendNotification`).

## Decisions

1. **Injected transport.** `PushSender` takes a `transport: (sub, payloadJson) =>
Promise<{ statusCode: number }>` (default wraps `web-push.sendNotification`
   after `setVapidDetails(subject, pub, priv)`). Tests inject a fake to assert
   retry/removal without network.
2. **Retry policy.** Transient (network error, or statusCode 429/5xx): retry with
   backoff, max 5 attempts. Backoff delays are an **injected array** (default
   `[1000,2000,4000,8000,16000]`; tests pass `[0,0,…]`) so tests are fast.
   Permanent (404/410/403): **remove** the subscription from `PushStore` + audit
   `push_subscription_expired`. Other non-2xx after retries exhausted → audit
   `push_send_failed`, give up (keep subscription).
3. **Metadata-only payloads.** `buildPayload(event, ctx)` returns `null` for
   non-notifiable events, else `{ v:1, kind, sessionId, sessionName?, summary,
url }`. `summary` ≤140 chars (truncate with `…`). `url` is a relative deep link
   `/ui/?session=<id>` (no token, no secrets). **No tool args, no file paths
   beyond bare filenames, no prompts.** Supported kinds this cycle:
   - `permission_request` → `kind:'permission.required'`, summary
     `"Permission needed: <toolName>"` (toolName read defensively from
     `data.toolCall.name`/`data.toolCall.title`/`data.toolName`; fallback
     `"a tool call"`). Carries `requestId` (from `data.requestId`) for the future
     service-worker approve/deny.
   - synthetic `task.completed` (used by the test route) → summary
     `"Task finished"`.
     Unknown types → `null`.
4. **Scope-gated fan-out.** A subscription only receives a kind if its owning
   token has the kind's required scope:
   - `permission.required` → requires `approve`.
   - `task.completed` → requires `session:read`.
     Suppressed (scope-mismatch) sends are **not audited** (avoid noise, per Phase
     2.3). The notifier resolves a token's scopes via a new
     `TokenStore.scopesFor(id)`.
5. **Audit:** new actions `push_sent` (`{subscriptionId, kind}`),
   `push_send_failed` (`{subscriptionId, kind, statusCode?}`),
   `push_subscription_expired` (`{subscriptionId, statusCode}`). Never the
   endpoint, never payload contents beyond the `kind`.

## Components

### Payload (`src/webpush/payload.ts`) — new

```ts
export interface PushPayload {
  v: 1;
  kind: string;
  sessionId: string;
  sessionName?: string;
  summary: string; // ≤140
  url: string; // '/ui/?session=<id>'
  requestId?: string; // present for permission.required
}
export function buildPayload(
  event: { type: string; data: unknown },
  ctx: { sessionId: string; sessionName?: string },
): PushPayload | null;
```

### Sender (`src/webpush/sender.ts`) — new

```ts
export interface PushTransportResult {
  statusCode: number;
}
export type PushTransport = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payloadJson: string,
) => Promise<PushTransportResult>;

export interface PushSenderOptions {
  transport?: PushTransport; // default: web-push.sendNotification
  backoffMs?: number[]; // default [1000,2000,4000,8000,16000]
  sleep?: (ms: number) => Promise<void>;
}
export class PushSender {
  constructor(
    vapid: VapidStore,
    store: PushStore,
    audit?: AuditRecorder,
    opts?: PushSenderOptions,
  );
  /** Send one payload to one subscription record; handles retry + removal. */
  send(record: PushSubscriptionRecord, payload: PushPayload): Promise<void>;
}
```

- The default transport lazily `setVapidDetails(vapid.getSubject(),
vapid.getApplicationServerKey(), vapid.getKeys().privateKey)` once, then
  `sendNotification(sub, payloadJson)` and maps the result/`WebPushError` to a
  `statusCode`. A thrown non-`WebPushError` (network) → treated as transient
  (statusCode 0 / `undefined`).
- Classify: 2xx → done + `push_sent`. 404/410/403 → `store.remove(id)` +
  `push_subscription_expired`, stop. 429/5xx/network → retry per backoff; after the
  last attempt → `push_send_failed`. **`send` never throws** (best-effort, like the
  audit log).

### Notifier (`src/webpush/notifier.ts`) — new

```ts
export class PushNotifier {
  constructor(tokens: TokenStore, store: PushStore, sender: PushSender);
  /** Fan a daemon event out to all scope-eligible subscriptions. */
  notify(
    event: { type: string; data: unknown },
    ctx: { sessionId: string; sessionName?: string },
  ): Promise<void>;
  /** Send a synthetic payload to one token's own subscriptions (test route). */
  notifyToken(tokenId: string, payload: PushPayload): Promise<void>;
}
```

- `notify`: `buildPayload`; if null return. For each `store.listAll()` record:
  resolve `tokens.scopesFor(record.tokenId)`; if it has the kind's required scope,
  `sender.send(record, payload)`. Sends run concurrently (`Promise.all`); `send`
  never throws so one bad endpoint can't break the fan-out.

### TokenStore addition (`src/tokenStore.ts`)

Add `scopesFor(id: string): RcScope[] | undefined` (look up the record by id,
return a copy of its scopes). Pure read, no I/O.

### Test route (`src/routes/push.ts`)

Add `POST /rc/push/test` to the push router, **owner-gated inside the handler**
(the router is mounted under `session:read`; require `owner` in-handler, else 403).
Body optional `{ sessionId? }` (default `'test'`). Builds a synthetic
`task.completed` payload (`buildPayload({type:'__test__'...})` — actually construct
the payload directly to avoid a fake event type) and calls
`notifier.notifyToken(req.rcClient.id, payload)`. Returns `200 { sent: <count of
the caller's subscriptions> }`. (Delivery success is async/best-effort; the count
is how many subscriptions it attempted.)

### Wiring (`src/server.ts`)

When `deps.vapid && deps.pushStore`: build `const sender = new PushSender(vapid,
pushStore, audit)`, `const notifier = new PushNotifier(store, pushStore, sender)`,
and pass `notifier` into `createPushRouter(...)` (new param) so the test route can
use it. (The notifier is also what cycle 10's pump will call — export it / make it
retrievable; simplest: construct it here and also stash on the returned app or
return via a richer factory. **Decision:** keep it internal this cycle; cycle 10
will refactor `createGatewayApp` to also build+return the pump. For now the notifier
is created inside and handed to the router only.)

## Error / behavior model

| Condition                              | Result                                             |
| -------------------------------------- | -------------------------------------------------- |
| `POST /rc/push/test` non-owner         | `403 insufficient_scope`                           |
| `POST /rc/push/test` owner, N own subs | `200 { sent: N }`; pushes attempted async          |
| transport 2xx                          | `push_sent`                                        |
| transport 410/404/403                  | subscription removed + `push_subscription_expired` |
| transport 429/5xx/network, retries out | `push_send_failed` (subscription kept)             |
| scope mismatch for a kind              | silently skipped (no audit)                        |

## Testing strategy (TDD)

**`payload.test.ts`:** permission_request → permission.required with toolName in
summary, requestId carried, url `/ui/?session=s1`; missing toolName → fallback;
summary truncated to ≤140 with `…`; unknown type → null; no tool args/paths leak
(assert summary excludes a planted secret arg).

**`sender.test.ts`** (fake transport, `backoffMs:[0,0,0,0,0]`):

- 201 → one `push_sent`, no removal.
- 410 → `store.remove` called, `push_subscription_expired`, no retry.
- 503 then 201 → retried, then `push_sent`.
- persistent 503 → 5 attempts then `push_send_failed`, subscription kept.
- network throw then 201 → retried.
- `send` never throws even if audit throws.

**`notifier.test.ts`:** two subs under tokens with different scopes; a
permission.required event → only the `approve`-scoped sub's token gets a send (the
`session:read`-only one is skipped, no audit); `notifyToken` sends only that
token's own subs.

**`routes/push.test.ts`** (extend): `POST /rc/push/test` as non-owner → 403; as
owner with 1 sub → 200 `{sent:1}` and the fake transport saw a `task.completed`
payload.

**`server.test.ts`** (extend): owner token, subscribe, `POST /rc/push/test` → 200.

**e2e:** `POST /rc/push/test` with the boot owner token after subscribing a dummy
endpoint → 200 `{sent:≥1}`; the real send to the dummy endpoint will fail/expire
(network/410) which is fine — asserts the route + fan-out wiring, not delivery.

## File boundary

All within `packages/rc-gateway/` (+ e2e script). New: `src/webpush/payload.ts`,
`src/webpush/sender.ts`, `src/webpush/notifier.ts` (+ tests). Modified:
`src/tokenStore.ts` (scopesFor), `src/auditLog.ts` (3 actions), `src/routes/push.ts`
(test route + notifier param), `src/server.ts` (build sender/notifier), `src/index.ts`
(exports), `src/routes/push.test.ts`, `src/server.test.ts`, `scripts/rc-gateway-e2e.mjs`.

## Follow-on

Cycle 10: `SessionEventPump` — discover sessions via `listWorkspaceSessions(caps.
workspaceCwd)`, run a persistent `subscribeEvents(sessionId)` loop per session
(reconnect on drop, add/remove sessions on a poll), calling
`notifier.notify(event, {sessionId, sessionName})`. Tested against the stub daemon.
Cycle 11: service worker (`public/sw.js`) push + notificationclick (approve/deny via
the cycle-6 vote route) + web-client "Enable notifications" enrollment.
