# Design — add-telegram-bridge

## Context

`add-bridge-protocol` defined the bridge contract; this is its first
concrete consumer. Telegram is well suited for the pilot:

- Bot API is stable, well documented, and free.
- Long-polling (`getUpdates`) works without a public webhook URL,
  so a daemon behind Tailscale, a wireguard tunnel, or just a NAT
  doesn't need to expose itself to Telegram's servers.
- Inline keyboard buttons map 1:1 onto bridge-protocol's
  `permission_request` Approve/Deny semantic.
- Numeric user ids are stable identifiers (unlike usernames),
  matching the spec's sub-actor requirements.
- Operators usually already have Telegram on their phone — fewer
  new apps in the trust path.

Since this is the first conformant bridge, this design also records
the patterns that the Discord and Matrix bridges will mirror: env-
based config, chat-to-session binding via deeplink, hint-driven
rendering, persistence shape, and back-pressure handling.

## Goals / Non-Goals

**Goals:**

- A single-binary or single-container bridge an operator can run
  next to the daemon with three env vars.
- No daemon code in the bridge process; bridge speaks only the
  documented HTTP+SSE protocol from `add-bridge-protocol`.
- Stable sub-actor identifiers; ban-and-recover flow works.
- Crash-safe chat-to-session bindings (persist to disk).
- Renders permission requests correctly across `inline` and
  `deeplink` hints.

**Non-Goals:**

- Webhook deployment mode. Long-polling only in v1.
- Rich file upload / preview from Telegram to the agent.
- Inline-query mode (`@bot search...`). Not in the user stories.
- Cross-bot multiplex. One bridge = one bot.
- Translating Telegram message formatting back to canonical
  agent prompt formatting. Plain text in, that's the prompt.

## Architecture

```
   Operator workstation                      Telegram servers
   ┌─────────────────────────────┐
   │ qwen serve (daemon)         │
   │  +bridge-protocol routes    │
   └──────────────┬──────────────┘
                  │ HTTP+SSE (loopback or LAN)
                  │ Authorization: Bearer qwk_*
                  │ X-RC-SubActor: telegram:<id>
   ┌──────────────┴──────────────┐         ┌─────────────────────┐
   │ qwen-bridge-telegram        │ HTTPS   │ api.telegram.org    │
   │  - SSE consumer             │◀───────▶│   getUpdates (LP)   │
   │  - Telegram poller          │         │   sendMessage       │
   │  - chat<->session store     │         │   answerCallbackQ.  │
   │  - sensitivity renderer     │         └─────────────────────┘
   │  - ban filter cache         │
   └─────────────────────────────┘
            │
            └── ~/.qwen/rc/bridges/telegram/chats.json
                ~/.qwen/rc/bridges/telegram/bans.json (cache)
```

Two independent loops in the bridge process:

1. **Daemon loop.** Long-running SSE subscription per bound session.
   Translates daemon events into Telegram messages.
2. **Telegram loop.** `getUpdates` long-poll. Translates inbound
   messages and callback queries into daemon HTTP calls.

A shared, in-memory `(chatId → sessionId, subActor)` map, persisted
to disk on every mutation. No DB; JSON file with atomic replace.

## Configuration

Environment variables only (twelve-factor; matches the Docker
deployment story):

| Var                        | Required | Notes                                                                   |
| -------------------------- | -------- | ----------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | yes      | From BotFather. Treated as secret.                                      |
| `QWEN_DAEMON_URL`          | yes      | e.g. `https://daemon.tailnet.ts.net`                                    |
| `QWEN_BRIDGE_TOKEN`        | yes      | `qwk_*` bridge-scope token.                                             |
| `QWEN_BRIDGE_PAIRING_CODE` | no       | If set, bridge redeems and exits or persists token; one-time bootstrap. |
| `QWEN_BRIDGE_STATE_DIR`    | no       | Default `~/.qwen/rc/bridges/telegram`.                                  |
| `BRIDGE_LOG_LEVEL`         | no       | `info` default.                                                         |

`QWEN_BRIDGE_TOKEN` and `QWEN_BRIDGE_PAIRING_CODE` are mutually
exclusive at the "persisted" level; the pairing code is consumed at
first boot and the resulting token written to
`$QWEN_BRIDGE_STATE_DIR/token` (mode 0600). Subsequent boots ignore
the pairing code env if a token file exists.

## Chat ↔ session binding

There is no implicit binding. The operator generates a one-time
deeplink:

```
$ qwen rc bridges invite --kind telegram --session sess_abc123
https://t.me/myqwenbot?start=inv_K9X2P7L
```

The team member clicks it. Telegram opens the chat and sends
`/start inv_K9X2P7L`. The bridge:

1. Verifies `inv_K9X2P7L` against the daemon (a new `POST
/rc/bridges/:id/invite/redeem` route, added as a small extension
   to `add-bridge-protocol` — see Decisions D3).
2. Writes `{chatId, sessionId, telegramUserId}` to `chats.json`.
3. Replies "Bound chat to session `sess_abc123`. You will see tool-
   call approval requests here."

A chat can only be bound to one session at a time. Re-binding via a
fresh `/start` overwrites. `/detach` unbinds.

`chats.json` shape:

```jsonc
{
  "version": 1,
  "chats": [
    {
      "chatId": -1001234567890,
      "sessionId": "sess_abc123",
      "primarySubActor": "telegram:12345",
      "boundAt": "<ISO>",
    },
  ],
}
```

Atomic write: write to `.chats.json.tmp`, fsync, rename.

## Rendering

### Plain session updates

`session_update` events stream as Telegram messages. To avoid
flooding, the bridge buffers chunks and flushes either when:

- A meaningful boundary is reached (paragraph break, code-fence
  close, end of message), OR
- 1500 ms have elapsed since the last flush.

Buffered chunks > `maxMessageBytes` (4096) are split at the nearest
safe boundary (code-fence close > paragraph break > word break).
MarkdownV2 escape table applied to all non-code text. Code blocks
preserved verbatim, opened/closed with triple backtick.

### Permission requests

Branch on `bridgeHints.recommendedSurface`:

- **`inline`**: Send a message containing `argsSummaryShort`
  (already ≤140 chars from the daemon) with a two-button reply
  markup:

  ```
  ┌──────────┬──────────┐
  │ Approve  │  Deny    │
  └──────────┴──────────┘
  ```

  Callback data: `vote:approve:<requestId>` /
  `vote:deny:<requestId>`. On tap, bridge POSTs
  `/permission/:requestId` with `X-RC-SubActor: telegram:<userId>`
  and answers the callback query with a green tick.

- **`deeplink`**: Send a message containing only `argsSummaryShort`
  (NOT `argsSummaryFull`) plus one inline button labeled "Open in
  web client" pointing to
  `${QWEN_DAEMON_URL}/ui/permission/${requestId}`. Honours the
  daemon's sensitivity hint without baking sensitivity classification
  into the bridge.

On `permission_resolved`, bridge edits the original message (uses
`supportsEdits: true` capability) to replace buttons with the
outcome text: `Approved by telegram:12345` or `Denied`.

### Sub-actor identity

`telegram:<numeric-user-id>`. Numeric IDs are stable across username
changes and across the user moving between devices. Usernames are
NOT used because they are mutable and reservable; a banned user
could reclaim a username.

The numeric ID is exposed by every `update.message.from.id` and
`update.callback_query.from.id`.

## Rate limits

Two layers:

1. **Daemon → bridge.** Daemon enforces per-sub-actor and per-
   bridge token buckets (spec'd in `add-bridge-protocol`). On
   `429`, bridge:
   - Sends a chat reply to the sub-actor: "You're sending too
     fast. Try again in N seconds." where N = `Retry-After` header
     value.
   - Records the event locally for debugging; does NOT retry
     automatically (the user retries via the chat).

2. **Telegram → bridge.** Telegram rate-limits the bot at 30 msg/sec
   global and 1 msg/sec per chat. On `429` from Telegram:
   - Exponential backoff with jitter: 1s, 2s, 4s, 8s, capped at
     30s. After 5 consecutive failures for the same chat, drop the
     send and log; the SSE consumer keeps running so we don't
     stall daemon events.

The bridge never delays SSE consumption based on Telegram
back-pressure. Telegram is the lossy side; the daemon log is the
source of truth.

## Bans

On `sub_actor_banned` SSE event, the bridge:

1. Adds the sub-actor to an in-memory set.
2. Persists to `bans.json` (cache; daemon is authoritative).
3. Subsequent inbound messages from that Telegram user are silently
   dropped (no chat reply — banned users don't get to know they
   were banned).

On `sub_actor_unbanned`, remove from set and persist.

The bridge's local cache is a performance optimization; if it gets
out of sync the daemon will still reject calls server-side.

## Packaging

Three artifacts:

- **Docker image** `ghcr.io/qwen-code/bridge-telegram:<ver>` — small
  Alpine + Node + bundled JS. Entrypoint runs the bridge.
- **Single binary** via `pkg` or `bun build --compile` for operators
  who don't want Docker.
- **Source package** `packages/bridge-telegram/` — TypeScript,
  builds with esbuild.

## Threat model

| Attacker                                      | Capability                                   | Mitigation                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot token leak (e.g. screenshot)              | Impersonate the bot, see all chats with it   | Operator regenerates the bot token in BotFather (revokes the old one immediately) AND revokes the bridge token. Coupled rotation documented; see D5. |
| Bridge token leak only                        | Mint prompts / votes with arbitrary subActor | Same as bridge-protocol threat model: revoke the bridge token. Audit shows what it did.                                                              |
| Spoofed sub-actor inside the bridge           | Compromised bridge claims `telegram:ceo`     | Inherits bridge-protocol's "bridge can lie" model. Mitigation = revoke + audit forensics.                                                            |
| Telegram MITM                                 | Read bot traffic                             | Telegram Bot API is HTTPS; trusted up to Telegram itself. Operator should treat Telegram as an external trust boundary.                              |
| Operator-side log capture                     | Bot token visible in logs                    | Logger MUST redact `TELEGRAM_BOT_TOKEN`; explicit unit test for log redaction.                                                                       |
| Long-lived persistent chats.json on shared FS | Other users on host read session bindings    | `$QWEN_BRIDGE_STATE_DIR` permissioned 0700; files 0600. Docker volume best-practice documented.                                                      |
| Banned user obtains new Telegram id           | Bypass ban                                   | Out of bridge's control. Operator's recourse: block at the chat level (kick from group) or ban the new id when discovered.                           |

## Decisions

### D1 — Long-polling, not webhooks

**Choice**: Use `getUpdates` long-polling against `api.telegram.org`.

**Alternative considered**: Webhook mode (Telegram POSTs to a public
HTTPS endpoint we host).

**Why**: Long-polling needs no public URL, no TLS cert, no port
forwarding. The self-host story is "run the container, give it a
bot token, done." Webhooks require infrastructure the daemon's
audience explicitly opts out of (Tailscale, CF Tunnel, etc.).
Long-polling's latency cost (≤25s nothing-happening idle) is
acceptable for the daemon's event volumes.

**Cost**: Slightly higher request count from the bridge to Telegram.
Negligible.

### D2 — Numeric Telegram id as sub-actor, not @username

**Choice**: `telegram:<numeric-user-id>` (e.g. `telegram:12345`).

**Alternative considered**: `telegram:@evan` (username).

**Why**: Usernames are mutable and reclaimable. A banned user can
release their username and re-take it. Numeric ids are immutable
per Telegram. Bans must bind to immutable identifiers.

**Cost**: Less readable in audit logs. Mitigation: bridge optionally
records `username` as audit metadata (informative, not authoritative);
operator CLI `qwen rc bridges audit --sub-actor telegram:12345`
shows last-seen username next to the id.

### D3 — Invite deeplink for chat binding, not auto-bind

**Choice**: A chat is bound to a session only after the operator
issues an invite token (`qwen rc bridges invite ...`) and a Telegram
user redeems it via `/start <token>`.

**Alternative considered**: First message to the bot from any chat
auto-binds to a default session.

**Why**: Auto-binding lets anyone who finds the bot username open a
chat and immediately interact. Even with read-only scope this leaks
session presence. Explicit invite preserves the principle that
sub-actor access is operator-granted.

**Cost**: Requires a small extension to `add-bridge-protocol`: a
`POST /rc/bridges/:id/invite` and `POST /rc/bridges/:id/invite/
redeem` route. This is filed as a "bridge-protocol extension"
ticket; the routes are generic enough that Discord and Matrix
bridges will reuse them. Spec text for the routes is captured here
and back-ported when `add-bridge-protocol` archive is opened.

### D4 — Edit message on permission_resolved instead of new message

**Choice**: Use Telegram's `editMessageText` / `editMessageReplyMarkup`
to mutate the original permission-request message after vote.

**Alternative considered**: Post a new "Approved" reply message and
leave the original buttons orphaned.

**Why**: Cleaner chat UX. Orphaned buttons are confusing — a second
voter would tap them and get a "request resolved" error. Editing
makes the chat history self-consistent.

**Cost**: The bridge must remember the Telegram message id for each
`requestId`. Stored in-memory; resolved within a session lifetime.
On bridge restart, in-flight requests lose their button state and
display "Request expired" if voted on. Acceptable.

### D5 — Bot token rotation = bridge token rotation (coupled)

**Choice**: Document that rotating the Telegram bot token also
requires rotating the bridge's daemon token. The bridge process
treats them as one credential pair.

**Alternative considered**: Treat them as independent — bot token
leak only requires bot rotation.

**Why**: A bot token leak gives an attacker the ability to operate
the bot, which is the bridge's whole interface to its sub-actors.
Even though the daemon token isn't directly leaked, the attacker
can drive the bridge from outside (read messages from the chats
the bot is in, impersonate the bot to users). Treating the two as
coupled forces the safer rotation workflow.

**Cost**: Slightly more friction in rotation. The CLI helper
`qwen rc bridges rotate --kind telegram` will eventually script
this; not in this change's scope.

### D6 — Flush buffered session_update on idle or boundary

**Choice**: Buffer streaming `session_update` chunks; flush on
paragraph/codefence boundary or 1500 ms idle.

**Alternative considered**: One Telegram message per SSE chunk.

**Why**: Per-chunk messages flood the chat and trip Telegram's
per-chat rate limit (1 msg/s). Boundary-aware buffering gives the
team a readable transcript without driving the bot through its
quota.

**Cost**: The chat is slightly behind the workstation by up to
1.5s. Acceptable for collaborative read-along; the web UI remains
the place for byte-accurate streaming.

## Risks / Trade-offs

| Risk                                      | Likelihood | Impact | Mitigation                                                                                                |
| ----------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------- |
| MarkdownV2 escape miss → broken rendering | M          | L      | Property-based test on escape function with random unicode + the documented escape set.                   |
| Long-poll stall after network blip        | M          | M      | Restart poll loop with backoff on any error; log every reconnection; expose `/healthz` for orchestrators. |
| chats.json corruption                     | L          | M      | Atomic-rename writes; on parse failure, archive the corrupt file and start empty (log loud warning).      |
| Buffered chunks lost on crash mid-stream  | L          | L      | Daemon WAL is the source of truth; bridge replays from `Last-Event-ID` after restart.                     |
| Telegram global outage                    | L          | L      | Daemon and other bridges unaffected; chat catches up when Telegram returns.                               |

## Open questions

1. **Should `/start` deeplink invites be one-shot or expire after a
   window?** Currently one-shot (single redeem). Multi-redeem could
   support group chats where any member can "claim" the chat. Defer
   until requested.

2. **Per-chat sub-actor mapping for group chats.** Today, in a group
   chat the bridge attributes each message to the actual sender's
   `telegram:<id>`. Approval votes likewise. This is correct but
   means the operator may see audit entries from arbitrary group
   members. Acceptable; surface this in docs.

3. **Should the bridge respect Telegram's `parse_mode: HTML`
   instead of MarkdownV2?** HTML is easier to escape safely. Open
   for revisit after the first real-world Markdown bug.

4. **Should the bridge expose `/healthz` and `/metrics`?** Yes for
   `/healthz`, deferred for `/metrics` (no Prometheus dep in v1).
