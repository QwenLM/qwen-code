# Discord bridge

The Discord bridge lets a team approve tool calls and send prompts to a qwen
session from a Discord channel. It is the second conformant consumer of the
`add-bridge-protocol` contract (after Telegram) and runs **in-process** inside
the gateway, talking the gateway only over the loopback HTTP+SSE contract with an
operator-minted bridge-scope token — so it can be promoted to a separate-process
sidecar later by changing only its configuration.

> **Placement note.** The change spec proposes a standalone
> `packages/bridge-discord/` package and `docs/bridges/discord.md`. To honor this
> fork's zero-edit boundary (everything lives under `packages/rc-gateway/`), the
> bridge is built in-process at `src/bridges/discord/` and this doc lives here.
> The trust/contract boundary is identical either way.

## What it does

- Renders each `permission_request` into a channel message with **Approve /
  Deny** buttons (or a single _Open in web client_ link button when the gateway
  marks the call sensitive/large — the full args are never dumped to chat).
- Turns a button click into a gateway vote, attributed to the clicking Discord
  user.
- Forwards chat messages in a bound channel to the session as prompts.
- Edits the original message (disabling the buttons, appending the outcome) when
  the request resolves.

### Not yet built (deferred)

This delivery is the **approval surface**, matching the Telegram bridge. The
following spec requirements are intentionally deferred and are **not** present:

- **`session_update` streaming** (mirroring the agent's running output into the
  channel, with the 2000-char safe-split). The bridge keeps channels quiet —
  only `permission_request` is rendered.
- **Threads on long streams** (design D4). With no `session_update` streaming
  there is nothing to thread.
- Registration declares `supportsMarkdown: true` rather than the spec's
  `"limited"` plus `supportsThreads`/`supportsEdits` (the shared `BridgeClient`
  registration shape is boolean-only today).

## Setup

### 1. Create a Discord application + bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications),
   create a **New Application**, and note its **Application ID**.
2. Under **Bot**, add a bot and copy its **token** (`DISCORD_BOT_TOKEN`).
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**
   (required to read prompt text from chat messages).

### 2. Invite the bot to a server

In the Developer Portal under **OAuth2 → URL Generator**, select the scopes
`bot` and `applications.commands`, then tick the permissions **Send Messages**,
**Read Message History**, **Create Public Threads**, **Send Messages in
Threads**, and **Use Application Commands**. The generator produces a URL of the
form:

```
https://discord.com/api/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=<generated>
```

(Use the generated `permissions` integer rather than hand-computing the bitfield.)
Open the URL and add the bot to a server you control. Bound channels should be
private — anyone who can see a bound channel can see the deeplink (which exposes
the gateway URL; the URL is not a secret, bearer auth is what protects the
daemon).

### 3. Mint a bridge token

The bridge authenticates to the gateway with its **own** bridge-scope token,
which the operator mints explicitly (it is never auto-minted):

```
POST /rc/tokens  { "scopes": ["bridge"] }   # requires an owner token
```

Set the returned `qwk_*` value as `QWEN_BRIDGE_TOKEN`.

### 4. Configure and run

The bridge starts automatically when the gateway boots **and** all required env
vars are present:

| Variable                 | Required | Notes                                                                                                                                               |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`      | yes      | Bot token from the Developer Portal.                                                                                                                |
| `DISCORD_APPLICATION_ID` | yes      | Application id (used to register slash commands).                                                                                                   |
| `QWEN_BRIDGE_TOKEN`      | yes      | A `bridge`-scope token minted as above.                                                                                                             |
| `DISCORD_GUILD_ID`       | no       | If set, the `/qwen` command is registered guild-scoped (appears in seconds); otherwise globally (~1 hour to propagate). Recommended in development. |
| `QWEN_DAEMON_URL`        | no       | User-reachable gateway URL for deeplinks (a phone can't reach loopback). Falls back to the loopback address.                                        |

If `DISCORD_BOT_TOKEN` + `DISCORD_APPLICATION_ID` are set but `QWEN_BRIDGE_TOKEN`
is missing, the gateway logs a warning and does **not** start the bridge.

## Usage

### Binding a channel

In a channel the bot can see, run:

```
/qwen attach <sessionId>
```

The reply is **ephemeral** (visible only to you). `/qwen detach` unbinds the
channel; `/qwen status` reports the current binding and a usage tip.

> **Binding deviation.** The spec's `/qwen attach` redeems a one-time invite
> token via a `/rc/bridges/:id/invite/redeem` route. That route is not part of
> the bridge-protocol contract yet (neither the contract nor the Telegram bridge
> built it), so `/qwen attach` currently binds a **session id directly**,
> mirroring Telegram's `/start <sessionId>`. Invite-token redemption is a
> deferred contract enhancement.

### Sending prompts

Once a channel is bound, **type in chat** to send a prompt to the session. Slash
commands are the control plane; the chat input is the data plane. The bot's own
messages are never relayed back to the daemon.

### Approving tool calls

When the agent requests permission, the bridge posts a message with Approve /
Deny buttons. Click one; you get an ephemeral "You voted approve" confirmation,
and the original message is edited to show the outcome and grey out the buttons.
For sensitive or oversized calls the bridge instead posts an _Open in web client_
link so you can review full args before approving.

### Sub-actor identity

Every prompt and vote carries `X-RC-SubActor: discord:<user-snowflake>`. The
snowflake is Discord's immutable numeric user id (never a username, which is
mutable). This is what the gateway's per-sub-actor rate limit and bans key on.

## Bans

An owner bans a Discord user on the bridge without revoking the bridge token:

```
POST /rc/bridges/discord/ban   { "subActor": "discord:<snowflake>" }
```

The bridge also caches any `403` the gateway returns for a sub-actor, so a banned
user's later messages are dropped locally without re-hitting the daemon. A banned
user's button click is still acknowledged (Discord requires an ack within 3
seconds) but is not relayed.

## Token rotation

Bot token and bridge token rotate independently and should be rotated together
if either leaks:

- **Bot token leak:** regenerate it in the Developer Portal **and** revoke the
  bridge token.
- **Bridge token leak:** revoke it via `DELETE /rc/tokens/:id`; the audit log
  pinpoints anything it did.

Channel bindings live in `~/.qwen/rc/bridges/discord/channels.json` and survive a
restart, so re-running the bridge with new credentials preserves them.

## Troubleshooting

- **Slash command doesn't appear:** global commands take ~1 hour to propagate;
  set `DISCORD_GUILD_ID` for instant guild-scoped registration during setup.
- **Bridge logs `registration returned 401`:** the `QWEN_BRIDGE_TOKEN` is wrong,
  revoked, or not a `bridge`-scope token. Mint a fresh one.
- **Prompts aren't forwarded:** confirm Message Content Intent is enabled and the
  channel is bound (`/qwen status`).
- **`command registration failed` / `login failed`:** the bot token is wrong or
  the bot lacks the `applications.commands` scope on the server.

## Verification ceiling

The pure layers — rendering, event normalization, the channel store, the REST
client, and the dispatcher — are unit-tested. The runner's outbound delivery and
subscription logic are unit-tested with fakes. The **live discord.js gateway
connection** (heartbeat, IDENTIFY, RESUME, inbound interaction delivery) is
delegated to `discord.js` and is **not** exercised in CI — there is no real
Discord to test against in this environment. A boot-smoke confirms the module
chain loads and that the bridge authenticates over the loopback contract (a bad
token draws a `401` from the gateway's own auth).
