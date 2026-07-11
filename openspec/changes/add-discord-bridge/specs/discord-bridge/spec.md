# discord-bridge — spec delta

## ADDED Requirements

### Requirement: Bridge process configuration

The Discord bridge SHALL be a standalone process distinct from the
qwen daemon. It SHALL read its configuration exclusively from
environment variables:

- `DISCORD_BOT_TOKEN` (required) — bot token from the Discord
  Developer Portal.
- `DISCORD_APPLICATION_ID` (required) — application id for
  registering slash commands.
- `QWEN_DAEMON_URL` (required).
- `QWEN_BRIDGE_TOKEN` OR `QWEN_BRIDGE_PAIRING_CODE` (one required).
- `DISCORD_GUILD_ID` (optional) — when set, slash commands SHALL be
  registered guild-scoped instead of globally.
- `QWEN_BRIDGE_STATE_DIR` (optional, default
  `~/.qwen/rc/bridges/discord`).

The bridge SHALL fail-fast at startup with a non-zero exit code if
any required variable is missing.

#### Scenario: Missing bot token aborts startup

- **GIVEN** the bridge is started with `DISCORD_BOT_TOKEN` unset
- **WHEN** the process initializes
- **THEN** it exits with code 1
- **AND** stderr contains "DISCORD_BOT_TOKEN is required"

### Requirement: Gateway transport, not HTTP interactions

The bridge SHALL connect to Discord via the gateway WebSocket
(`wss://gateway.discord.gg`). It SHALL NOT host an HTTP interactions
endpoint.

#### Scenario: Bridge runs behind NAT without public URL

- **GIVEN** the bridge process has no inbound network reachability
- **WHEN** it boots
- **THEN** it successfully establishes a gateway connection
- **AND** receives `INTERACTION_CREATE` events for slash commands
  and button clicks

### Requirement: Bridge registration declares Discord capabilities

On startup the bridge SHALL register itself via `POST /rc/bridges`
with:

```jsonc
{
  "displayName": "Discord-bridge",
  "bridgeKind": "discord",
  "capabilities": {
    "supportsActions": true,
    "supportsMarkdown": "limited",
    "maxMessageBytes": 2000,
    "supportsThreads": true,
    "supportsEdits": true,
  },
}
```

#### Scenario: Registration declares Discord capabilities

- **WHEN** the bridge calls `POST /rc/bridges`
- **THEN** the request body matches the schema above

### Requirement: Slash commands for channel binding

The bridge SHALL register three slash commands at boot:

- `/qwen attach <invite:string>` — bind the invoking channel to a
  session via an invite token.
- `/qwen detach` — unbind the invoking channel.
- `/qwen status` — report binding and daemon health.

All three SHALL reply ephemerally (`flags: 64`). If
`DISCORD_GUILD_ID` is set, commands SHALL be registered as
guild-scoped commands for that guild; otherwise as global
commands.

#### Scenario: Slash commands appear in client

- **GIVEN** the bridge is connected and `DISCORD_GUILD_ID` is set
- **WHEN** an operator opens the slash-command picker in a channel
  in that guild
- **THEN** within 30 seconds of bridge boot the picker shows
  `/qwen attach`, `/qwen detach`, `/qwen status`

#### Scenario: Replies are ephemeral

- **WHEN** any of the three slash commands is invoked
- **THEN** the reply is visible only to the invoker (flags 64)

### Requirement: Channel-to-session binding via /qwen attach

A Discord channel SHALL NOT be bound to any qwen session by default.
Binding occurs when:

1. An operator runs `qwen rc bridges invite --kind discord
--session <id>` on the workstation, producing a one-time invite
   token.
2. A guild member runs `/qwen attach <token>` in the desired
   channel.
3. The bridge redeems the token against the daemon; on success it
   persists `(channelId, guildId, sessionId)` to
   `$QWEN_BRIDGE_STATE_DIR/channels.json` using atomic-replace.

#### Scenario: Operator-issued invite binds channel

- **GIVEN** an invite token `inv_abc` from the daemon
- **WHEN** a guild member runs `/qwen attach inv_abc` in channel
  `chan_42`
- **THEN** the bridge calls `POST /rc/bridges/:id/invite/redeem`
- **AND** on `200 OK` persists the binding
- **AND** replies ephemerally "Channel bound to session `<id>`"

#### Scenario: Unrecognized token rejected

- **WHEN** `/qwen attach gibberish` is invoked
- **THEN** the bridge replies ephemerally with the daemon's error
  text
- **AND** no binding is persisted

#### Scenario: /qwen detach removes binding

- **GIVEN** the channel is bound
- **WHEN** `/qwen detach` is invoked
- **THEN** the binding is removed from channels.json
- **AND** the reply confirms unbinding

### Requirement: Inbound chat message forwarding

For non-bot text messages received in a bound channel, the bridge
SHALL:

1. Resolve sub-actor as `discord:<author.id>` (snowflake).
2. Drop the message if the sub-actor is in the local ban cache.
3. POST `/session/<sessionId>/prompt` with body `{ prompt: <content>
}` and headers `Authorization: Bearer <bridge-token>` and
   `X-RC-SubActor: discord:<author.id>`.
4. On daemon `429`, send an ephemeral follow-up to the author
   ("Slow down, try again in `<Retry-After>` seconds").
5. On daemon `403 sub_actor_banned`, add to local cache and drop.

#### Scenario: Chat message becomes daemon prompt

- **GIVEN** channel `chan_42` bound to `sess_abc`
- **WHEN** user `111122223333` posts "run the tests"
- **THEN** the bridge POSTs `/session/sess_abc/prompt` with body
  containing `prompt: "run the tests"`
- **AND** carries `X-RC-SubActor: discord:111122223333`

#### Scenario: Bot's own messages do not loop

- **WHEN** the bridge sends a message authored by the bot itself
- **THEN** the bridge does NOT re-post it to the daemon

### Requirement: Sub-actor is Discord snowflake

The bridge SHALL set `X-RC-SubActor: discord:<user-snowflake>`
using `interaction.member.user.id` for interactions or
`message.author.id` for messages. The bridge SHALL NOT use
username, global name, or any mutable identifier.

#### Scenario: Snowflake used even when username present

- **GIVEN** a Discord user with `id: 111122223333444455, username:
"evan"`
- **WHEN** they post any message
- **THEN** the daemon request carries `X-RC-SubActor:
discord:111122223333444455`

### Requirement: SSE consumer per binding

For each binding the bridge SHALL maintain an SSE subscription with
`Authorization: Bearer <bridge-token>` and `Last-Event-ID` from a
per-session cursor persisted to
`$QWEN_BRIDGE_STATE_DIR/cursors.json`. The bridge SHALL reconnect
with exponential backoff (initial 1 s, max 30 s, jitter ±20 %) on
disconnect.

#### Scenario: Bridge restart resumes without duplicates

- **GIVEN** the bridge processed event id `0x100` for `sess_abc`
- **WHEN** the bridge restarts
- **THEN** it sends `Last-Event-ID: 0x100`
- **AND** does NOT re-render events ≤ `0x100`

### Requirement: session_update rendering with 2000-char cap

The bridge SHALL buffer `session_update` chunks and flush when:

- A paragraph break or fenced code-block close is reached, OR
- 1500 ms have elapsed since the last flush, OR
- The buffer reaches 1800 characters.

Each Discord message SHALL be ≤ 2000 characters. Messages exceeding
that limit SHALL be split at the nearest safe boundary in the order:
fenced code-block close > paragraph break > word break > hard cut.

#### Scenario: Long content splits at safe boundary

- **WHEN** a 3500-char chunk arrives containing a fenced code block
- **THEN** the message containing the fence MUST end with a closed
  fence
- **AND** subsequent messages MUST open a new fence if continuing
  code

### Requirement: Threads on long streams

When the bridge has flushed at least 6 messages within a single
agent turn into a bound channel, it SHALL create a public thread
on the first message of that turn (via Discord REST
`channels/<id>/messages/<msgId>/threads`) and redirect subsequent
flushes of the same turn to the thread.

A turn boundary is defined as: the SSE event immediately following
a `permission_resolved`, OR the next inbound user prompt.

#### Scenario: Long stream spawns thread

- **GIVEN** 6 message flushes have occurred for turn T in channel
  `chan_42`
- **WHEN** the 7th flush for turn T is ready
- **THEN** the bridge creates a thread on the first message of T
- **AND** the 7th flush is posted in the new thread

#### Scenario: New turn does not reuse thread

- **GIVEN** turn T1 produced a thread
- **WHEN** turn T2 begins (after `permission_resolved` or a new
  user prompt)
- **THEN** T2's flushes go to the channel, not T1's thread

### Requirement: permission_request rendering with components

The bridge SHALL render `permission_request` SSE frames as a Discord
message with components branched on `bridgeHints.recommendedSurface`:

- **`inline`**: `content` = `bridgeHints.argsSummaryShort`;
  `components` = one ActionRow with two Buttons:
  - `Approve` — `customId: "vote:approve:<requestId>"`, style
    `Success`.
  - `Deny` — `customId: "vote:deny:<requestId>"`, style `Danger`.
- **`deeplink`**: `content` = `bridgeHints.argsSummaryShort`;
  `components` = one ActionRow with one Link Button labelled
  `Open in web client`, `url:
${QWEN_DAEMON_URL}/ui/permission/<requestId>`.

The bridge SHALL NOT render `bridgeHints.argsSummaryFull` in
`deeplink` mode.

#### Scenario: Inline renders Approve/Deny buttons

- **GIVEN** a `permission_request` with
  `bridgeHints.recommendedSurface: "inline"`, `argsSummaryShort:
"Edit src/auth.ts"`, `requestId: "req_xyz"`
- **WHEN** the bridge renders it
- **THEN** the Discord message has content "Edit src/auth.ts"
- **AND** the components contain exactly two buttons with
  customIds `vote:approve:req_xyz` and `vote:deny:req_xyz`

#### Scenario: Deeplink omits full args

- **GIVEN** `recommendedSurface: "deeplink"` AND `argsSummaryFull`
  has 800 characters
- **WHEN** the bridge renders it
- **THEN** the message content does NOT contain any substring of
  `argsSummaryFull` not also in `argsSummaryShort`

### Requirement: Approve click resolves permission

When a Discord user clicks an Approve or Deny button:

1. The bridge SHALL defer the interaction reply (ephemeral).
2. The bridge SHALL POST `/permission/<requestId>` with body `{
vote: "approve" | "deny" }` and `X-RC-SubActor:
discord:<member.user.id>`.
3. The bridge SHALL edit the deferred interaction reply with "You
   voted `<approve|deny>`" or with the daemon's error message.

#### Scenario: Click posts vote with snowflake sub-actor

- **GIVEN** a permission-request message in channel `chan_42` with
  requestId `req_xyz`
- **WHEN** user `111122223333` clicks Approve
- **THEN** the bridge POSTs `/permission/req_xyz` with `vote:
"approve"`
- **AND** the request carries `X-RC-SubActor:
discord:111122223333`

#### Scenario: Voter sees private confirmation

- **WHEN** the vote succeeds
- **THEN** the voter's ephemeral reply contains "You voted approve"

#### Scenario: permission_resolved disables buttons and appends outcome

- **GIVEN** a permission-request message with messageId `m_42` in
  the bridge's in-memory map
- **WHEN** the bridge receives `permission_resolved` for the same
  requestId
- **THEN** the bridge edits `m_42` to mark each component
  `disabled: true`
- **AND** appends "Resolved: `<vote>` by `<subActor>`" to the
  message content

### Requirement: Local ban cache

The bridge SHALL maintain a local cache of banned sub-actors
populated from `sub_actor_banned` SSE events and persisted to
`$QWEN_BRIDGE_STATE_DIR/bans.json`. Banned users' messages SHALL be
silently dropped. Banned users' button interactions SHALL still be
acknowledged via deferred ephemeral reply (Discord requires
acknowledgement within 3 seconds) but SHALL NOT be relayed to the
daemon.

#### Scenario: Banned user's button click is acked but not relayed

- **GIVEN** `discord:111122223333` is in the local ban cache
- **WHEN** that user clicks Approve on a permission-request
  message
- **THEN** the bridge defers the interaction reply (so Discord
  shows no error)
- **AND** the bridge does NOT POST to `/permission/`

### Requirement: Log redaction

The bridge SHALL never write `DISCORD_BOT_TOKEN` or any
`qwk_<...>`-prefixed string in plaintext to any log output.

#### Scenario: Token not logged

- **GIVEN** debug logging is enabled
- **WHEN** the bridge logs its configuration
- **THEN** stdout contains neither the bot token nor any `qwk_*`
  string in cleartext

### Requirement: Healthz endpoint

The bridge SHALL expose `GET /healthz` on its local HTTP server
(default port 9100) returning `{ ok: true, daemonReachable: bool,
gatewayConnected: bool, registeredId: string|null, uptimeSec: number
}`.

#### Scenario: Healthz reports gateway disconnect

- **GIVEN** the gateway WebSocket is disconnected
- **WHEN** `GET /healthz` is called
- **THEN** the response body has `gatewayConnected: false`
