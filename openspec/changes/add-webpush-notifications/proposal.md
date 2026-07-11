# add-webpush-notifications

## Why

After `add-remote-control` ships, the user can answer approval prompts
from any device — but only if they happen to have the web client open
when the prompt fires. For long unattended tasks (the same use case
`add-policy-engine` targets), this gap means the user must keep a tab
open and visible. Push notifications close the loop: the agent pings
the user's phone (or laptop) when attention is needed, and the user
unlocks the device, taps the notification, and is dropped straight
into the relevant session.

We do this with the open WebPush standard (RFC 8030 + RFC 8291), VAPID
identification (RFC 8292), and the operator's own VAPID keypair. There
is no Anthropic-style vendor relay. The push provider (Mozilla,
Google, Apple) is the only third party in the path, and they see only
ciphertext metadata, not message contents.

## What Changes

- **VAPID keypair self-managed.** The daemon generates a P-256 keypair
  on first start at `~/.qwen/rc/vapid.{pub,priv}.pem` (mode 0600 on
  private key). The public key is exposed via
  `GET /capabilities` → `remoteControl.webpush.applicationServerKey` in
  base64url so the web client can call
  `pushManager.subscribe({ applicationServerKey })`.
- **Subscription management endpoints.** `POST /rc/push/subscribe`
  stores a subscription record bound to the caller's token. `GET
/rc/push/subscriptions` lists the caller's own. `DELETE
/rc/push/subscriptions/:id` removes one. Owner-scope can list/revoke
  any subscription via `?all=true`.
- **Send pipeline.** Daemon background task watches a queue and posts
  encrypted notifications to subscription endpoints with exponential
  backoff. Permanent failures (`410 Gone`, `404`) auto-remove the
  subscription. Transient failures (5xx, network) retry up to 5 times.
- **Payload schema is metadata-only.** A push payload includes
  session id, session name, brief event tag (e.g.
  `"permission.required"`, `"task.completed"`), a one-line
  human-readable summary (≤140 chars), and a deep-link URL.
  No tool args, no file paths beyond bare filenames, no prompts.
  Anything sensitive is fetched by the client over the authenticated
  HTTP channel after the user taps the notification.
- **Action buttons** for `permission.required` payloads where the
  browser supports them (Chrome/Edge/Firefox): "Approve", "Deny",
  "Open". Service worker handles the click and posts a vote via the
  daemon. Safari + iOS get a single tap-to-open behavior.
- **Per-subscription preferences.** Each subscription stores which
  event categories it wants (`permission.required`, `task.completed`,
  `policy.deny`, `session.died`, `audit.material`, `mention`). Modified
  via `PATCH /rc/push/subscriptions/:id`.
- **Quiet hours and rate limit.** Per-subscription `quietHours`
  (`from`, `to`, `timezone`) and `maxPerHour` (default 30) prevent
  notification storms.

## Capabilities

### New Capabilities

- `webpush-notifications` — VAPID self-management, subscription
  endpoints, encrypted payload schema, send pipeline, per-subscription
  preferences, threat model.

## User Stories

**N1. First pairing also enrolls push.** I pair my phone via the web
client. Right after pairing succeeds, the PWA prompts for notification
permission. I accept; the PWA calls `pushManager.subscribe()` and the
resulting endpoint is POSTed to `/rc/push/subscribe` with my token.

**N2. Overnight task pings only on what matters.** I'm running an
overnight test loop with `add-policy-engine` allow rules covering 95%
of operations. The 5% that fall through to prompt produce push
notifications on my phone. The 95% are silent. Audit log shows the
breakdown in the morning.

**N3. Approve from the lock screen.** A `permission.required` push
arrives on Android. I long-press, tap "Approve", and the service
worker posts the vote to the daemon. The lock-screen tile shows
"Approved." The web client (when next opened) reflects the resolved
state from the WAL replay.

**N4. Quiet hours.** I set quiet hours 23:00–07:00. Between those
times, only `policy.deny` and `session.died` events page; the rest
silently queue and deliver at 07:00 in a single digest.

**N5. Forgotten subscription.** Three months later my phone's
subscription endpoint dies (browser uninstall). The first push to it
returns `410 Gone`; the daemon removes the subscription and writes an
audit entry. No further attempts.

## Impact

- **qwen-code repo**: new module
  `packages/cli/src/serve/remoteControl/webpush/` containing
  `vapid.ts` (keypair management), `subscriptions.ts` (token-bound
  storage), `sender.ts` (queue + retry), `payload.ts` (envelope and
  encryption helpers). Integration in `server.ts` for the three new
  routes.
- **Token store schema bump**: add `push_subscriptions` table
  referencing `tokens.id`.
- **Capability response**: `remoteControl.webpush` block added.
- **Web client**: pairing UI gains "Enable notifications" step. New
  service worker handles push events and notification clicks.
  Settings panel for prefs and quiet hours.
- **Dependencies**: one new npm dep (`web-push` or equivalent for RFC
  8291 encryption). Documented and pinned.
- **Out of scope** (deliberately):
  - APNs/FCM direct (we use the browser-standard WebPush instead,
    which transitively uses these providers but does not require
    Apple/Google developer accounts).
  - SMS/email notification. Operator can add a bridge later
    (`add-bridge-protocol`).
  - In-app foreground notifications (those are PWA territory, not
    push).
  - Notification grouping/threading by session (Phase 3 if needed;
    not core).
