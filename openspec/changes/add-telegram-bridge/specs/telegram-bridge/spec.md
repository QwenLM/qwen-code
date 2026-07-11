# telegram-bridge — spec delta

## ADDED Requirements

### Requirement: Bridge process configuration

The Telegram bridge SHALL be a standalone process distinct from the
qwen daemon. It SHALL read its configuration exclusively from
environment variables:

- `TELEGRAM_BOT_TOKEN` (required) — bot token from BotFather.
- `QWEN_DAEMON_URL` (required) — base URL of the qwen daemon.
- `QWEN_BRIDGE_TOKEN` OR `QWEN_BRIDGE_PAIRING_CODE` (one required) —
  bridge-scope credentials.
- `QWEN_BRIDGE_STATE_DIR` (optional, default
  `~/.qwen/rc/bridges/telegram`) — persistent storage root.

The bridge SHALL fail-fast at startup with a non-zero exit code and
a specific error message if any required variable is missing.

#### Scenario: Missing bot token aborts startup

- **GIVEN** the bridge is started with `TELEGRAM_BOT_TOKEN` unset
- **WHEN** the process initializes
- **THEN** it exits with code 1
- **AND** stderr contains "TELEGRAM_BOT_TOKEN is required"

#### Scenario: Pairing-code bootstrap persists token

- **GIVEN** `QWEN_BRIDGE_TOKEN` is unset AND `QWEN_BRIDGE_PAIRING_CODE`
  is set to a valid one-time code
- **WHEN** the bridge boots
- **THEN** it redeems the code against the daemon
- **AND** writes the resulting token to `$QWEN_BRIDGE_STATE_DIR/token`
  with file mode `0600`
- **AND** subsequent boots ignore `QWEN_BRIDGE_PAIRING_CODE` if the
  token file exists

### Requirement: Bridge registration declares Telegram capabilities

On startup the bridge SHALL register itself via `POST /rc/bridges`
with the exact capability declaration:

```jsonc
{
  "displayName": "Telegram-bridge",
  "bridgeKind": "telegram",
  "capabilities": {
    "supportsActions": true,
    "supportsMarkdown": "limited",
    "maxMessageBytes": 4096,
    "supportsThreads": false,
    "supportsEdits": true,
  },
}
```

The bridge SHALL heartbeat via `POST /rc/bridges/:id/heartbeat` at
intervals not exceeding `heartbeatIntervalSec` from the registration
response.

#### Scenario: Registration declares Telegram capabilities

- **WHEN** the bridge calls `POST /rc/bridges`
- **THEN** the request body matches the schema above byte-for-byte
  (modulo whitespace)

#### Scenario: Heartbeat keeps bridge listed

- **GIVEN** the bridge has been heartbeating for 10 minutes
- **WHEN** an operator runs `qwen rc bridges list`
- **THEN** the bridge appears with status `online`

### Requirement: Chat-to-session binding via /start

A Telegram chat SHALL NOT be bound to any qwen session by default.
Binding occurs exclusively when:

1. An operator on the workstation runs `qwen rc bridges invite
--kind telegram --session <id>`, producing a one-time invite
   token and a `t.me/<bot>?start=<token>` URL.
2. A Telegram user opens that URL, causing Telegram to send
   `/start <token>` to the bot.
3. The bridge redeems the token against the daemon, and on success
   persists `(chatId, sessionId, primarySubActor)` to its store.

The bridge SHALL persist bindings to
`$QWEN_BRIDGE_STATE_DIR/chats.json` using atomic-replace writes
(write-to-temp + fsync + rename).

#### Scenario: Operator-issued invite binds chat

- **GIVEN** the operator generated an invite token `inv_abc`
- **WHEN** a Telegram user sends `/start inv_abc` to the bot
- **THEN** the bridge calls `POST /rc/bridges/:id/invite/redeem`
  with the token
- **AND** on `200 OK` the bridge persists the binding to chats.json
- **AND** replies to the chat "Bound chat to session `<id>`"

#### Scenario: Unrecognized /start token is rejected

- **WHEN** a Telegram user sends `/start gibberish` to the bot
- **THEN** the bridge replies with the daemon's error text (e.g.
  "Invalid or expired invite token")
- **AND** no entry is added to chats.json

#### Scenario: /detach removes binding

- **GIVEN** a chat is bound to a session
- **WHEN** a user sends `/detach` to the bot in that chat
- **THEN** the chat is removed from chats.json
- **AND** the bridge replies "Unbound. Use a fresh invite to
  re-bind."

### Requirement: Inbound prompt forwarding

For non-command text messages received in a bound chat, the bridge
SHALL:

1. Resolve the sub-actor as `telegram:<sender-numeric-id>` (NOT the
   primary sub-actor; per-sender attribution is required for group
   chats).
2. Drop the message if the sender's sub-actor is in the local ban
   cache.
3. POST `/session/<sessionId>/prompt` with body `{ prompt: <text> }`
   and headers `Authorization: Bearer <bridge-token>` and
   `X-RC-SubActor: <sub-actor>`.
4. On daemon `429`, reply to the chat with "Slow down, try again in
   `<Retry-After>` seconds."
5. On daemon `403 sub_actor_banned`, silently drop and add the
   sub-actor to the local ban cache.

#### Scenario: Inbound prompt forwarded to daemon

- **GIVEN** chat `123` is bound to session `sess_abc`
- **WHEN** Telegram user `12345` sends "fix the build" in chat `123`
- **THEN** the bridge POSTs `/session/sess_abc/prompt` with body
  containing `prompt: "fix the build"`
- **AND** the request carries header `X-RC-SubActor:
telegram:12345`

#### Scenario: Sender-specific sub-actor

- **GIVEN** a group chat `123` is bound to `sess_abc` with
  primarySubActor `telegram:12345`
- **WHEN** a different user `67890` posts a message in the same
  chat
- **THEN** the prompt's `X-RC-SubActor` header is `telegram:67890`,
  NOT `telegram:12345`

#### Scenario: Daemon 429 surfaces to chat user

- **WHEN** the daemon returns `429 Too Many Requests` with
  `Retry-After: 12`
- **THEN** the bridge sends a Telegram reply containing "Slow down"
  and "12"

### Requirement: SSE consumer per bound session

For each binding in chats.json the bridge SHALL maintain a
`GET /session/:id/events` SSE subscription using its bridge token.
On disconnect, the bridge SHALL reconnect with exponential backoff
(initial 1 s, max 30 s, jitter ±20 %) AND replay from the last
persisted event id via `Last-Event-ID`.

The bridge SHALL persist the last successfully processed event id
per session to `$QWEN_BRIDGE_STATE_DIR/cursors.json`.

#### Scenario: Bridge restart resumes without duplicates

- **GIVEN** the bridge processed event id `0x100` for session
  `sess_abc` and crashed
- **WHEN** the bridge restarts
- **THEN** it sends `Last-Event-ID: 0x100` to the daemon
- **AND** does NOT re-send events `≤ 0x100` to the chat

### Requirement: permission_request rendering

The bridge SHALL render `permission_request` SSE frames as a
Telegram message according to `bridgeHints.recommendedSurface`:

- `inline`: the message body contains `bridgeHints.argsSummaryShort`
  AND an inline keyboard with two buttons labelled `Approve` and
  `Deny`, whose `callback_data` is `vote:approve:<requestId>` and
  `vote:deny:<requestId>` respectively.
- `deeplink`: the message body contains
  `bridgeHints.argsSummaryShort` AND an inline keyboard with one
  button labelled `Open in web client` whose `url` is
  `${QWEN_DAEMON_URL}/ui/permission/<requestId>`.

The bridge SHALL NOT render `bridgeHints.argsSummaryFull` in the
`deeplink` surface mode.

#### Scenario: Inline surface renders Approve/Deny

- **GIVEN** a `permission_request` event with
  `bridgeHints.recommendedSurface: "inline"`,
  `argsSummaryShort: "Edit src/auth/login.ts (+12 -3)"`,
  `requestId: "req_xyz"`
- **WHEN** the bridge renders it
- **THEN** a Telegram message is sent containing
  `Edit src/auth/login.ts (+12 -3)`
- **AND** the inline keyboard has buttons `Approve` (callback_data
  `vote:approve:req_xyz`) and `Deny` (callback_data
  `vote:deny:req_xyz`)

#### Scenario: Deeplink surface omits full args

- **GIVEN** a `permission_request` event with
  `bridgeHints.recommendedSurface: "deeplink"` AND `argsSummaryFull`
  containing 800 characters of detail
- **WHEN** the bridge renders it
- **THEN** the Telegram message body length is ≤ length of
  `argsSummaryShort` plus a short prefix
- **AND** the message does NOT contain any substring from
  `argsSummaryFull`

### Requirement: Telegram tap resolves permission

When a Telegram user taps an Approve / Deny button, the bridge
SHALL:

1. Parse `callback_data` as `vote:<approve|deny>:<requestId>`.
2. POST `/permission/<requestId>` with body `{ vote:
"approve" | "deny" }` and `X-RC-SubActor:
telegram:<tapper-numeric-id>`.
3. Answer the Telegram callback query (so the loading spinner
   clears).

On receiving the subsequent `permission_resolved` SSE frame, the
bridge SHALL `editMessageReplyMarkup` to clear the keyboard AND
`editMessageText` to append the outcome
("Resolved: approved by `<subActor>`" or
"Resolved: denied by `<subActor>`").

#### Scenario: Approve tap posts vote with sub-actor

- **GIVEN** a permission-request message is in chat `123`
- **WHEN** user `12345` taps `Approve`
- **THEN** the bridge POSTs `/permission/req_xyz` with body
  containing `vote: "approve"`
- **AND** the request carries `X-RC-SubActor: telegram:12345`

#### Scenario: Message edited on resolve

- **GIVEN** an in-flight permission message with message id `m_42`
- **WHEN** the bridge receives `permission_resolved` for the same
  requestId
- **THEN** the bridge calls Telegram `editMessageText` for `m_42`
- **AND** the new text appends "Resolved:" plus the outcome

### Requirement: Sub-actor is numeric Telegram user id

The bridge SHALL set `X-RC-SubActor: telegram:<numeric-user-id>`
using the value from `update.message.from.id` or
`update.callback_query.from.id`. The bridge SHALL NOT use
`update.message.from.username` as the sub-actor value, even when
present.

#### Scenario: Numeric id used even when username present

- **GIVEN** a Telegram user with `id: 12345, username: "evan"`
- **WHEN** they send any message to the bot
- **THEN** the resulting daemon request carries `X-RC-SubActor:
telegram:12345`
- **AND** does NOT carry `telegram:evan` or `telegram:@evan`

### Requirement: Local ban cache

The bridge SHALL maintain a local cache of banned sub-actors. On
receiving a `sub_actor_banned` SSE event, the bridge SHALL add the
sub-actor to the cache AND persist to `$QWEN_BRIDGE_STATE_DIR/
bans.json`. On `sub_actor_unbanned`, the bridge SHALL remove the
entry.

The cache is a performance optimisation; the daemon remains
authoritative.

#### Scenario: Banned user is silently dropped

- **GIVEN** `telegram:9999` is in the local ban cache
- **WHEN** user `9999` sends a message to a bound chat
- **THEN** the bridge does NOT POST to the daemon
- **AND** the bridge does NOT reply to the chat

### Requirement: Telegram rate-limit handling

When Telegram returns `429` (with `retry_after`) the bridge SHALL
queue the send for retry with exponential backoff (1, 2, 4, 8, 16 s,
jittered ±20 %). After 5 consecutive retries for the same chat the
bridge SHALL drop the send and log an error.

The bridge's SSE consumer SHALL NOT block on Telegram queue
back-pressure. Daemon events continue to flow and accumulate locally
even when Telegram is throttling sends.

#### Scenario: Telegram 429 does not stall SSE

- **GIVEN** Telegram is responding `429` to every send for chat
  `123`
- **WHEN** the daemon emits 10 `session_update` events for the
  bound session
- **THEN** the bridge continues to consume all 10 SSE events
- **AND** persists the cursor up to the most recent event id

### Requirement: MarkdownV2 escaping

Text rendered to Telegram with `parse_mode: MarkdownV2` SHALL escape
the characters `_ * [ ] ( ) ~ \` > # + - = | { } . !` with a
preceding backslash, except inside fenced code blocks and inline
code where Telegram's documented preservation rules apply.

#### Scenario: Period in plain text is escaped

- **WHEN** the bridge sends a message containing "ok."
- **THEN** the wire payload contains `ok\.`

#### Scenario: Code block content is not escaped

- **WHEN** the bridge sends a fenced code block containing
  `const x = 1.0;`
- **THEN** the wire payload preserves `1.0` without backslashes
  inside the fence

### Requirement: Log redaction

The bridge SHALL never write `TELEGRAM_BOT_TOKEN` or any
`qwk_<...>`-prefixed string in plaintext to any log output.

#### Scenario: Token never logged

- **GIVEN** debug logging is enabled
- **WHEN** the bridge logs a redacted snapshot of its config
- **THEN** stdout contains neither the bot token nor any
  `qwk_*` string
- **AND** the bot token is rendered as `***redacted-{last4}***` if
  referenced

### Requirement: Healthz endpoint

The bridge SHALL expose `GET /healthz` on its local HTTP server
(default port 9100) returning HTTP 200 with body
`{ ok: true, daemonReachable: bool, telegramReachable: bool,
registeredId: string|null, uptimeSec: number }`.

#### Scenario: Healthz reports daemon unreachable

- **GIVEN** the daemon URL is unreachable
- **WHEN** `GET /healthz` is called
- **THEN** the response is 200
- **AND** the body has `daemonReachable: false`
