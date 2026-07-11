# bridge-protocol — spec delta

## ADDED Requirements

### Requirement: New scope `bridge`

The daemon SHALL recognize `bridge` as a new pairing scope distinct
from `owner`, `write`, `approve`, `read`. `bridge` SHALL imply
`write + approve + read` for the daemon's existing routes AND
additionally permit setting the `X-RC-SubActor` header on requests.
`bridge` SHALL NOT imply `owner` and SHALL NOT permit any of:
mint pairing codes, revoke tokens, read audit, register webpush
subscriptions for arbitrary tokens.

#### Scenario: Bridge scope mints prompts

- **GIVEN** a `bridge`-scope token
- **WHEN** it posts to `/session/:id/prompt` with a valid
  `X-RC-SubActor`
- **THEN** the prompt is accepted with HTTP 200

#### Scenario: Bridge scope cannot read audit

- **GIVEN** a `bridge`-scope token
- **WHEN** it requests `GET /rc/audit`
- **THEN** the response is `403 Forbidden` with code
  `scope_required: owner`

#### Scenario: Bridge scope can only be requested explicitly

- **GIVEN** an owner-scope caller posts `/rc/pair { scope: "owner" }`
- **WHEN** the call succeeds
- **THEN** the produced code has scope `owner` (does NOT silently
  promote to bridge)

- **GIVEN** an owner-scope caller posts `/rc/pair { scope: "bridge"
}`
- **WHEN** the call succeeds
- **THEN** the produced code carries scope `bridge` exactly

### Requirement: `X-RC-SubActor` header

Bridge tokens SHALL be permitted to set the header
`X-RC-SubActor: <kind>:<stable-id>` on requests acting on behalf of
an external user. Non-bridge tokens that set this header SHALL be
rejected with `400 Bad Request` and code `sub_actor_forbidden_scope`.

The header value SHALL match the regex
`^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._:@/+=-]{1,256}$`. Values not
matching SHALL be rejected with `400` and code
`sub_actor_malformed`.

#### Scenario: Bridge sets sub-actor on prompt

- **WHEN** a bridge POSTs to `/session/:id/prompt` with header
  `X-RC-SubActor: telegram:12345`
- **THEN** the request succeeds
- **AND** the audit entry records `sub_actor: "telegram:12345"`

#### Scenario: Write-scope token cannot set sub-actor

- **WHEN** a write-scope token POSTs to `/session/:id/prompt` with
  header `X-RC-SubActor: telegram:12345`
- **THEN** the response is `400 Bad Request`

#### Scenario: Malformed sub-actor rejected

- **WHEN** a bridge POSTs with `X-RC-SubActor: 12345` (no kind
  prefix)
- **THEN** the response is `400 Bad Request` with code
  `sub_actor_malformed`

### Requirement: Bridge registration

The daemon SHALL accept `POST /rc/bridges` from `bridge`-scope tokens
with body:

```jsonc
{
  "displayName": "Telegram-bridge",
  "bridgeKind": "telegram",
  "capabilities": {
    "supportsActions": true,
    "supportsMarkdown": "full" | "limited" | "none",
    "maxMessageBytes": 4096,
    "supportsThreads": true,
    "supportsEdits": false
  }
}
```

The response SHALL be `{ id, registeredAt, heartbeatIntervalSec }`.
Subsequent calls from the same token SHALL update the existing
record (idempotent) rather than create a new one.

#### Scenario: Repeated registration is idempotent

- **GIVEN** bridge `B` is registered with id `br_001`
- **WHEN** the same bridge token posts `/rc/bridges` again with
  updated capabilities
- **THEN** the response carries the same id `br_001`
- **AND** the capabilities are updated
- **AND** no second row is created

#### Scenario: Non-bridge token cannot register

- **WHEN** a write-scope token posts `/rc/bridges`
- **THEN** the response is `403 Forbidden`

### Requirement: Bridge heartbeat and auto-deregister

Registered bridges SHALL heartbeat via `POST /rc/bridges/:id/heartbeat`
at least every `heartbeatIntervalSec` (default 60 s). After three
consecutive missed heartbeats, the daemon SHALL auto-deregister the
bridge AND emit an audit event `bridge_stale_deregistered`.
Auto-deregistration SHALL NOT revoke the bridge's token; the bridge
MAY re-register without re-pairing.

#### Scenario: Three missed heartbeats deregisters

- **GIVEN** bridge `B` is registered
- **WHEN** no heartbeat arrives for 180 s
- **THEN** `GET /rc/bridges` no longer lists `B`
- **AND** an audit entry `bridge_stale_deregistered` is written

#### Scenario: Re-registration works after auto-deregister

- **GIVEN** `B` was auto-deregistered
- **WHEN** its token posts `/rc/bridges` with the same payload
- **THEN** the response succeeds with a fresh id
- **AND** `GET /rc/bridges` lists the new registration

### Requirement: Per-sub-actor rate limiting

The daemon SHALL apply a token-bucket rate limit per
`(bridgeId, subActor)` for write-equivalent routes (`prompt`,
`cancel`, `permission`). Defaults: `capacity: 5, refillSec: 10`.
Exceeded requests SHALL return `429 Too Many Requests` with
`Retry-After` indicating seconds until next token. Each `429` SHALL
be audited.

The daemon SHALL also apply a per-bridge daemon-wide bucket
(default `capacity: 30, refillSec: 1`); per-bridge limits MUST be
checked BEFORE per-sub-actor limits so an abusive bridge cannot
mask itself with many fresh sub-actor identities.

#### Scenario: Sub-actor rate limit triggers

- **GIVEN** sub-actor `telegram:42` has used 5 tokens in the last 10s
- **WHEN** they send a 6th prompt
- **THEN** the response is `429 Too Many Requests` with
  `Retry-After: 10`
- **AND** an audit entry `sub_actor_rate_limited` is written

#### Scenario: Per-bridge limit overrides per-sub-actor

- **GIVEN** a bridge has used 30 tokens in 1s across many sub-actors
- **WHEN** any new sub-actor sends a request
- **THEN** the response is `429`
- **AND** the audit reason is `bridge_rate_limited` (not
  `sub_actor_rate_limited`)

### Requirement: Sub-actor ban list

`POST /rc/bridges/:id/ban { subActor, reason }` (owner scope) SHALL
record a permanent ban for that sub-actor on that bridge. Any
request from the bridge with `X-RC-SubActor: <banned>` SHALL be
rejected with `403 Forbidden` and code `sub_actor_banned`.

The daemon SHALL emit a `sub_actor_banned` SSE event to the affected
bridge's subscription so it can filter pre-emptively.

`DELETE /rc/bridges/:id/ban/:subActorUrlEncoded` lifts the ban.

#### Scenario: Banned sub-actor cannot prompt

- **GIVEN** `telegram:troll` is banned on bridge `br_001`
- **WHEN** the bridge posts a prompt with `X-RC-SubActor:
telegram:troll`
- **THEN** the response is `403 Forbidden` with code
  `sub_actor_banned`

#### Scenario: Lift ban restores access

- **GIVEN** `telegram:troll` is banned
- **WHEN** an owner-scope token DELETEs the ban
- **THEN** subsequent requests from `telegram:troll` are allowed

### Requirement: Bridge presence events

`client_joined` events for `bridge`-scope tokens SHALL include
`kind: "bridge"`, `displayName`, and `bridgeKind`. `client_left`
events SHALL distinguish bridge departures.

#### Scenario: Bridge connect shows as bridge in presence

- **WHEN** a bridge subscribes to `/session/:id/events`
- **THEN** all other subscribers receive a `client_joined` event
  whose `data` includes `kind: "bridge", displayName: "Telegram-bridge",
bridgeKind: "telegram"`

### Requirement: `bridgeHints` on permission requests

Every `permission_request` SSE frame SHALL include a `bridgeHints`
object:

```jsonc
{
  "argsSummaryShort": "<≤140 char human summary>",
  "argsSummaryFull":  "<canonical full args>",
  "sensitivity":      "low" | "medium" | "high",
  "recommendedSurface": "inline" | "deeplink"
}
```

The daemon's classification SHALL be deterministic given the tool
name and args; bridges that need a different classification can
override locally.

#### Scenario: Hints present on every permission request

- **WHEN** any `permission_request` is emitted
- **THEN** the data includes `bridgeHints` with all four fields

#### Scenario: High sensitivity recommends deeplink

- **GIVEN** a tool call matching the sensitivity classifier's "high"
  category
- **WHEN** the event is emitted
- **THEN** `bridgeHints.sensitivity == "high"` AND
  `bridgeHints.recommendedSurface == "deeplink"`

### Requirement: Audit log carries sub_actor

The audit log JSON schema SHALL gain a `sub_actor` field, populated
for any request that included a valid `X-RC-SubActor`. The
`audit_event` SSE frame SHALL surface it.

#### Scenario: Permission vote via bridge audited with sub-actor

- **WHEN** a bridge posts a vote with `X-RC-SubActor: discord:99`
- **THEN** the audit entry includes `token_id` (the bridge) AND
  `sub_actor: "discord:99"`
- **AND** the audit_event SSE frame likewise includes both

### Requirement: Operator CLI for bridge management

The CLI SHALL expose:

- `qwen rc bridges list` — print registered bridges with capabilities
  and last heartbeat.
- `qwen rc bridges deregister <id>` — owner-only; remove a bridge
  registration. Does NOT revoke its token; use `qwen rc tokens
revoke` for that.
- `qwen rc bridges ban <subActor> --on <bridgeId>` — record a sub-
  actor ban.
- `qwen rc bridges unban <subActor> --on <bridgeId>` — lift a ban.
- `qwen rc bridges audit --sub-actor <s>` — filter audit log by
  sub-actor.

#### Scenario: list shows live status

- **WHEN** the operator runs `qwen rc bridges list`
- **THEN** output includes id, displayName, bridgeKind, scope
  (bridge), and an `online/stale` indicator based on heartbeat
  recency
