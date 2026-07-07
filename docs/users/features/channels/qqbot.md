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
      "senderPolicy": "open",
      "sessionScope": "user",
      "cwd": "/path/to/your/project",
      "instructions": "你是一个通过 QQ Bot 对话的 AI 助手。回复控制在 2000 字符以内。",
      "blockStreaming": "on",
      "groupPolicy": "disabled",
      "groups": {
        "*": { "requireMention": true }
      }
    }
  }
}
```

### QQ-Specific Options

| Option      | Default | Description                                                                       |
| ----------- | ------- | --------------------------------------------------------------------------------- |
| `appID`     | —       | QQ Bot AppID from developer portal. If omitted, QR code login is used.            |
| `appSecret` | —       | QQ Bot AppSecret. Supports `$ENV_VAR` syntax. If omitted, QR code login is used.  |
| `sandbox`   | `false` | Set to `true` to use the QQ sandbox API environment (`sandbox.api.sgroup.qq.com`) |

All standard channel options (see [Channel Overview](./overview#options)) are also supported:
`senderPolicy`, `allowedUsers`, `sessionScope`, `cwd`, `instructions`, `groupPolicy`, `groups`, `dispatchMode`, `blockStreaming`, `blockStreamingChunk`, `blockStreamingCoalesce`.

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

1. Set `groupPolicy` to `"allowlist"` or `"open"` in your channel config
2. Add the bot to a QQ group via the QQ Bot Open Platform dashboard or by having a group admin invite it
3. Group members must **@mention** the bot to trigger a response

QQ Bot API V2 only delivers group messages that @mention the bot — the bot does not see all group messages. By default, `requireMention` is `true` and should be left that way for QQ.

See [Group Chats](./overview#group-chats) for full details on group policies and mention gating.

## Markdown Support

The QQ Bot channel supports Markdown formatting (`msg_type=2`). The agent's Markdown responses are sent as-is, and QQ renders them with rich formatting (bold, italic, code blocks, links, lists).

If the QQ server rejects a Markdown message for any reason, the channel automatically retries it as plain text — so your messages always go through even if the bot's Markdown capability is restricted server-side.

This is the opposite of the WeChat channel, which strips all Markdown. You can let the agent use full Markdown with the QQ channel.

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
- **Restrict access** — Use `senderPolicy: "allowlist"` for a fixed set of QQ users, or `"pairing"` to approve new users from the CLI. See [DM Pairing](./overview#dm-pairing) for details.

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
- If using `senderPolicy: "allowlist"`, make sure your QQ user ID is in `allowedUsers`
- On first start, a QR code will appear in the terminal — scan it with your QQ app

### Bot doesn't respond in groups

- Check that `groupPolicy` is set to `"allowlist"` or `"open"` (default is `"disabled"`)
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
