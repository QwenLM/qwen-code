# add-discord-bridge

## Why

`add-bridge-protocol` defined the contract; `add-telegram-bridge` is
the first conformant implementation. Discord covers a different
team-shape: persistent server channels per project, threads for
long-running work, ephemeral replies for private feedback, and a
gateway (WebSocket) transport so the bridge does not need to expose
a public webhook endpoint to host a slash-command interaction
receiver.

The patterns established by `add-telegram-bridge` — env-only
config, atomic JSON persistence, hint-driven rendering,
sender-attributed sub-actors, decoupled SSE-vs-chat back-pressure —
apply directly. This change deviates where Discord's surface
differs: slash commands instead of `/start` deeplinks, message
components (buttons) with a hard limit of 5 per row, threads as a
first-class capability, and a 2000-character message size limit.

## What Changes

- **New sidecar process `qwen-bridge-discord`.** Same shape as the
  Telegram bridge: standalone Node binary, Docker image, env-only
  config (`DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`,
  `QWEN_DAEMON_URL`, `QWEN_BRIDGE_TOKEN`).
- **Discord bot setup procedure documented.** Operator creates a
  Discord application + bot in the Developer Portal, captures the
  bot token and application id, invites the bot to a server with
  the scopes `bot` + `applications.commands` and permissions
  `Send Messages`, `Read Message History`, `Create Public Threads`,
  `Send Messages in Threads`, `Use Application Commands`.
- **Slash commands for channel binding:** `/qwen attach <invite>`
  binds the current channel to a session. `/qwen detach` unbinds.
  `/qwen status` reports binding and daemon health. All three
  reply ephemerally (visible only to the invoker).
- **Gateway transport, not HTTP interactions.** The bridge connects
  to Discord's gateway WebSocket so no public URL is required.
  Slash-command interactions arrive over the gateway as
  `INTERACTION_CREATE` events.
- **Message components for `permission_request`.** Approve / Deny
  buttons in a single ActionRow. Approval votes acknowledged with
  ephemeral replies ("You voted approve").
- **Threads for long-running tool calls.** When the bridge has
  rendered ≥ 6 `session_update` chunks for a single agent turn, it
  opens a public thread off the channel-bound message and continues
  streaming there. Capability flag `supportsThreads: true`.
- **Capability declaration:** `supportsActions: true`,
  `supportsMarkdown: "limited"`, `maxMessageBytes: 2000`,
  `supportsThreads: true`, `supportsEdits: true`.
- **Sub-actor:** `discord:<user-snowflake>`. Snowflake ids are
  immutable; usernames and discriminators are mutable.

## Capabilities

### New Capabilities

- `discord-bridge` — Discord-specific behaviour of the sidecar
  process that conforms to `bridge-protocol`: slash-command channel
  binding, gateway transport, message-component rendering,
  thread-on-long-stream policy, snowflake-based sub-actor, ephemeral
  reply semantics.

## User Stories

**D1. Operator installs the bridge.** Operator creates a Discord
app, copies bot token + application id, runs `qwen rc pair --scope
bridge --name discord` on the workstation, runs the bridge
container with env vars. Bridge logs "registered as br\_..."; the
operator invites the bot to a server using the OAuth2 URL printed
by the bridge on first boot.

**D2. Team member binds a channel.** Operator generates an invite
token via `qwen rc bridges invite --kind discord --session
sess_abc`. Team member runs `/qwen attach inv_xyz` in the desired
channel. Bridge redeems the token, persists the channel binding,
and replies ephemerally "Channel bound to session `sess_abc`."

**D3. Approve from Discord.** Agent fires `permission_request`.
Bridge sends a channel message with `argsSummaryShort` and an
ActionRow with Approve / Deny buttons. Team member clicks Approve.
Bridge POSTs vote with `X-RC-SubActor:
discord:<user-snowflake>`, then sends an ephemeral reply "You
voted approve" and edits the original message to disable the
buttons.

**D4. Long stream goes to thread.** Agent runs a multi-minute test
suite. After the 6th `session_update` chunk on a turn, the bridge
opens a thread off the original message and continues streaming
there. The channel stays uncluttered; the thread holds the noisy
output.

**D5. Banned sub-actor.** Operator bans
`discord:111122223333444455` via `qwen rc bridges ban`. Bridge
receives `sub_actor_banned`, caches it, silently drops future
messages and slash-command interactions from that user.

**D6. Token rotation.** Bot token rotated in Discord developer
portal; the bridge's daemon token also rotated via `qwen rc tokens
revoke`. Bridge restarted with new creds. Channel bindings
preserved.

## Impact

- **New package**: `packages/bridge-discord/` (Node, TypeScript,
  bundled via esbuild; Docker image).
- **Depends on**: `add-bridge-protocol`, and reuses the
  `/rc/bridges/:id/invite` route extension introduced by
  `add-telegram-bridge`.
- **No daemon changes** specific to this bridge — entirely a
  sidecar.
- **Docs**: `docs/bridges/discord.md` covering Developer Portal
  setup, scopes/permissions, slash-command registration, gateway
  vs interactions endpoint trade-off, troubleshooting.
- **Library choice**: `discord.js` (most stable TS bindings) OR
  `@discordjs/core` (lower-level, smaller). Decision recorded in
  design.
- **Out of scope:**
  - Voice channels.
  - HTTP interactions endpoint mode (public URL required). Future.
  - Discord guild-wide commands (vs per-guild). Per-guild only in
    v1.
  - Forum channels.
  - Multi-bot from one bridge process.
