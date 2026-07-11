# add-telegram-bridge

## Why

`add-bridge-protocol` defined the contract for sidecar bridges; this
change is the **first conformant implementation** of that contract.
Telegram is the right pilot: the Bot API is stable, long-polling
removes the need for a public webhook URL (so a self-hosted daemon
behind Tailscale or a tunnel just works), inline keyboard buttons
map cleanly to `permission_request` Approve/Deny, and a Telegram
chat per session is a natural mental model for a small team.

Beyond shipping the bridge, this change is where the field-tested
patterns for writing a conformant bridge get documented — chat-to-
session mapping persistence, sensitivity-hint rendering, sub-actor
identifier choice (numeric id vs username), and rate-limit
back-pressure to the chat user. The Discord and Matrix bridges build
on these patterns; revisions to them should flow through here when
the pattern itself changes.

## What Changes

- **New sidecar process `qwen-bridge-telegram`.** Standalone Node
  binary (also published as a Docker image). Reads
  `TELEGRAM_BOT_TOKEN`, `QWEN_DAEMON_URL`, `QWEN_BRIDGE_TOKEN` from
  env. Holds no daemon code; speaks only the public HTTP+SSE API.
- **Telegram bot setup procedure documented.** Operator creates a
  bot via BotFather, captures the bot token, runs `qwen rc pair
--scope bridge --name telegram` on the workstation, redeems the
  pairing code in the bridge container, and the bridge auto-
  registers via `POST /rc/bridges`.
- **Chat-to-session binding via `/start <token>`.** The bridge has
  no concept of sessions until a Telegram chat invokes
  `/start <pairing-link>` (deeplinked from a `qwen rc bridges
invite --kind telegram` CLI on the workstation). Mapping persisted
  to a small JSON file `~/.qwen/rc/bridges/telegram/chats.json`.
- **Inline-keyboard rendering for `permission_request`.** Approve /
  Deny buttons; on tap, bridge POSTs `/permission/:requestId` with
  `X-RC-SubActor: telegram:<numeric-user-id>`.
- **Hint-driven render strategy.** `bridgeHints.recommendedSurface
== "deeplink"` → bridge sends `argsSummaryShort` plus a one-button
  "Open in web client" deeplink. `inline` → render `argsSummaryShort`
  with Approve/Deny inline keyboard.
- **Capability declaration on registration:** `supportsActions:
true`, `supportsMarkdown: "limited"` (MarkdownV2 with escape
  table), `maxMessageBytes: 4096`, `supportsThreads: false`,
  `supportsEdits: true`.
- **Rate-limit back-pressure.** When the daemon returns `429`, the
  bridge sends a "slow down, try again in N seconds" reply to the
  originating Telegram chat. When Telegram returns `429`, the bridge
  applies exponential backoff with jitter; daemon SSE consumption
  is NOT blocked by Telegram backpressure (we drop chat sends, not
  daemon events).

## Capabilities

### New Capabilities

- `telegram-bridge` — Telegram-specific behaviour of the sidecar
  process that conforms to `bridge-protocol`: chat-to-session
  binding, MarkdownV2 escaping, inline keyboard mapping for
  permission requests, sub-actor identity format, capability
  declaration, deployment shape.

## User Stories

**T1. Operator pairs the Telegram bridge.** Operator creates a bot
with BotFather, runs `qwen rc pair --scope bridge --name telegram`
which prints a code. Operator runs the bridge Docker container with
`TELEGRAM_BOT_TOKEN`, `QWEN_DAEMON_URL`, and the code. Bridge
redeems, registers, and prints "ready". `qwen rc bridges list`
shows `telegram-bridge online`.

**T2. Team member binds a chat.** Operator runs `qwen rc bridges
invite --kind telegram --session <id>`, which prints a
`t.me/<bot>?start=<binding-token>` URL. Team member clicks it,
Telegram opens the chat, `/start <token>` runs, bridge writes the
mapping and replies "Bound to session <id> as telegram:<your-id>".

**T3. Approve a tool call from phone.** Agent fires
`permission_request` for `edit_file`. Bridge renders short summary
`Edit src/auth/login.ts (+12 -3)` with Approve / Deny buttons. User
taps Approve. Bridge POSTs vote with `X-RC-SubActor: telegram:<id>`.
Web client sees `permission_resolved` originator = telegram-bridge,
subActor = `telegram:<id>`.

**T4. Sensitive call routed to deeplink.** Agent fires permission
request for a `bash` invocation matched by the sensitivity
classifier. `bridgeHints.recommendedSurface: "deeplink"`. Bridge
sends "Sensitive tool call — open web client to review" plus an
inline button linking to `https://<daemon>/ui/permission/<id>`.

**T5. Banned sub-actor.** Operator runs `qwen rc bridges ban
telegram:9999 --on telegram-bridge`. Bridge receives
`sub_actor_banned` event, adds to local filter set, ignores future
messages from that Telegram user without bothering the daemon.

**T6. Token leak / rotation.** Bot token leaks in a screenshot.
Operator regenerates the bot token in BotFather (old token dies),
revokes the bridge token via `qwen rc tokens revoke`, regenerates
both, restarts the container. Bridge re-pairs and re-binds chats.

## Impact

- **New package**: `packages/bridge-telegram/` (Node, TypeScript,
  built to a single bundle via esbuild, also a Docker image).
- **Depends on**: `add-bridge-protocol` (must be merged first).
- **No daemon changes** — this entire change is a sidecar.
- **Docs**: `docs/bridges/telegram.md` covering BotFather setup,
  env config, chat binding, troubleshooting (long-poll vs webhook,
  message-size handling, escape gotchas).
- **CLI helper** (in daemon): `qwen rc bridges invite --kind
telegram --session <id>` to produce the `/start` deeplink.
  Technically a bridge-protocol concern; landed here because
  Telegram is the first consumer.
- **Out of scope:**
  - Webhook (TLS public endpoint) mode. Documented as future; not
    implemented.
  - Inline-query support (`@bot ...`). Buttons + chat messages cover
    the user stories.
  - File uploads (PDFs / images) from Telegram into the session.
    Future.
  - Multi-bot from one bridge process. One bridge process = one bot
    token.
