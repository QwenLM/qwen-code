# QQ Bot (QQ机器人)

This guide covers setting up a Qwen Code channel on QQ via the official QQ Bot Open Platform API.

## Prerequisites

- A QQ account (mobile app for scanning the QR code)

## Setup

### QR Code Login

Start the channel — the first time it will show a QR code. Scan it with your QQ app to activate. No developer account or manual registration needed. Credentials are saved and reused automatically.

```json
{
  "channels": {
    "my-qq": {
      "type": "qq"
    }
  }
}
```

```bash
qwen channel start my-qq
# Scan the QR code in the terminal with your QQ app
```

### Manual Configuration (Developer Portal)

You can also use credentials from the [QQ Bot Open Platform](https://q.qq.com/) developer portal if you already have an app registered there:

```json
{
  "channels": {
    "my-qq": {
      "type": "qq",
      "appID": "YOUR_APP_ID",
      "appSecret": "$QQ_APP_SECRET"
    }
  }
}
```

Set the secret as an environment variable:

```bash
export QQ_APP_SECRET=<your-app-secret>
```

## Configuration

```json
{
  "channels": {
    "my-qq": {
      "type": "qq",
      "appID": "YOUR_APP_ID",
      "appSecret": "$QQ_APP_SECRET",
      "sandbox": false,
      "privatePolicy": "open",
      "sessionScope": "thread",
      "cwd": "/path/to/your/project",
      "instructions": "你是一个通过 QQ Bot 对话的 AI 助手。回复控制在 2000 字符以内。",
      "groupPolicy": "disabled",
      "groups": {
        "*": { "requireMention": true }
      }
    }
  }
}
```

> `sessionScope` defaults to `"thread"`. With `groupPolicy: "disabled"` this is a DM-only setup, where both `"thread"` and `"user"` give each direct message its own context. `"thread"` is shown here for consistency with the [Session Isolation](#session-isolation) section below — read that section's upgrade note before changing the scope on an existing channel.

### QQ-Specific Options

| Option                | Default | Description                                                                       |
| --------------------- | ------- | --------------------------------------------------------------------------------- |
| `appID`               | —       | QQ Bot AppID from developer portal. If omitted, QR code login is used.            |
| `appSecret`           | —       | QQ Bot AppSecret. Supports `$ENV_VAR` syntax. If omitted, QR code login is used.  |
| `sandbox`             | `false` | Set to `true` to use the QQ sandbox API environment (`sandbox.api.sgroup.qq.com`) |
| `purgeLegacySessions` | `false` | Delete legacy single-scope and user-scope session routes — see below.             |

All standard channel options (see [Channel Overview](./overview#options)) are also supported:
`privatePolicy`, `allowedUsers`, `sessionScope`, `cwd`, `instructions`, `groupPolicy`, `groups`, `dispatchMode`.

## Running

```bash
# Start only the QQ channel
qwen channel start my-qq

# Or start all configured channels together
qwen channel start
```

Open QQ and send a message to your bot. You should see the response arrive in your chat.

## Group Chats

To use the bot in QQ groups:

1. Set `groupPolicy` to `"allowlist"`, `"pairing"`, or `"open"` in your channel config
2. Add the bot to a QQ group via the QQ Bot Open Platform dashboard or by having a group admin invite it
3. Group members must **@mention** the bot to trigger a response
4. If using `groupPolicy: "pairing"`, approve the group's pairing request once before responses start. Note that once a group is approved, **any member of that group** can use the bot by default (restrict with the group's `senders: "allowlist"` and `allowedUsers`); `privatePolicy` and the top-level `allowedUsers` do not gate members of an approved group.

QQ Bot API V2 only delivers group messages that @mention the bot — the bot does not see all group messages. By default, `requireMention` is `true` and should be left that way for QQ.

### Session Isolation

The QQ channel defaults to `sessionScope: "thread"`: members of the same group share a single conversation context keyed by `<channel>:<group_openid>`, while different groups are isolated from each other. Each direct message gets its own context keyed by `<channel>:<user_openid>`.

A group thread session is a **shared session**: every member of the group reads and continues the same conversation history. Commands that operate on that session (`/clear`, `/cancel`, `/who`, `/status`, `/loop`, `/btw`), permission answers (`/approve`, `/approve-always`, `/deny`), and steering an in-flight turn (a member's plain message queues behind the running turn instead of steering it) are restricted to the members listed in the channel's `operators`; `allowedUsers` and `senderPolicy` do **not** grant them. `operators` is unset by default, so out of the box a shared group session has **no** member authorized to run those commands — and a permission request raised in a group has no one who can answer it. Set `operators` to the QQ ids of the members who should be able to steer the group's session. For a group message the gate compares against that member's `member_openid` — the same id space as the group-scoped `allowedUsers` above — not the direct-message `user_openid`; a list filled with `user_openid`s matches nobody, and because the list is non-empty the startup warning stays silent, so every command above is simply refused. A `single`- or `chat_thread`-scope channel is affected the same way, because those scopes share direct-message sessions too. The `!` host-shell prefix is disabled in every QQ group chat, regardless of scope; in a direct message the same scope rule decides it — `!` runs only where the scope keeps the session private to one sender (`"thread"` or `"user"`), and is refused for a DM too under `"single"` or `"chat_thread"` and for every group message. If group members should not share history or control each other's turns, set `sessionScope: "user"` (each member gets a private session — see the upgrade note below before switching an existing channel), or restrict who can talk to the bot with the group-scoped `senders` / `allowedUsers` control — for example `groups: {"*": {"senders": "allowlist", "allowedUsers": ["<member_openid>"]}}`. The top-level `senderPolicy`, `allowedUsers` and `privatePolicy` govern direct messages only; they do not gate members of an approved group.

For full-message mode this default is already what you want — with `groupAllPolicy: "all"`, keeping `"thread"` gives you shared context within a group and isolation across groups. If you instead set `sessionScope: "user"`, full-message traffic is fragmented per sender (a separate session for every member), which is not suitable for group full-message scenarios.

The other shared scopes are not equivalents. `sessionScope: "chat_thread"` routes group messages exactly like `"thread"` (QQ supplies no thread id, so both key on `<channel>:<chatId>`), but it is treated as shared for **every** chat: each direct message becomes a shared session subject to the `operators` gate, so `/clear` in a DM is refused and a tool call raised in a DM has no one to answer it. `sessionScope: "single"` also shares direct messages, and additionally keys **every** group and every direct message to the one context `<channel>:__single__`, so group A's history is answered with group B's and with DM history — the cross-group leakage this section is about. The channel warns at startup whenever `groupAllPolicy` is `"keyword"` or `"all"` and the scope is not `"thread"`. With `multiSession` enabled the scope is pinned to `"user"`, so that warning names the two settings as mutually exclusive and tells the operator to change `groupAllPolicy` or turn `multiSession` off, instead of advising `"thread"`.

**Upgrading from an older QQ channel.** The default scope changed from `"user"` to `"thread"`. (A channel configured with `groupAllPolicy: "keyword"` or `"all"` was previously forced to `"single"` — one global session. A channel that did not pin `sessionScope` now resolves to `"thread"` unless `multiSession` is on, which resolves to `"user"` — per-sender sessions are the only shape `multiSession` supports, so it wins over the plugin default; for a channel without `multiSession` the effective change is from that global session to a per-group one. A channel that pinned `sessionScope` explicitly is no longer overridden, so an explicit `"user"` now takes effect and fragments group full-message traffic per sender — change it to `"thread"` by hand.) Legacy session routes are not deleted automatically: while `purgeLegacySessions` is off, each start counts the routes the purge covers — the single-scope-era `<channel>:__single__` key and this channel's legacy user-scope `<channel>:<senderId>:<chatId>` keys — and leaves them, and their daemon-side sessions, untouched. A `chat_thread`-era `<channel>:<chatId>:<threadId>` route is not covered: it is neither counted nor purged. To remove the covered routes, set `purgeLegacySessions` to `true` on the channel. With it enabled, every such route is released and its daemon-side session discarded, so the old conversation mappings stop existing; the purge runs on each start while the option stays on. Nothing is deleted unless the rescue copy reaches disk: immediately before the first deletion the channel appends the doomed routes to `<channel>-sessions-purged.json` in the channel state directory (for example `~/.qwen/channels/my-qq-sessions-purged.json`; characters outside `A-Za-z0-9_-` in the channel name become `_`) and if that write fails it deletes nothing and leaves the routes in place. The file is written only when a deletion actually happens — never on a start that leaves everything alone. It is a JSON list of purge records, each with its `purgedAt` timestamp, `sessionScope`, and `routes`; each route carries its `kind`, `key`, `sessionId`, `target`, and — when the router's persisted session state still records them — `cwd`, `turns`, `startedAt`, `isolation`, and `workspaceCwd`. Records are appended rather than overwritten, so an earlier purge's record survives a later one (the oldest records are dropped once the list passes 20); a file that cannot be read, or does not hold a purge-record list, is reported in the log and renamed to a sibling `<path>.corrupt-<timestamp>` file before the new record is written, so the damaged copy is kept for hand recovery and the new record is never lost. That is routing metadata only — no conversation content — so it shows you what was dropped and lets you re-create the mapping by hand: a route whose record includes `cwd` and no `isolation` resolves to that same workspace when restored; when the record also carries `isolation: "worktree"`, `cwd` is the (usually already removed) per-session worktree, so restore against the record's `workspaceCwd` and keep `isolation` so the router re-attaches it through the managed load path. When the stored state for a route has no `cwd` (the entry is missing, or predates the field), the record simply omits `cwd` rather than guessing, so restoring such a route by hand also needs the channel's workspace path. Setting `sessionScope: "user"` after a purge does **not** bring the old conversations back by itself — those routes are already gone and are not restored automatically.

See [Group Chats](./overview#group-chats) for full details on group policies and mention gating.

## Markdown Support

The QQ Bot channel supports Markdown formatting (`msg_type=2`). The agent's Markdown responses are sent as-is, and QQ renders them with rich formatting (bold, italic, code blocks, links, lists).

If the QQ server rejects a Markdown message for any reason, the channel automatically retries it as plain text — so your messages always go through even if the bot's Markdown capability is restricted server-side.

This is the opposite of the WeChat channel, which strips all Markdown. You can let the agent use full Markdown with the QQ channel.

## Images and Videos

Users can send images and videos to the bot. An image is passed to the agent as vision input, so the agent sees the picture itself — screenshots, error messages, and diagrams all work — and the same file is also saved to a temporary local path for the case where the model cannot take images. A video is saved to a temporary local path and the agent is told that path.

A media message does not need any text — an image-only or video-only message starts a turn, and the channel uses `(image)` or `(video)` as the placeholder. When the message does carry text, that text is kept as the caption.

- Images are limited to 8 MB and videos to 20 MB, and at most five attachments per message are handled. Anything larger is skipped and logged to the channel's stderr.
- Downloaded files are not deleted. They stay under the system temporary directory, which the system clears on its own schedule.

Image input requires a model that accepts images. Declare the capability when the model is multimodal but not recognised by name. The field belongs on the provider entry that serves the model, because a top-level `model.generationConfig` value is ignored for provider-backed models:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "your-model-id",
        "baseUrl": "https://example.invalid/v1",
        "generationConfig": {
          "modalities": { "image": true }
        }
      }
    ]
  }
}
```

With a text-only model the agent receives an "unsupported image" note plus the saved path instead of the picture.

Sending images or videos back to QQ is not supported.

## Token Management

Access tokens expire after approximately 2 hours. The channel automatically refreshes them at 80% of their TTL (typically ~1.6 hours). If a refresh fails, it retries after 60 seconds.

Token refresh continues across WebSocket reconnects — the channel never goes offline due to an expired token as long as the AppID and AppSecret remain valid.

## Connection Resilience

- **Auto-reconnect:** On WebSocket disconnect, the channel retries with exponential backoff (up to 20 attempts, max 30 seconds between retries)
- **Session resume:** If the WebSocket drops briefly, the channel uses QQ's `RESUME` opcode to restore the session without losing in-flight messages
- **Cross-server context continuation:** Chat sessions and routing state are persisted to disk. If the daemon restarts, conversations continue from where they left off
- **Heartbeat monitoring:** HEARTBEAT_ACK timeouts are detected and force a reconnection to avoid zombie connections
- **Message deduplication:** Replayed messages after a reconnect are detected and skipped

## Tips

- **Use Markdown freely** — Unlike WeChat, QQ renders Markdown natively. Bold, code blocks, lists, and links all work.
- **Keep responses under 2000 characters** — Longer responses are automatically split into chunks. Adding a length hint to your instructions helps the agent stay concise.
- **Sandbox for testing** — Set `"sandbox": true` to use the sandbox API during development. No production messages will be affected.
- **Restrict access** — Use `privatePolicy: "allowlist"` for a fixed set of QQ users, or `"pairing"` to approve new users from the CLI. See [DM Pairing](./overview#dm-pairing) for details.

## Key Differences from Telegram

| Area             | QQ Bot                                      | Telegram                                      |
| ---------------- | ------------------------------------------- | --------------------------------------------- |
| Authentication   | QR code login or AppID/AppSecret            | Static bot token from BotFather               |
| Markdown         | Native QQ Markdown with plaintext fallback  | HTML-formatted from agent Markdown            |
| Token lifecycle  | 2h TTL, auto-refresh at 80%                 | Permanent bot token                           |
| Group messages   | Only @mention messages are delivered to bot | Bot sees all messages (with privacy mode off) |
| Typing indicator | Not available (QQ API limitation)           | "Working..." message                          |
| Sandbox mode     | Supported for testing                       | Not available                                 |

## Troubleshooting

### Bot doesn't respond

- Check the terminal output for errors
- Verify the channel is running (`qwen channel status`)
- If using `privatePolicy: "allowlist"`, make sure your QQ user ID is in `allowedUsers`
- On first start, a QR code will appear in the terminal — scan it with your QQ app

### Bot doesn't respond in groups

- Check that `groupPolicy` is set to `"allowlist"`, `"pairing"`, or `"open"` (default is `"disabled"`)
- If using `"pairing"`, verify the group's pairing request has been approved
- **You must @mention the bot** — QQ only delivers messages that tag the bot
- Verify the bot has been added to the group

### QR code login is stuck

- The QR code is displayed in the terminal. Scan it with your QQ mobile app (Me → Scan)
- If the QR code expires (typically after a few minutes), restart the channel to get a new one

### Markdown messages appear as plain text

- The QQ server may have rejected the Markdown message and the channel silently fell back to plain text. Check the terminal for `"Markdown rejected"` log messages
- This is unusual on the QQ Bot Open Platform but can happen if the bot's Markdown capability is restricted server-side

### Token expired after long downtime

- If the channel is offline for more than 2 hours, the access token will have expired. The channel fetches a fresh token on reconnect — no action needed
- If the AppSecret itself is invalid (e.g., rotated in the developer portal), update the `appSecret` field or delete `~/.qwen/channels/<name>-credentials.json` to re-trigger QR code login
