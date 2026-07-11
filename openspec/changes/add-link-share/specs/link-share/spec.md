# link-share — spec delta

## ADDED Requirements

### Requirement: New scope `share`

The daemon SHALL recognize `share` as a new pairing scope distinct
from `owner`, `write`, `approve`, `read`. `share` SHALL imply `read`
on the session identified by the token's `session_lock_id` ONLY.
Optionally, a share may also carry `approve` (stored as
`scopes: ["share","approve"]`), which extends to permission voting
on the same locked session.

`share` SHALL NOT imply any of: `write`, `owner`, the ability to
mint or list pairing codes, the ability to list or revoke any
token, the ability to read the audit log, the ability to attach to
sessions other than `session_lock_id`.

#### Scenario: Share scope reads its locked session

- **GIVEN** a `share`-scope token with `session_lock_id = S`
- **WHEN** it subscribes to `GET /session/S/events`
- **THEN** the response is `200 OK` and the event stream begins

#### Scenario: Share scope cannot send prompts

- **GIVEN** a `share`-scope token
- **WHEN** it posts to `/session/S/prompt`
- **THEN** the response is `403 Forbidden` with code
  `scope_required: write`

#### Scenario: Share scope cannot list shares

- **GIVEN** a `share`-scope token
- **WHEN** it requests `GET /rc/share`
- **THEN** the response is `403 Forbidden` with code
  `scope_required: owner`

#### Scenario: Share with approve elevation can vote

- **GIVEN** a share token minted with `scope: "approve"` (stored
  scopes `["share","approve"]`) and `session_lock_id = S`
- **WHEN** it posts to `/permission/:requestId` where the
  request belongs to session `S`
- **THEN** the vote is accepted

### Requirement: Share tokens are session-locked

When a token's `session_lock_id` column is non-null, every request
that resolves to a session ID SHALL be permitted only if the
resolved session ID equals `session_lock_id`. Mismatch SHALL return
`403 Forbidden` with code `share_session_mismatch`.

#### Scenario: Locked share cannot attach to a different session

- **GIVEN** a share token locked to session `S1`
- **WHEN** it subscribes to `GET /session/S2/events` where `S2 ≠ S1`
- **THEN** the response is `403 Forbidden` with code
  `share_session_mismatch`

#### Scenario: Permission vote resolves to its session for the check

- **GIVEN** a share token locked to session `S1`
- **AND** permission request `R` belongs to session `S2`
- **WHEN** the token posts `/permission/R`
- **THEN** the response is `403 Forbidden` with code
  `share_session_mismatch`

### Requirement: Share lifecycle

An owner-scope client SHALL be able to mint a session-locked share
via `POST /rc/share { sessionId, scope, ttlSec, maxUses, label }`.
Defaults SHALL be: `ttlSec = 3600`, `scope = "view"`,
`maxUses = 5`. `ttlSec` SHALL be clamped to `[300, 2592000]` (5
minutes to 30 days); `maxUses` to `[1, 100]`. The daemon SHALL
respond:

```jsonc
{
  "id": "sh_xxxx",
  "url": "https://<daemon-host>/ui/share/<plain-token>",
  "expiresAt": "<ISO>",
  "scope": "view" | "approve",
  "maxUses": 5,
  "usesRemaining": 5,
  "label": "<label or null>"
}
```

The plaintext token SHALL appear in the `url` field exactly once;
subsequent reads MUST NOT expose it.

#### Scenario: Owner creates a 1h view share

- **GIVEN** session `S` exists in the daemon's workspace
- **WHEN** an owner posts `{ sessionId: "S", scope: "view", ttlSec:
3600, maxUses: 5, label: "oncall-bob" }`
- **THEN** the response includes
  `url: "https://D/ui/share/qwk_…"`
- **AND** the response includes `expiresAt` 1 hour ahead
- **AND** the audit log records `share.create` with `share_label:
"oncall-bob"` and `parent_token_id`

#### Scenario: TTL above max is clamped with a warning

- **WHEN** an owner posts `{ ttlSec: 9999999, ... }`
- **THEN** `ttlSec` is clamped to `2592000`
- **AND** the response body's `warnings` array includes
  `ttl_clamped`

#### Scenario: Non-owner cannot mint a share

- **GIVEN** the requester holds a `write`-scope token
- **WHEN** the requester posts `/rc/share`
- **THEN** the response is `403 Forbidden`

### Requirement: URL bootstrap removes token from address bar

The daemon SHALL serve a static bootstrap HTML page at
`GET /ui/share/<token>` for any value of `<token>` matching the
shape `qwk_[A-Za-z0-9_-]{32,}`. The page MUST NOT validate the
token server-side and MUST NOT vary its body by token value (the
body is byte-for-byte identical for every request). The page SHALL
include inline JavaScript that synchronously:

1. Extracts the token from `location.pathname`.
2. Stores it in `sessionStorage` under
   `qwen-rc:<location.host>:share-token`.
3. Calls `history.replaceState({}, '', '/ui/')`.
4. Loads the main web client bundle.

Subsequent authenticated requests MUST send the token via the
`Authorization: Bearer` header, NEVER in the URL.

#### Scenario: Address bar after first load

- **GIVEN** a guest opens `https://D/ui/share/qwk_abc…`
- **WHEN** the bootstrap page finishes loading
- **THEN** `location.pathname` is `/ui/`
- **AND** `localStorage["qwen-rc:D:share-token"]` is `undefined`
- **AND** `sessionStorage["qwen-rc:D:share-token"]` equals the
  original token

#### Scenario: Bootstrap is invariant per request

- **WHEN** two different share URLs are fetched
- **THEN** the response bodies are byte-identical

#### Scenario: Malformed share path returns the same HTML

- **WHEN** `GET /ui/share/notatoken` is requested
- **THEN** the response is the same static HTML
- **AND** the inline JS detects the malformed shape and renders a
  "Invalid share link" message without storing anything

### Requirement: `whoami` endpoint bumps the use counter atomically

`GET /rc/share/whoami` SHALL accept a share token via
`Authorization: Bearer` and SHALL return
`{ shareId, sessionId, scope, sharedByTokenName, label,
expiresAt, usesRemaining }`.

The daemon SHALL set a `Secure HttpOnly SameSite=Strict` cookie
named `qwen-rc-share-session` whose value is opaque (random
per-browser-session, recorded in `share_browser_sessions` keyed by
`(token_id, cookie_hash)`). If the request arrives without this
cookie OR with a cookie unknown for this token, the daemon SHALL
atomically:

1. Execute `UPDATE tokens SET uses = uses + 1 WHERE id = :id AND
uses < max_uses AND revoked_at IS NULL AND expires_at > :now`.
2. If rowcount is 0 → respond `410 Gone` with code
   `share_exhausted` or `share_expired` or `share_revoked`
   depending on which guard failed.
3. Else: insert the new cookie hash into
   `share_browser_sessions`; return `200`.

If the cookie is present and known for this token, the daemon
SHALL NOT bump `uses`; it SHALL still respond `200` (refresh in
the same browser session is free).

#### Scenario: First-use bumps counter

- **GIVEN** a share token with `uses=0, max_uses=5`
- **WHEN** a guest's first `whoami` call arrives without the
  cookie
- **THEN** `uses` becomes `1`
- **AND** the response sets `qwen-rc-share-session`
- **AND** the audit log records `share.use` with
  `usesAfter: 1`

#### Scenario: Refresh in same tab does not bump

- **GIVEN** the cookie from a prior `whoami` is present
- **WHEN** the guest refetches `whoami`
- **THEN** `uses` is unchanged
- **AND** no `share.use` audit entry is written

#### Scenario: Exhaustion is atomic under concurrent requests

- **GIVEN** a share with `uses=4, max_uses=5`
- **WHEN** two distinct browser sessions race to call `whoami`
- **THEN** exactly one succeeds with `uses=5`
- **AND** the other receives `410 Gone` with code
  `share_exhausted`

### Requirement: List and inspect shares

`GET /rc/share` (owner scope) SHALL return all active shares with
their metadata. `GET /rc/share?sessionId=<sid>` SHALL filter to
the named session. `GET /rc/share/:id` SHALL return one share's
metadata. Plaintext tokens MUST NOT appear in any response.

```jsonc
{
  "shares": [
    {
      "id": "sh_xxxx",
      "sessionId": "<sid>",
      "scope": "view" | "approve",
      "label": "<label or null>",
      "createdAt": "<ISO>",
      "expiresAt": "<ISO>",
      "maxUses": 5,
      "uses": 2,
      "lastUsedAt": "<ISO or null>",
      "lastUsedIp": "<ip or null>",
      "sharedByTokenId": "tkn_xxx",
      "revoked": false
    }
  ]
}
```

#### Scenario: Listing never exposes plaintext

- **WHEN** an owner requests `GET /rc/share`
- **THEN** no field in any share record matches the regex
  `qwk_[A-Za-z0-9_-]{32,}`

### Requirement: Revoke is immediate

`DELETE /rc/share/:id` (owner scope) SHALL mark the share revoked.
Within 1 s, all live SSE subscribers using the share's token MUST
receive a terminal `client_evicted` frame with reason
`share_revoked`. Subsequent requests with the revoked token MUST
return `401 Unauthorized`.

#### Scenario: Revoked subscriber is kicked

- **GIVEN** a guest subscribed to `/session/S/events` via share
  `sh_x`
- **WHEN** an owner deletes `sh_x`
- **THEN** the guest's SSE emits one
  `{ type: "client_evicted", data: { reason: "share_revoked" } }`
  frame and closes
- **AND** the next `/rc/share/whoami` from the same browser
  returns `401`

### Requirement: Watermark banner is mandatory in the web client

When the web client's active token has `share` in its scopes, the
chat-surface header SHALL render a non-dismissable banner showing,
at minimum:

- the share `label` (or "(unlabeled)")
- the effective scope (`view` or `approve`)
- `uses / maxUses`
- a countdown to `expiresAt`
- the sharing operator's token display name

The banner element MUST NOT be removable by user CSS or any guest-
controllable code path. The web client MUST hide UI controls the
share scope cannot reach (prompt input, end-session button,
non-locked session list, audit pane).

#### Scenario: Watermark renders for share-scope token

- **GIVEN** the web client is loaded with a share token in
  `sessionStorage`
- **WHEN** the chat surface renders
- **THEN** the watermark banner is present
- **AND** the prompt input is not rendered if scope is `view`
- **AND** the approve/deny buttons render only if `approve` is
  in scopes

#### Scenario: Owner sees an active-shares strip

- **GIVEN** owner is attached to session `S` which has 2 active
  shares
- **WHEN** the chat surface loads
- **THEN** an "Active shares" strip lists both, each with revoke
  buttons
- **AND** when a new share is created on `S`, the strip updates
  via a `share_created` SSE event

### Requirement: Audit captures share provenance

Every action authenticated by a share token SHALL be recorded in
the audit log with `share_id` and `share_label` populated. Share
lifecycle actions (`share.create`, `share.use`, `share.revoke`,
`share.exhausted`, `share.expired`) SHALL produce their own audit
entries and corresponding `audit_event` SSE frames visible to
owner-scope subscribers daemon-wide and to read-scope subscribers
on the affected session.

#### Scenario: Guest approval is auditable by share id

- **GIVEN** a share `sh_x` with `approve` scope, used by a guest
- **WHEN** the guest approves `permission_request` `R`
- **THEN** the audit entry includes `tokenId` (the share token),
  `share_id: "sh_x"`, `share_label`, and `parent_token_id` (the
  owner who minted)
- **AND** the `audit_event` SSE frame likewise surfaces all four

### Requirement: Operator CLI `qwen rc share`

The CLI SHALL expose the subcommands:

- `qwen rc share create <sessionId> [--scope view|approve]
[--ttl <duration>] [--max-uses N] [--label <name>]
[--copy-to-clipboard]` — mint a share. Prints the URL once.
- `qwen rc share list [--session <sid>]` — table of active shares
  with id, sessionId, scope, label, uses, time remaining,
  lastUsedAt.
- `qwen rc share show <id>` — single-share metadata.
- `qwen rc share revoke <id>` — owner; mirrors token-revoke
  semantics.
- `qwen rc share watch` — `list --follow`; redraws every 5 s.

When `--ttl` exceeds 24h, the CLI SHALL print a warning to stderr
("share TTL > 24h; consider a shorter window for guest links")
before printing the URL.

#### Scenario: Default mint prints exactly one URL

- **WHEN** the operator runs `qwen rc share create S`
- **THEN** stdout contains exactly one line matching
  `https://[^/]+/ui/share/qwk_[A-Za-z0-9_-]{32,}`
- **AND** the URL is not written to any shell-history file
  controlled by the CLI

#### Scenario: List shows uses and remaining time

- **GIVEN** an active share with `uses=2, maxUses=5,
expiresAt = now+30m`
- **WHEN** the operator runs `qwen rc share list`
- **THEN** that row shows `2/5` and a remaining-time column
  `~30m`
