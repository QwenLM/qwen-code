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
- **Streams the agent's running output** (`session_update`) into the channel:
  chunks are buffered and flushed on a paragraph break / fenced-code close, at
  1800 chars, or 1500 ms after the last chunk, then split into ≤2000-char
  messages at safe boundaries (fence close > paragraph > word > hard cut), with
  code fences kept balanced across the split (the closing/reopening fence chars
  count against the 2000 budget).
- **Threads on long streams** (design D4): after 6 messages in one agent turn,
  the 7th and later are posted into a public thread opened off the turn's first
  message, keeping the channel readable. A new turn (the event after a resolve,
  or the next inbound prompt) goes back to the channel, not the old thread.

### Deliberate scope / deferrals

- Only `agent_message_chunk` (the assistant's prose) is streamed; thought and
  tool-call chunks are skipped to keep channels readable.
- A code block split across two _separate_ flushes renders as two blocks (each
  individually fence-balanced); cross-flush fence continuity is not attempted.
- If a turn ends with a sub-trigger tail still buffered (no paragraph break,
  under the char cap, idle timer not yet fired), that tail isn't force-flushed at
  the boundary — it merges into the next turn's first message. Cosmetic only;
  content and fence balance are preserved.
- **Last-Event-ID resume is not used.** The daemon replays nothing without a
  cursor (`EventBus.subscribe` only replays when a cursor is supplied), so a
  reconnect drops chunks emitted _during_ the blip rather than double-posting the
  turn. Catching up on in-blip chunks is a deferrable gap-coverage enhancement.
- Registration advertises the full spec capability shape: `supportsMarkdown:
"full"`, `supportsActions: true`, `supportsThreads: true`, `supportsEdits:
true`, `maxMessageBytes: 2000`.

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

Binding is **operator-issued** — a channel only binds when an operator hands out
a one-time invite token. First, on the workstation, mint an invite for the
session you want to expose:

```
curl -s -X POST http://127.0.0.1:4170/rc/bridges/invites \
  -H "Authorization: Bearer <OWNER token>" \
  -H 'content-type: application/json' \
  -d '{"kind":"discord","sessionId":"<session id>"}'
# → { "token": "inv_…", "expiresAt": … }
```

Then, in a channel the bot can see, a guild member runs:

```
/qwen attach <invite token>
```

The bridge redeems the token via `POST /rc/bridges/:id/invite/redeem`, binds the
channel to the session the token names, and replies **ephemerally** (visible only
to you). A guild member never types a session id — the operator decides every
channel→session binding, and an invalid or expired token is refused with the
gateway's error text (no binding persisted). `/qwen detach` unbinds the channel;
`/qwen status` reports the current binding and a usage tip.

Invites are one-time and short-lived (20 min). The gateway holds them in memory,
so a gateway restart drops any unredeemed invite — just mint a fresh one.

### Sending prompts

Once a channel is bound, **type in chat** to send a prompt to the session. Slash
commands are the control plane; the chat input is the data plane. The bot's own
messages are never relayed back to the daemon. As the agent works, its reply is
streamed back into the channel (and into a thread once a turn runs long — see
above).

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
