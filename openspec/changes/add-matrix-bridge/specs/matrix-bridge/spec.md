# matrix-bridge — spec delta

## ADDED Requirements

### Requirement: Bridge process configuration

The Matrix bridge SHALL be a standalone process distinct from the
qwen daemon. It SHALL read its configuration exclusively from
environment variables:

- `MATRIX_HOMESERVER_URL` (required) — base URL of the homeserver,
  e.g. `https://home.example.com`.
- `MATRIX_USER_ID` (required) — fully-qualified MXID of the bot,
  e.g. `@qwenbot:home.example.com`.
- `MATRIX_ACCESS_TOKEN` (required) — obtained out-of-band via a
  one-time `/login` request.
- `QWEN_DAEMON_URL` (required).
- `QWEN_BRIDGE_TOKEN` OR `QWEN_BRIDGE_PAIRING_CODE` (one required).
- `MATRIX_COMMAND_PREFIX` (optional, default `!qwen`).
- `QWEN_BRIDGE_STATE_DIR` (optional, default
  `~/.qwen/rc/bridges/matrix`).

The bridge SHALL fail-fast at startup with a non-zero exit code if
any required variable is missing OR if `whoami` against the
homeserver returns an MXID that does not match `MATRIX_USER_ID`.

#### Scenario: MXID mismatch aborts startup

- **GIVEN** `MATRIX_USER_ID = @qwenbot:home.example.com` but the
  access token resolves to `@other:home.example.com`
- **WHEN** the bridge boots
- **THEN** it exits with code 1
- **AND** stderr contains "MXID mismatch"

### Requirement: Bridge registration declares Matrix capabilities

On startup the bridge SHALL register itself via `POST /rc/bridges`
with:

```jsonc
{
  "displayName": "Matrix-bridge",
  "bridgeKind": "matrix",
  "capabilities": {
    "supportsActions": false,
    "supportsMarkdown": "full",
    "maxMessageBytes": 65536,
    "supportsThreads": true,
    "supportsEdits": true,
  },
}
```

#### Scenario: Registration declares Matrix capabilities

- **WHEN** the bridge calls `POST /rc/bridges`
- **THEN** the request body matches the schema above

#### Scenario: supportsActions is false

- **WHEN** an operator runs `qwen rc bridges list`
- **THEN** the Matrix bridge entry shows `supportsActions: false`

### Requirement: Auto-accept invites

When the bot receives an `m.room.member` event with `membership:
"invite"` AND `state_key == MATRIX_USER_ID`, the bridge SHALL call
`POST /_matrix/client/v3/rooms/:roomId/join` to accept.

The bridge SHALL log the room id and the inviter's MXID at
`info` level. The bridge SHALL NOT bind the joined room to any
session until an explicit `!qwen attach` command is run inside.

#### Scenario: Bot auto-joins on invite

- **WHEN** a room invite arrives for the bot
- **THEN** the bridge calls `/join` within 5 seconds
- **AND** the room is NOT bound to any session

### Requirement: Persistent olm crypto store

The bridge SHALL persist megolm/olm room keys to a SQLite-backed
store at `$QWEN_BRIDGE_STATE_DIR/olm/` so that encrypted-room
messages remain decryptable across restarts without re-keying.

Loss or deletion of this directory while users have active sessions
in encrypted rooms is a re-keying event; the bridge SHALL log
`olm_store_missing` at warn level on first boot if no store is
present.

#### Scenario: Olm store survives restart

- **GIVEN** the bridge has joined an encrypted room and decrypted
  messages
- **WHEN** the bridge process restarts
- **THEN** the bridge decrypts subsequent encrypted-room messages
  without any user-side key-share prompts

### Requirement: Room-to-session binding via !qwen attach

A Matrix room SHALL NOT be bound to any qwen session by default.
Binding occurs when:

1. An operator generates an invite token via `qwen rc bridges invite
--kind matrix --session <id>`.
2. The bot is invited to the target room and auto-joins.
3. A room member with power level ≥ 50 posts `!qwen attach
<token>` (or `<MATRIX_COMMAND_PREFIX> attach <token>`).
4. The bridge redeems the token; on success persists `(roomId,
sessionId)` to `$QWEN_BRIDGE_STATE_DIR/rooms.json` using
   atomic-replace writes.

Commands from members with power level < 50 SHALL be rejected with
a reply "Permission denied: attach requires power level ≥ 50".

#### Scenario: Moderator-issued attach binds room

- **GIVEN** an invite token `inv_abc` AND a room where `@evan:
home.example.com` has power level 50
- **WHEN** `@evan:home.example.com` posts `!qwen attach inv_abc`
- **THEN** the bridge calls `POST /rc/bridges/:id/invite/redeem`
- **AND** on `200 OK` persists the binding
- **AND** posts a reply "Room bound to session `<id>`. React 👍/👎
  on tool-call messages to vote."

#### Scenario: Non-moderator attach rejected

- **GIVEN** a room where `@guest:home.example.com` has power level
  0
- **WHEN** `@guest:home.example.com` posts `!qwen attach inv_abc`
- **THEN** the bridge does NOT call the daemon
- **AND** posts a reply "Permission denied: attach requires power
  level ≥ 50"

#### Scenario: !qwen detach removes binding

- **GIVEN** the room is bound and the invoker has power level ≥ 50
- **WHEN** `!qwen detach` is posted
- **THEN** the binding is removed from rooms.json

### Requirement: Inbound message forwarding

For `m.room.message` events with `msgtype: "m.text"` in a bound
room whose `body` does NOT start with the command prefix, where the
sender is not the bot AND not in the local ban cache, the bridge
SHALL:

1. POST `/session/<sessionId>/prompt` with body `{ prompt: <body>
}` and `X-RC-SubActor: matrix:<sender>` (sender is the
   fully-qualified MXID from `event.sender`).
2. On daemon 429, send a room reply "Slow down, try again in
   `<Retry-After>` seconds".
3. On daemon 403 sub_actor_banned, silently drop and add to local
   ban cache.

#### Scenario: Message becomes prompt with MXID sub-actor

- **GIVEN** room `!abc:home.example.com` bound to `sess_xyz`
- **WHEN** `@evan:home.example.com` posts "run the tests"
- **THEN** the bridge POSTs `/session/sess_xyz/prompt` with `prompt:
"run the tests"`
- **AND** carries `X-RC-SubActor: matrix:@evan:home.example.com`

#### Scenario: Bot's own messages are not re-posted

- **WHEN** the bridge sends a message authored by itself
- **THEN** the bridge does NOT call the daemon

### Requirement: Sub-actor is fully-qualified MXID

The bridge SHALL set `X-RC-SubActor: matrix:<fully-qualified-mxid>`,
including the homeserver suffix (e.g.
`matrix:@evan:home.example.com`). The bridge SHALL NOT strip the
homeserver suffix or use a localpart-only identifier.

#### Scenario: Federated user identifier preserved

- **GIVEN** a federated user `@alice:other-server.org` participates
  in a bound room
- **WHEN** they post a message
- **THEN** the daemon request carries `X-RC-SubActor:
matrix:@alice:other-server.org` (NOT `matrix:@alice` or
  `matrix:alice`)

### Requirement: SSE consumer per binding

For each binding the bridge SHALL maintain an SSE subscription with
`Authorization: Bearer <bridge-token>` and `Last-Event-ID` from a
cursor persisted to `$QWEN_BRIDGE_STATE_DIR/cursors.json`. The
bridge SHALL reconnect with exponential backoff (initial 1 s, max
30 s, jitter ±20 %).

#### Scenario: Bridge restart resumes without duplicates

- **GIVEN** the bridge processed event id `0x100` for `sess_xyz`
- **WHEN** the bridge restarts
- **THEN** it sends `Last-Event-ID: 0x100`
- **AND** does NOT re-render events ≤ `0x100`

### Requirement: session_update rendering with full Markdown

`session_update` chunks SHALL be sent as `m.room.message` events
with `msgtype: "m.text"`, `body` (plaintext), `format:
"org.matrix.custom.html"`, and `formatted_body` (HTML rendered from
the chunk's Markdown via a CommonMark renderer).

Buffer + flush triggers: paragraph break, fenced code-block close,
1500 ms idle, OR buffer ≥ 16384 bytes. Individual events SHALL NOT
exceed 65536 bytes.

#### Scenario: Markdown rendered to HTML formatted body

- **WHEN** a chunk arrives containing `**bold** and \`code\``
- **THEN** the sent event has `body` containing the original
  characters
- **AND** `formatted_body` contains `<strong>bold</strong> and
<code>code</code>`

### Requirement: Threads on long streams via m.thread

When the bridge has flushed at least 6 messages within a single
agent turn into a bound room, subsequent flushes of the same turn
SHALL include an `m.relates_to` object with `rel_type: "m.thread"`
and `event_id` referencing the first message of the turn.

A turn boundary is the SSE event immediately following a
`permission_resolved`, OR the next inbound user prompt.

#### Scenario: Long stream uses thread relation

- **GIVEN** 6 message flushes have occurred for turn T with the
  first message id `m_first`
- **WHEN** the 7th flush is sent
- **THEN** the event's `content.m.relates_to.rel_type == "m.thread"`
- **AND** `content.m.relates_to.event_id == "m_first"`

### Requirement: permission_request rendering

The bridge SHALL render `permission_request` SSE frames as an
`m.room.message` event branched on `bridgeHints.recommendedSurface`:

- **`inline`**: body contains `bridgeHints.argsSummaryShort` AND
  the literal instruction "React 👍 to approve, 👎 to deny."
- **`deeplink`**: body contains `bridgeHints.argsSummaryShort` AND
  a URL `${QWEN_DAEMON_URL}/ui/permission/<requestId>`. The bridge
  SHALL NOT include the reaction prompt in deeplink mode AND SHALL
  NOT track reactions on the resulting message.

The bridge SHALL record `(requestId → eventId)` for the sent event
in an in-memory map for later editing.

#### Scenario: Inline surface invites reactions

- **GIVEN** a `permission_request` with `recommendedSurface:
"inline"`, `argsSummaryShort: "Edit auth.ts"`, `requestId:
"req_xyz"`
- **WHEN** the bridge renders it
- **THEN** the event body contains "Edit auth.ts"
- **AND** the event body contains "React 👍 to approve, 👎 to deny"
- **AND** the bridge records `req_xyz → <returned event id>`

#### Scenario: Deeplink surface omits reaction prompt

- **GIVEN** a `permission_request` with `recommendedSurface:
"deeplink"`
- **WHEN** the bridge renders it
- **THEN** the event body does NOT contain "React 👍"

### Requirement: Reaction-based voting

The bridge SHALL listen for `m.reaction` events where
`m.relates_to.event_id` matches a tracked permission-request event.
For each such reaction:

- `key: "👍"` → vote `approve`.
- `key: "👎"` → vote `deny`.
- Any other `key` → ignored.

The reactor's MXID is taken from the reaction event's `sender`. The
bridge SHALL drop reactions from senders in the local ban cache
WITHOUT posting to the daemon.

On valid reactions, the bridge SHALL POST `/permission/<requestId>`
with `{ vote: "approve" | "deny" }` and `X-RC-SubActor:
matrix:<sender>`.

#### Scenario: 👍 reaction casts approve vote

- **GIVEN** a tracked permission-request event with id `m_42` and
  `requestId: req_xyz`
- **WHEN** `@evan:home.example.com` posts an `m.reaction` event
  with `m.relates_to.event_id: "m_42"` AND `key: "👍"`
- **THEN** the bridge POSTs `/permission/req_xyz` with `vote:
"approve"`
- **AND** the request carries `X-RC-SubActor:
matrix:@evan:home.example.com`

#### Scenario: Other reactions ignored

- **WHEN** a user reacts with `❤️` to a tracked event
- **THEN** the bridge does NOT call the daemon

#### Scenario: Banned user's reaction dropped

- **GIVEN** `matrix:@spammer:other.org` is in the local ban cache
- **WHEN** that user reacts with 👍 to a tracked event
- **THEN** the bridge does NOT call the daemon

### Requirement: permission_resolved edits via m.replace

On receiving `permission_resolved` for a tracked requestId, the
bridge SHALL send an `m.room.message` event whose content includes
`m.new_content` and `m.relates_to.rel_type: "m.replace"` with
`event_id` of the original event. The new body SHALL preserve the
original message and append "Resolved: `<vote>` by `<subActor>`".

#### Scenario: Resolve edits original message

- **GIVEN** a permission-request event `m_42` for `req_xyz`
- **WHEN** the bridge receives `permission_resolved` for `req_xyz`
  with outcome `approve` and subActor `matrix:@evan:home.example.com`
- **THEN** the bridge sends an `m.replace` edit of `m_42`
- **AND** the edited body appends "Resolved: approve by
  matrix:@evan:home.example.com"

### Requirement: Local ban cache

The bridge SHALL maintain a local cache of banned sub-actors
populated from `sub_actor_banned` SSE events and persisted to
`$QWEN_BRIDGE_STATE_DIR/bans.json`. Inbound messages AND reactions
from banned MXIDs SHALL be dropped without daemon calls.

The bridge SHALL NOT redact reactions from banned users; it merely
ignores them.

#### Scenario: Banned user's prompt is silently dropped

- **GIVEN** `matrix:@spammer:other.org` is in the ban cache
- **WHEN** that user posts a message in a bound room
- **THEN** the bridge does NOT POST to the daemon
- **AND** the bridge does NOT redact the message

### Requirement: Log redaction

The bridge SHALL never write `MATRIX_ACCESS_TOKEN` or any
`qwk_<...>`-prefixed string in plaintext to any log output.

#### Scenario: Access token not logged

- **GIVEN** debug logging is enabled
- **WHEN** the bridge logs its configuration
- **THEN** stdout contains neither the access token nor any
  `qwk_*` string in cleartext

### Requirement: Healthz endpoint

The bridge SHALL expose `GET /healthz` on its local HTTP server
(default port 9100) returning `{ ok: true, daemonReachable: bool,
homeserverReachable: bool, olmStorePresent: bool, registeredId:
string|null, uptimeSec: number }`.

#### Scenario: Healthz reflects olm store status

- **GIVEN** `$QWEN_BRIDGE_STATE_DIR/olm/` is missing on disk
- **WHEN** `GET /healthz` is called
- **THEN** the response body has `olmStorePresent: false`
