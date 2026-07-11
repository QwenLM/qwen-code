# Design — add-discord-bridge

## Context

`add-telegram-bridge` shipped the first conformant bridge; this is
the second. Discord is the relevant next target because it serves a
different team shape (persistent server channels, threads,
ephemeral replies) and because its idioms — slash commands, message
components, gateway WebSocket — exercise parts of the bridge
contract Telegram does not.

We re-use the patterns established in `add-telegram-bridge`:
env-only config; atomic JSON persistence; hint-driven rendering;
sender-attributed sub-actors; decoupled SSE-vs-chat back-pressure.
We deviate where Discord's surface differs:

- Slash commands replace `/start` deeplinks.
- Message components (buttons in an ActionRow, max 5 per row)
  replace Telegram inline keyboards.
- Threads are a first-class affordance for long-running tool calls.
- Message size cap is 2000 chars, not 4096.
- Sub-actor is a snowflake, not a numeric user id.

## Goals / Non-Goals

**Goals:**

- Single-container deployment with env config and no public URL.
- Conform to `bridge-protocol` registration, heartbeat, rate-limit,
  ban, and hint semantics without modification.
- Slash-command UX consistent with Discord conventions
  (ephemeral replies for private feedback, public messages only
  when intended).
- Thread management that keeps channels readable during long
  streams.

**Non-Goals:**

- HTTP interactions endpoint mode (requires public URL + ed25519
  signature verification). Future.
- Voice / video features.
- Forum channels.
- Cross-guild identity reconciliation.
- Slash-command-driven prompt entry (use the chat input; slash
  commands are for control verbs only).

## Architecture

```
   Operator workstation                       Discord gateway / REST
   ┌─────────────────────────────┐
   │ qwen serve (daemon)         │
   │  +bridge-protocol routes    │
   └──────────────┬──────────────┘
                  │ HTTP+SSE (loopback or LAN)
                  │ X-RC-SubActor: discord:<snowflake>
   ┌──────────────┴──────────────┐         ┌─────────────────────┐
   │ qwen-bridge-discord         │ WSS     │ gateway.discord.gg  │
   │  - SSE consumer (per chan)  │◀───────▶│   READY, INTERACTION│
   │  - Gateway client           │         │   _CREATE, MESSAGE  │
   │  - Slash command registrar  │         └─────────────────────┘
   │  - channel<->session store  │         ┌─────────────────────┐
   │  - thread manager           │ HTTPS   │ discord.com/api/... │
   │  - sensitivity renderer     │◀───────▶│   sendMessage,      │
   │  - ban filter cache         │         │   editMessage,      │
   └─────────────────────────────┘         │   createThread,...  │
            │                                └─────────────────────┘
            └── ~/.qwen/rc/bridges/discord/channels.json
                ~/.qwen/rc/bridges/discord/cursors.json
                ~/.qwen/rc/bridges/discord/bans.json (cache)
```

Loops:

1. **Gateway loop.** Persistent WebSocket. Receives
   `INTERACTION_CREATE` (slash commands, button clicks) and
   `MESSAGE_CREATE` (chat messages in bound channels). Heartbeats per
   Discord's protocol.
2. **SSE loop per binding.** Same pattern as Telegram: one SSE
   stream per bound session, last-event-id cursor persisted.
3. **Discord REST loop.** Outbound message / thread / edit calls.

## Configuration

| Var                        | Required | Notes                                                                                                                 |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`        | yes      | From Developer Portal.                                                                                                |
| `DISCORD_APPLICATION_ID`   | yes      | App id from Developer Portal.                                                                                         |
| `QWEN_DAEMON_URL`          | yes      | daemon base URL.                                                                                                      |
| `QWEN_BRIDGE_TOKEN`        | yes      | `qwk_*` bridge-scope token.                                                                                           |
| `QWEN_BRIDGE_PAIRING_CODE` | no       | One-time bootstrap.                                                                                                   |
| `QWEN_BRIDGE_STATE_DIR`    | no       | Default `~/.qwen/rc/bridges/discord`.                                                                                 |
| `DISCORD_GUILD_ID`         | no       | If set, slash commands registered guild-scoped (fast); else global (~hourly propagation). Recommended in development. |
| `BRIDGE_LOG_LEVEL`         | no       | `info` default.                                                                                                       |

## Slash commands

Three commands, registered at boot. Guild-scoped if
`DISCORD_GUILD_ID` is set; otherwise globally registered (Discord
caches global commands for ~1 hour, so dev iteration is faster with
guild scope).

| Command        | Description                                     | Reply     |
| -------------- | ----------------------------------------------- | --------- |
| `/qwen attach` | Bind this channel to a session via invite token | ephemeral |
| `/qwen detach` | Unbind this channel                             | ephemeral |
| `/qwen status` | Show binding + daemon health                    | ephemeral |

All three reply with `INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE`
and `flags: 64` (ephemeral). Slash commands are control plane; the
chat input is the data plane (prompts).

## Channel ↔ session binding

Same shape as Telegram's chats.json:

```jsonc
{
  "version": 1,
  "channels": [
    {
      "channelId": "1234567890",
      "guildId": "0987654321",
      "sessionId": "sess_abc",
      "boundAt": "<ISO>",
    },
  ],
}
```

Binding lives until `/qwen detach` or removal via the operator CLI.
Re-attaching overwrites.

## Rendering

### Plain session updates

Buffered streaming, similar to Telegram but with the lower 2000-char
cap. Flush triggers:

- Paragraph / code-fence boundary, OR
- 1500 ms idle, OR
- buffer ≥ 1800 chars.

Discord's Markdown subset is honoured; the bridge's "limited"
declaration captures the difference from CommonMark (no headings,
no tables; bold/italic/strike/inline-code/fenced-code/spoiler/link).

### Threads on long streams

When the bridge has flushed ≥ 6 messages for a single agent turn
into a bound channel, it opens a public thread off the **first**
message of that turn (`channels/<id>/messages/<msgId>/threads`) and
redirects subsequent flushes for that turn to the thread. The
channel sees only the first 6 messages plus a "(continued in
thread)" marker.

A turn boundary is the SSE event after a `permission_resolved` or
the next user prompt. Threads do not span turns.

### permission_request

Branch on `bridgeHints.recommendedSurface`:

- **`inline`**: channel message with `argsSummaryShort` body and an
  ActionRow with two buttons:
  - `Approve` — custom_id `vote:approve:<requestId>`, style `Success`
  - `Deny` — custom_id `vote:deny:<requestId>`, style `Danger`
- **`deeplink`**: channel message with `argsSummaryShort` and an
  ActionRow with one link button:
  - `Open in web client` — `url:
${QWEN_DAEMON_URL}/ui/permission/<requestId>`

Discord allows at most 5 buttons per ActionRow and at most 5 rows;
we use one row with up to two buttons, well within the limit.

On button click (an `INTERACTION_CREATE` with type `MESSAGE_COMPONENT`):

1. Parse custom_id.
2. POST `/permission/<id>` with vote + `X-RC-SubActor:
discord:<user-snowflake>`.
3. Respond to the interaction with an ephemeral message
   "You voted approve" (so the voter gets immediate feedback).
4. On the subsequent `permission_resolved`, edit the original
   channel message to disable the buttons (set `disabled: true` on
   each component) and append a "Resolved" line.

### Sub-actor identity

`discord:<user-snowflake>`. Snowflakes are immutable Discord ids
(distinct from usernames, which are mutable, and discriminators,
which have been phased out for most accounts).

Extracted from `interaction.member.user.id` or `message.author.id`.

## Rate limits

Discord's REST API rate limits are per-route and per-bucket, surfaced
via headers `X-RateLimit-Remaining` / `X-RateLimit-Reset-After`. The
bridge's REST client SHALL respect these headers and queue accordingly.

On daemon `429`, the bridge sends an ephemeral reply to the
originating user ("Slow down, retry in N s").

Gateway connections heartbeat per Discord's `HELLO` opcode; on
disconnect the bridge reconnects with backoff and resumes via
`session_id` + `seq` when possible.

## Bans

Same pattern as Telegram. `sub_actor_banned` SSE event populates a
local cache; banned users' messages and component interactions are
dropped before any daemon call.

For component interactions, the bridge MUST still acknowledge the
interaction within Discord's 3-second window — otherwise the user
sees an "interaction failed" red bar. The bridge ACKs with a
deferred ephemeral response and does nothing further.

## Packaging

- **Docker image** `ghcr.io/qwen-code/bridge-discord:<ver>`.
- **Single binary** via `bun build --compile`.
- **Source package** `packages/bridge-discord/`.

## Threat model

| Attacker                                         | Capability                                   | Mitigation                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Bot token leak                                   | Impersonate bot in every guild it joined     | Operator regenerates the bot token in Developer Portal AND revokes the bridge token. Coupled rotation.                            |
| Bridge token leak                                | Mint prompts / votes with arbitrary subActor | Revoke bridge token; audit pinpoints actions.                                                                                     |
| Slash-command spoofing                           | None — Discord signs all gateway events      | Gateway TLS + Discord's auth. Bridge trusts gateway events from `wss://gateway.discord.gg`.                                       |
| Guild member with channel access                 | Spam prompts via chat                        | Per-sub-actor rate limit (daemon-side); sender-attributed sub-actor; operator can ban.                                            |
| Hostile guild operator                           | Add the bot to a guild they control          | Bridge enforces channel-binding: unbound channels are ignored. Operator must explicitly invite the bot AND issue an invite token. |
| Bot retains channel permissions after compromise | Read backlog of bound channels               | Bot permissions are guild-managed; operator removes the bot from the guild once token is revoked.                                 |
| Public link button leaks daemon URL              | Anyone in channel sees the daemon URL        | Acceptable: the URL is not a secret; bearer auth is what protects the daemon. Document that bound channels should be private.     |

## Decisions

### D1 — Gateway WebSocket, not HTTP interactions endpoint

**Choice**: Connect to Discord's gateway over WSS. Receive
interactions and messages as gateway events.

**Alternative considered**: HTTP interactions endpoint
(`https://your-daemon/discord-webhook`) where Discord POSTs.

**Why**: HTTP interactions require a public HTTPS endpoint with
ed25519 signature verification. The self-host audience explicitly
opts out of public endpoints. Gateway works behind any NAT / VPN /
tunnel. The cost is a persistent WSS connection per bridge instance,
which is cheap.

**Cost**: One process per bot. If an operator wanted multi-bot from
one bridge, gateway makes that more memory-bound; not in scope.

### D2 — `discord.js` for high-level client

**Choice**: `discord.js` v14+. Higher-level than
`@discordjs/core`; covers gateway + REST + caching with idiomatic
patterns.

**Alternative considered**: `@discordjs/core` (lower level, fewer
abstractions, smaller bundle).

**Why**: Slash-command registration, component handling, and
gateway resumption are all idiomatic in `discord.js`. `@discordjs/
core` would require ~30% more code to achieve the same correctness.
The bundle-size penalty (a few hundred KB) is acceptable for a
sidecar.

**Cost**: One more transitive dep tree. Acceptable.

### D3 — Slash commands for control plane, chat for data plane

**Choice**: `/qwen attach`, `/qwen detach`, `/qwen status` exclusively
manipulate channel state. Prompts are typed as chat messages.

**Alternative considered**: A `/qwen prompt <text>` slash command.

**Why**: Slash commands have a 4000-char arg limit, ephemeral-by-
default semantics, and arg-parsing UX that doesn't fit free-form
multi-line prompts. The chat input is the natural data entry
surface; slash commands are for control verbs.

**Cost**: Operators must explain "type in chat to prompt the agent"
to first-time users. Mitigated by `/qwen status` printing usage on
demand.

### D4 — Thread off long streams after 6 messages

**Choice**: After 6 message flushes in one agent turn, open a public
thread and continue there.

**Alternative considered**: Stream everything inline; let users
collapse manually. Or: open a thread immediately.

**Why**: Inline-only floods channels for long-running tool calls
(a 10-minute test suite). Threading immediately fragments the
common short-call case. Threshold at 6 captures the long-tail and
leaves short interactions inline.

**Cost**: Tunable parameter `THREAD_THRESHOLD` env var (default 6).
The 7th message creates the thread, which is one extra REST call
per long turn — negligible.

### D5 — Ephemeral interaction replies after vote

**Choice**: After a vote, the bridge sends an ephemeral
"You voted approve" reply to the voter, then edits the original
public message on `permission_resolved` to show the outcome.

**Alternative considered**: Only edit the public message; no
private ack.

**Why**: There's a race between vote-submitted and `permission_resolved`
SSE arrival. The voter needs immediate feedback that their click
was registered, distinct from the public outcome (which may
include a different winning voter). Ephemeral reply solves it
cleanly.

**Cost**: One extra interaction response per vote. Discord
ephemeral replies are free.

### D6 — Snowflake-only sub-actor; never username

**Choice**: `discord:<snowflake>`.

**Alternative considered**: `discord:<username>` or
`discord:<username>#<discrim>`.

**Why**: Discord's username system changed in 2023 — discriminators
were deprecated, usernames became mutable. Snowflakes are immutable
and globally unique across Discord.

**Cost**: Audit logs are less human-readable; bridges optionally
log last-seen username as audit metadata.

## Risks / Trade-offs

| Risk                                               | Likelihood | Impact | Mitigation                                                                                                      |
| -------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| Gateway disconnect during important stream         | M          | M      | `discord.js` auto-resume via `session_id+seq`; if resume fails, full reconnect + replay daemon SSE from cursor. |
| Slash commands stuck in stale state (global cache) | L          | M      | Recommend `DISCORD_GUILD_ID` for prod and dev; document the 1-hour global propagation delay.                    |
| Bot kicked from guild mid-session                  | L          | M      | Bridge logs and detaches affected channels; bindings purged on next boot scan.                                  |
| 2000-char limit truncates important content        | M          | L      | Safe-boundary splitter; large blobs use threads anyway.                                                         |
| Discord-side ban / token revocation                | L          | H      | Bridge crashes loudly; operator regenerates and re-pairs.                                                       |

## Open questions

1. **Should the bridge support multiple guilds per process?** Today
   one bot can be in many guilds; the bridge already handles
   per-channel bindings. Question is whether `DISCORD_GUILD_ID`
   should be a list. Defer; YAGNI.

2. **Should we register slash commands as user-context or guild-
   context?** Currently guild commands (or global if no
   `DISCORD_GUILD_ID`). User-context commands would let any user
   who installed the app run `/qwen attach` in any DM. Out of
   scope for v1.

3. **Should `/qwen attach` autocomplete invite tokens from a paste
   buffer or QR?** Discord supports autocomplete on slash arguments
   but the bridge would have to remember pending invites. Defer.

4. **Reactions as a fallback voting UI?** Matrix uses reactions;
   Discord supports them too. For consistency we use buttons only
   in v1; reactions could be a future fallback if `supportsActions:
false` flag is ever needed for a fork.
