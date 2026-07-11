# webpush-notifications — spec delta

## ADDED Requirements

### Requirement: VAPID keypair self-managed by daemon

The daemon SHALL generate a P-256 VAPID keypair on first startup if
one does not exist, storing the public key at
`~/.qwen/rc/vapid.pub.pem` and the private key at
`~/.qwen/rc/vapid.priv.pem` with file mode 0600. The daemon SHALL
refuse to start if the private key file exists but is group- or
world-readable.

#### Scenario: First start generates keypair

- **GIVEN** a fresh daemon installation with no VAPID files
- **WHEN** the daemon starts
- **THEN** both PEM files exist at the documented paths
- **AND** the private key file has mode `0600`
- **AND** the public key is logged at info level

#### Scenario: Insecure private key refused

- **GIVEN** `~/.qwen/rc/vapid.priv.pem` has mode `0644`
- **WHEN** the daemon starts
- **THEN** the daemon exits with code 2 and message
  `vapid_private_key_insecure_perms`

### Requirement: VAPID public key advertised via capabilities

The `GET /capabilities` response SHALL include a `remoteControl.webpush`
block:

```jsonc
{
  "remoteControl": {
    "webpush": {
      "applicationServerKey": "<base64url(P-256 public key)>",
      "subject": "mailto:<configured contact or noreply@local>",
      "maxPayloadBytes": 4096,
      "supportedKinds": ["permission.required", "task.completed", ...]
    }
  }
}
```

#### Scenario: Web client uses applicationServerKey for subscribe

- **WHEN** the web client calls
  `pushManager.subscribe({ applicationServerKey })`
- **THEN** the value passed equals the daemon's advertised
  `applicationServerKey`

### Requirement: Subscription endpoints

The daemon SHALL accept the following routes for token-scoped
subscription management:

- `POST /rc/push/subscribe` — body: PushSubscription JSON
  (`endpoint`, `keys.p256dh`, `keys.auth`) plus optional `prefs` and
  `quietHours`. Returns `{ id, prefs, quietHours, maxPerHour }`.
- `GET /rc/push/subscriptions` — returns subscriptions owned by the
  caller's token. With `?all=true` and owner scope, returns all.
- `PATCH /rc/push/subscriptions/:id` — partial update of `prefs`,
  `quietHours`, `maxPerHour`.
- `DELETE /rc/push/subscriptions/:id` — removes the subscription.
  Caller must own it OR have owner scope.

#### Scenario: Token-bound listing

- **GIVEN** token `A` has 2 subscriptions and token `B` has 1
- **WHEN** `A` calls `GET /rc/push/subscriptions`
- **THEN** the response contains exactly `A`'s 2 subscriptions

#### Scenario: Cross-token revoke requires owner

- **GIVEN** subscription `S` belongs to token `A`
- **WHEN** token `B` (non-owner) deletes `S`
- **THEN** the response is `403 Forbidden`

### Requirement: Subscription removed automatically on permanent failure

The send pipeline SHALL remove a subscription when the push service
returns HTTP `404` or `410` for any send. Transient errors (5xx and
network) MAY retry up to 5 times with exponential backoff before
giving up; a give-up SHALL log an audit event but SHALL NOT remove
the subscription.

#### Scenario: 410 Gone removes subscription

- **GIVEN** subscription `S` is registered
- **WHEN** a push to `S` returns `410 Gone`
- **THEN** `S` is deleted from the store
- **AND** an audit entry of type `push_subscription_removed` is
  written with reason `gone`

#### Scenario: Transient 503 retries then gives up

- **GIVEN** the push service returns `503 Service Unavailable` for
  every attempt
- **WHEN** the daemon retries
- **THEN** exactly 5 attempts are made with backoff 1s, 2s, 4s, 8s,
  16s
- **AND** the 6th never fires
- **AND** the subscription remains
- **AND** an audit entry `push_send_gave_up` is logged

### Requirement: Payload schema and size bound

A push payload (pre-encryption) SHALL conform to schema v1:

```jsonc
{
  "v": 1,
  "kind": "<one of supportedKinds>",
  "sessionId": "<opaque id>",
  "sessionName": "<≤64 chars>",
  "summary": "<≤140 chars>",
  "deepLink": "<absolute https URL>",
  "permission": { "requestId": "...", "toolName": "...", "expiresAt": "..." }, // when kind = permission.required
  "actions": [{ "id": "...", "title": "..." }], // optional, max 2
}
```

Payloads SHALL NOT include tool arguments, file contents, file paths
beyond a bare filename, or any prompt text. Payload (post-encryption)
size SHALL NOT exceed 4096 bytes; the daemon SHALL truncate `summary`
with `…` if needed and emit an audit event `push_payload_truncated`.

#### Scenario: Tool args excluded from summary

- **GIVEN** a `permission.required` event for a `bash` call with args
  containing 500 chars of shell pipeline
- **WHEN** the push payload is constructed
- **THEN** `summary` is a hand-written description, not the args
- **AND** the args are NOT present in any payload field

#### Scenario: Oversized summary truncated

- **GIVEN** a kind-specific summary builder produces a 200-char string
- **WHEN** the payload is built
- **THEN** `summary` length is ≤140 chars, terminated with `…`

### Requirement: Scope-gated event kinds

Each subscription MAY only receive event kinds permitted by its
token's scope per the table below. The send pipeline SHALL filter
events before encryption:

| Scope   | Allowed kinds                                     |
| ------- | ------------------------------------------------- |
| owner   | All                                               |
| write   | permission.required, task.completed, session.died |
| approve | permission.required                               |
| read    | task.completed, mention                           |

#### Scenario: Read scope does not receive permission pings

- **GIVEN** a subscription bound to a read-scope token
- **WHEN** a `permission.required` event fires
- **THEN** no push is sent to that subscription
- **AND** no audit entry is written about the suppressed send (avoid
  noise for routine filtering)

### Requirement: Per-subscription preferences and quiet hours

Subscriptions SHALL store `prefs.kinds` (subset of allowed kinds),
`quietHours: { from, to, timezone }` (optional), and `maxPerHour`
(default 30, min 1, max 240). Events outside `prefs.kinds` SHALL NOT
push. Events during `quietHours` SHALL be coalesced into a single
"digest" push delivered at the end of the quiet window unless the
event kind is `policy.deny` or `session.died`, which bypass quiet
hours.

#### Scenario: Quiet hours suppresses ordinary pushes

- **GIVEN** a subscription with quiet hours 23:00–07:00
  America/Los_Angeles
- **WHEN** a `task.completed` event fires at 01:00 local time
- **THEN** no immediate push is sent
- **AND** the event is queued
- **AND** at 07:00 a single digest push is sent listing all
  suppressed events

#### Scenario: Critical events bypass quiet hours

- **WHEN** a `session.died` event fires during quiet hours
- **THEN** the push is delivered immediately
- **AND** the digest at 07:00 omits this entry

#### Scenario: Rate limit drops oldest

- **GIVEN** `maxPerHour: 5`
- **WHEN** 6 pushable events occur within 60 minutes
- **THEN** the 6th is dropped
- **AND** an audit entry `push_rate_limited` is written
- **AND** the next push within the same window is also dropped until
  the rolling window has space

### Requirement: Same-kind coalescing within 5 seconds

Multiple events of the same `kind` from the same `sessionId` within
a 5-second window SHALL coalesce into a single push whose `summary`
indicates the count.

#### Scenario: Burst of 4 prompts produces one push

- **WHEN** 4 `permission.required` events fire from session `S`
  within 5 seconds
- **THEN** one push is sent with summary like
  `"4 approvals pending in <S.name>"`

### Requirement: Service worker handles inline actions

The shipped service worker SHALL handle `notificationclick` events
for `permission.required` payloads with `actions` set, posting the
chosen vote to the daemon's `/permission/:requestId` endpoint using
the stored bearer token.

#### Scenario: Approve action sends approve vote

- **GIVEN** a `permission.required` notification with action `approve`
- **WHEN** the user taps "Approve" from the notification shade
- **THEN** the service worker fetches
  `POST /permission/<requestId>` with body
  `{ outcome: { outcome: "selected", optionId: "approve" } }` and
  the stored token in the Authorization header
- **AND** if the daemon returns 200, the notification closes silently
- **AND** if the daemon returns 404 (already resolved), the
  notification is replaced with "Resolved by another device"

#### Scenario: Action fails offline → queued

- **GIVEN** the device is offline when the user taps "Approve"
- **WHEN** the fetch fails
- **THEN** the service worker queues the vote via the background-
  sync API (where supported) and retries on reconnection
- **AND** if background-sync is unavailable, the queued vote is
  attempted next time the PWA opens

### Requirement: VAPID rotation invalidates subscriptions

The CLI command `qwen rc push rotate-vapid` SHALL generate a new
keypair, atomically replace the PEM files, remove all push
subscriptions (since they are bound to the old key), and emit a
`vapid_rotated` SSE event to all attached clients.

#### Scenario: Rotation triggers client re-subscribe

- **GIVEN** the web client is attached
- **WHEN** the operator runs `qwen rc push rotate-vapid`
- **THEN** the web client receives a `vapid_rotated` event
- **AND** it removes its stored subscription
- **AND** it re-subscribes using the new `applicationServerKey` from
  the next `/capabilities` response
- **AND** the user does not need to interact with the page for
  re-subscription if notification permission is still granted
