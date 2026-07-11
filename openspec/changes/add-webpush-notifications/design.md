# Design — add-webpush-notifications

## Context

WebPush (RFC 8030) lets a service push messages to user agents through
a push service operated by the browser vendor. Messages are encrypted
end-to-end between the application server (the daemon) and the user
agent (the browser/PWA) using a scheme defined by RFC 8291; the push
service sees only ciphertext and a TTL. VAPID (RFC 8292) lets the
application server identify itself via a signed JWT, replacing the
old "GCM API key" model with a vendor-agnostic identity. Together,
these give us a self-hosted push channel with no relay we need to
operate, just a keypair we own.

`add-remote-control` made the agent reachable; `add-policy-engine`
cut down the volume of approval prompts. Push closes the last gap:
the human is not at the screen, the agent needs attention, the
notification finds them.

## Goals / Non-Goals

**Goals:**

- Push approval prompts and task-completion events to the user's
  device with no relay we run ourselves.
- Encrypt payload contents; the push service never sees sensitive
  metadata.
- Allow inline action (approve/deny) where the browser supports it.
- Per-subscription preferences and quiet hours.
- Survive subscription churn (browser uninstall, key rotation)
  without operator action.

**Non-Goals:**

- APNs / FCM direct integration. WebPush already routes through them
  transparently.
- Notification persistence on the daemon beyond delivery confirmation.
  Once a push is queued and ack'd by the push service, the daemon
  forgets it. Replay through the existing SSE WAL covers "what
  happened while my push was offline."
- SMS, email, voice call notifications. Out of scope; use a sidecar
  bridge.
- Group/thread notifications, rich media (images). Phase 3 if
  warranted.

## Architecture

```
   Daemon
   ├── event bus (existing) ──▶ pushSender.enqueue(envelope)
   │
   ├── pushSender (queue)
   │     ├── filter via subscription prefs + quiet hours
   │     ├── encrypt per subscription (RFC 8291)
   │     ├── sign VAPID JWT (RFC 8292)
   │     ├── POST to subscription.endpoint
   │     └── on 410/404 → remove subscription
   │
   └── HTTP routes
         POST   /rc/push/subscribe
         GET    /rc/push/subscriptions
         PATCH  /rc/push/subscriptions/:id
         DELETE /rc/push/subscriptions/:id

   Push service (Mozilla / Google / Apple)
       │ ciphertext only
       ▼
   User agent (browser / PWA)
       │ decrypt with subscription key
       ▼
   Service worker
       ├── show notification with action buttons
       ├── on click → open or navigate web client
       └── on action → POST /permission/:id (bearer = stored token)
```

VAPID keypair lives at `~/.qwen/rc/vapid.{pub,priv}.pem`. The
private key never leaves the daemon process. The public key is
exposed via `/capabilities` so clients can pass it to
`pushManager.subscribe({ applicationServerKey })`.

## Payload schema

```jsonc
// Pre-encryption JSON, max 4 KiB after encryption (push service limit)
{
  "v": 1,
  "kind": "permission.required" | "task.completed" | "policy.deny"
        | "session.died"        | "audit.material"  | "mention",
  "sessionId": "ses_xxx",
  "sessionName": "my-overnight-run",
  "summary": "Approve: edit_file src/auth/login.ts",  // ≤140 chars
  "deepLink": "https://qwen.local:4170/ui/#/s/ses_xxx",
  "permission": {                       // present only when kind=permission.required
    "requestId": "perm_yyy",
    "toolName": "edit_file",
    "expiresAt": "2026-05-16T03:00:00Z" // permission times out at this point
  },
  "actions": [                          // hints for the SW; capped at 2
    { "id": "approve", "title": "Approve" },
    { "id": "deny",    "title": "Deny"    }
  ]
}
```

The payload is intentionally lean: a one-line summary, a deep-link,
and the bare minimum a service worker needs to act. The actual diff,
args, or transcript context is fetched by the web client AFTER the
user taps through. This is both a payload-size constraint (4 KiB
limit) and a privacy property (push service sees ciphertext, but
even if encryption were compromised, only metadata leaks).

## Auth & threat model

### Subscription identity

A subscription is owned by exactly one token. The token's scope
defines which event categories the subscription may receive:

| Scope     | Allowed kinds                                                                           |
| --------- | --------------------------------------------------------------------------------------- |
| `owner`   | All                                                                                     |
| `write`   | `permission.required` (where the user's vote matters), `task.completed`, `session.died` |
| `approve` | `permission.required`                                                                   |
| `read`    | `task.completed`, `mention` only                                                        |

Subscriptions inherit token expiry; when the token is revoked, all
its subscriptions are removed and a final "subscription revoked"
push is NOT sent (would leak revocation timing to the push service
operator).

### Threats

| Attacker                                     | Capability                                  | Mitigation                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Push service operator (Mozilla/Google/Apple) | See timing + size; cannot decrypt           | RFC 8291 encryption; TTL set short; payload size bounded.                                                                                      |
| Attacker captures subscription endpoint      | Can flood the push service on user's behalf | Endpoint alone is not sufficient — VAPID JWT signed with our private key required.                                                             |
| Leaked VAPID private key                     | Impersonate this daemon to the push service | Key gen at first start; rotation via `qwen rc push rotate-vapid`. Subscriptions re-bind on next page load.                                     |
| Leaked client token + endpoint               | Send DELETE for that token's subscriptions  | Same blast radius as token leak in general; revoke token to invalidate.                                                                        |
| Notification spoofing on device              | UI in another browser tab pretends to be us | Subscription is bound to the daemon's origin; service worker checks payload `v`+`kind` schema and ignores malformed.                           |
| Storm: 1000 events/sec → 1000 pushes/sec     | Rate-limit budget exhausted                 | Per-subscription `maxPerHour` default 30; daemon coalesces same-kind events within a 5 s window.                                               |
| Sensitive content in payload                 | Push service sees user data                 | Payload schema explicitly excludes tool args, file contents, prompt text. Audit linted to ensure no sensitive fields land in `summary`.        |
| Approve from a stolen unlocked phone         | Attacker votes via lock-screen action       | Inherent to push action model. Operator can disable inline actions per-subscription via prefs; deep-link-only mode requires unlock+web-client. |

### What does NOT leak

- Tool args, file paths beyond filename, prompt text.
- Internal session id contents (`ses_xxx` is opaque to the push
  service).
- The list of subscriptions (push service sees one endpoint per
  request, not a directory).

### What DOES leak (acknowledged)

- Timing: when the agent emits events the user cares about.
- Volume per subscription endpoint.
- A coarse `kind` value embedded in the cleartext header is NOT
  present — the entire payload is encrypted; only HTTP metadata
  (TTL, Urgency) is visible.

## Decisions

### D1 — Self-managed VAPID keypair, rotate manually

**Choice**: Generate a P-256 keypair at first daemon start. Store at
`~/.qwen/rc/vapid.{pub,priv}.pem`. Rotation is operator-initiated via
`qwen rc push rotate-vapid`, which generates a new pair and emits a
`vapid_rotated` SSE event so connected clients refresh
`applicationServerKey` and re-subscribe.

**Alternative considered**: Auto-rotate every N days.

**Why**: VAPID rotation invalidates all subscriptions (browsers tie
subscription to the application server key). Auto-rotation causes
silent push outages until each device's PWA reloads. Operator-
initiated rotation puts the operator in control of when the
disruption happens.

**Cost**: Operators who never rotate live forever on one key. Same as
any other long-lived key in their stack. Documented.

### D2 — Payload encrypted, no sensitive fields

**Choice**: Use RFC 8291 aes128gcm encryption for all payloads.
Payload schema excludes tool args, file paths beyond filename, and
prompt text. The `summary` field is hand-built per event kind and is
explicitly allowlisted in code.

**Alternative considered**: Encrypted but include full tool args.

**Why**: Encryption protects against the push service, but the
client (the browser / PWA) can be running on a partially-trusted
device. A leaked payload in browser storage or service-worker logs
shouldn't be a privacy incident. Keeping the payload metadata-only
limits blast radius.

**Cost**: User must tap through to see the full args. Acceptable;
the deep link is one tap.

### D3 — Inline action buttons where supported, deep-link elsewhere

**Choice**: When the user agent indicates support for action buttons
(Notification API `actions` array), include "Approve" and "Deny" for
`permission.required` payloads. Service worker posts the vote
directly. On Safari/iOS where actions are not supported, the
notification is tap-to-open.

**Alternative considered**: Always deep-link, never inline action.

**Why**: The whole point of push is to act without opening the app.
On Android/desktop where the browser supports it, that's a major UX
win. Falling back to tap-to-open on Safari is acceptable since the
PWA opens instantly and the approval card is right there.

**Cost**: Two code paths in the service worker; tested both.

### D4 — Quiet hours and rate limit at the subscription level

**Choice**: Each subscription stores its own `quietHours` and
`maxPerHour`. The send pipeline filters before sending. Filtered
events are summarized in a single "digest" push at the end of the
quiet window if anything was suppressed.

**Alternative considered**: Daemon-wide notification config.

**Why**: A user's laptop and phone have different appropriate quiet
hours. Per-subscription preferences let each device be tuned.

**Cost**: Slightly more storage and more thinking for the user.
Mitigated by sensible defaults.

### D5 — On 410/404, auto-remove subscription; no retry beyond bounds

**Choice**: Transient errors (5xx, network) retry with exponential
backoff up to 5 attempts. Permanent errors (410 Gone, 404 Not Found,
403 Forbidden) immediately remove the subscription and log an audit
event.

**Alternative considered**: Mark stale, retry hourly forever.

**Why**: Subscriptions die when browsers are uninstalled or service
workers unregistered. Hanging on to dead subscriptions is just
disk/CPU waste. Audit captures the removal so the user can
re-subscribe if it was unintended.

**Cost**: A user who briefly clears site data loses their
subscription and must re-enable. Acceptable.

### D6 — Same-kind coalescing within a short window

**Choice**: Within a 5-second window, multiple events of the same
`kind` from the same session collapse into one push ("3 permission
prompts pending in <session>"). The deep link still goes to the
session; the user sees all three on arrival.

**Alternative considered**: Always one push per event.

**Why**: A misbehaving task that fires 50 prompts in 10 seconds
should not produce 50 push notifications. Coalescing within a
session keeps the user's notification shade legible.

**Cost**: A delay of up to 5 seconds for the first event of a burst.
Acceptable for any human-relevant latency budget.

## Persistence

| Artifact                                 | Format                    | Lifecycle                                                    |
| ---------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| `~/.qwen/rc/vapid.pub.pem`               | PEM                       | Generated on first start; rotation event.                    |
| `~/.qwen/rc/vapid.priv.pem`              | PEM, 0600                 | Same.                                                        |
| `tokens.db` → `push_subscriptions` table | SQLite                    | Per-token records; deleted on token revoke.                  |
| Push send queue                          | In-memory + WAL'd backlog | Bounded queue; backlog persists across restart for ≤ 30 min. |

`push_subscriptions` columns:
`id PK, token_id FK, endpoint, p256dh, auth_secret, prefs (JSON),
quiet_hours (JSON), max_per_hour, last_used_at, failure_count,
created_at`.

## Risks / Trade-offs

| Risk                                         | Likelihood | Impact | Mitigation                                                                                |
| -------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------- |
| Browser push permission rejected             | M          | M      | UI shows permission status; explains what's lost; clear retry path.                       |
| iOS Safari push (since 16.4) flakiness       | M          | M      | PWA must be installed to home screen for push to work on iOS; instructions in pairing UI. |
| 4 KiB payload limit overrun                  | L          | M      | Schema includes a length cap on `summary`; emergency truncation with `…` marker.          |
| Push provider outage (Mozilla autopush down) | L          | M      | Daemon still works without push; events still flow via SSE/WS. Push is best-effort.       |
| Action button does not post vote (network)   | M          | L      | Service worker queues votes and retries; if user opens app, vote pending banner shows.    |
| Notification fatigue (too many)              | M          | M      | Defaults: `maxPerHour: 30`, quiet hours, same-kind coalescing.                            |

## Open questions

1. **Encrypt payload field-by-field or whole-blob?** Whole-blob per
   RFC 8291 is simpler and standard. Field-by-field would let some
   metadata be in cleartext for filtering. Going whole-blob.

2. **Should we ship our own VAPID JWT signing or use a library?**
   Library (`web-push` npm) is well-tested and includes the
   encryption. Using it.

3. **What's the right default for `maxPerHour`?** 30 is a guess.
   Should default be lower for `audit.material`-only subs? Defer
   tuning to Phase 3 with telemetry from operators.

4. **Notification routing decision — same change or separate?**
   This change ships the _delivery channel_. `add-notification-routing`
   ships the _decision logic_ ("send to phone only, not laptop"). They
   are intentionally separate so this one can ship first.

5. **Web Push for the terminal client too?** The terminal client
   could subscribe to "desktop notifications" via libnotify on Linux
   / NSUserNotification on macOS. Not WebPush proper; same end-user
   feel. Defer to a future change unless someone asks.
