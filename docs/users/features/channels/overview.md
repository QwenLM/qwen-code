# Channels

Channels let you interact with a Qwen Code agent from messaging platforms like Telegram, instead of the terminal. You send messages from your phone or desktop chat app, and the agent responds just like it would in the CLI.

## How It Works

When you run `qwen channel start <name>`, Qwen Code:

1. Reads the channel configuration from your `settings.json`
2. Spawns an agent process using the [Agent Client Protocol (ACP)](../../developers/architecture)
3. Connects to the messaging platform (e.g., Telegram) and starts listening for messages
4. Routes incoming messages to the agent and sends responses back to the chat

Each channel runs as a long-lived process that bridges a messaging platform to a Qwen Code agent.

## Quick Start

1. Set up a bot on your messaging platform (see the channel-specific guide, e.g., [Telegram](./telegram))
2. Add the channel configuration to `~/.qwen/settings.json`
3. Run `qwen channel start <name>`

## Configuration

Channels are configured under the `channels` key in `settings.json`. Each channel has a name and a set of options:

```json
{
  "channels": {
    "my-channel": {
      "type": "telegram",
      "token": "$MY_BOT_TOKEN",
      "senderPolicy": "allowlist",
      "allowedUsers": ["123456789"],
      "sessionScope": "user",
      "cwd": "/path/to/working/directory",
      "instructions": "Optional system instructions for the agent.",
      "groupPolicy": "disabled",
      "groups": {
        "*": { "requireMention": true }
      }
    }
  }
}
```

### Options

| Option         | Required | Description                                                                                        |
| -------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `type`         | Yes      | Channel type: `telegram` (more coming soon)                                                        |
| `token`        | Yes      | Bot token. Supports `$ENV_VAR` syntax to read from environment variables                           |
| `senderPolicy` | No       | Who can talk to the bot: `allowlist` (default), `open`, or `pairing`                               |
| `allowedUsers` | No       | List of user IDs allowed to use the bot (used by `allowlist` and `pairing` policies)               |
| `sessionScope` | No       | How sessions are scoped: `user` (default), `thread`, or `single`                                   |
| `cwd`          | No       | Working directory for the agent. Defaults to the current directory                                 |
| `instructions` | No       | Custom instructions prepended to the first message of each session                                 |
| `groupPolicy`  | No       | Group chat access: `disabled` (default), `allowlist`, or `open`. See [Group Chats](#group-chats)   |
| `groups`       | No       | Per-group settings. Keys are group chat IDs or `"*"` for defaults. See [Group Chats](#group-chats) |

### Sender Policy

Controls who can interact with the bot:

- **`allowlist`** (default) — Only users listed in `allowedUsers` can send messages. Others are silently ignored.
- **`pairing`** — Unknown senders receive a pairing code. The bot operator approves them via CLI, and they're added to a persistent allowlist. Users in `allowedUsers` skip pairing entirely. See [DM Pairing](#dm-pairing) below.
- **`open`** — Anyone can send messages. Use with caution.

### Session Scope

Controls how conversation sessions are managed:

- **`user`** (default) — One session per user. All messages from the same user share a conversation.
- **`thread`** — One session per thread/topic. Useful for group chats with threads.
- **`single`** — One shared session for all users. Everyone shares the same conversation.

### Token Security

Bot tokens should not be stored directly in `settings.json`. Instead, use environment variable references:

```json
{
  "token": "$TELEGRAM_BOT_TOKEN"
}
```

Set the actual token in your shell environment or in a `.env` file that gets loaded before running the channel.

## DM Pairing

When `senderPolicy` is set to `"pairing"`, unknown senders go through an approval flow:

1. An unknown user sends a message to the bot
2. The bot replies with an 8-character pairing code (e.g., `VEQDDWXJ`)
3. The user shares the code with you (the bot operator)
4. You approve them via CLI:

```bash
qwen channel pairing approve my-channel VEQDDWXJ
```

Once approved, the user's ID is saved to `~/.qwen/channels/<name>-allowlist.json` and all future messages go through normally.

### Pairing CLI Commands

```bash
# List pending pairing requests
qwen channel pairing list my-channel

# Approve a request by code
qwen channel pairing approve my-channel <CODE>
```

### Pairing Rules

- Codes are 8 characters, uppercase, using an unambiguous alphabet (no `0`/`O`/`1`/`I`)
- Codes expire after 1 hour
- Maximum 3 pending requests per channel at a time — additional requests are ignored until one expires or is approved
- Users listed in `allowedUsers` in `settings.json` always skip pairing
- Approved users are stored in `~/.qwen/channels/<name>-allowlist.json` — treat this file as sensitive

## Group Chats

By default, the bot only works in direct messages. To enable group chat support, set `groupPolicy` to `"allowlist"` or `"open"`.

### Group Policy

Controls whether the bot participates in group chats at all:

- **`disabled`** (default) — The bot ignores all group messages. Safest option.
- **`allowlist`** — The bot only responds in groups explicitly listed in `groups` by chat ID. The `"*"` key provides default settings but does **not** act as a wildcard allow.
- **`open`** — The bot responds in all groups it's added to. Use with caution.

### Mention Gating

In groups, the bot requires an `@mention` or a reply to one of its messages by default. This prevents the bot from responding to every message in a group chat.

Configure per-group with the `groups` setting:

```json
{
  "groups": {
    "*": { "requireMention": true },
    "-100123456": { "requireMention": false }
  }
}
```

- **`"*"`** — Default settings for all groups. Only sets config defaults, not an allowlist entry.
- **Group chat ID** — Override settings for a specific group. Overrides `"*"` defaults.
- **`requireMention`** (default: `true`) — When `true`, the bot only responds to messages that @mention it or reply to one of its messages. When `false`, the bot responds to all messages (useful for dedicated task groups).

### How group messages are evaluated

```
1. groupPolicy — is this group allowed?           (no → ignore)
2. requireMention — was the bot mentioned/replied to? (no → ignore)
3. senderPolicy — is this sender approved?         (no → pairing flow)
4. Route to session
```

### Telegram Setup for Groups

1. Add the bot to a group
2. **Disable privacy mode** in BotFather (`/mybots` → Bot Settings → Group Privacy → Turn Off) — otherwise the bot won't see non-command messages
3. **Remove and re-add the bot** to the group after changing privacy mode (Telegram caches this setting)

### Finding a Group Chat ID

To find a group's chat ID for the `groups` allowlist:

1. Stop the bot if it's running
2. Send a message mentioning the bot in the group
3. Use the Telegram Bot API to check queued updates:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | python3 -m json.tool
```

Look for `message.chat.id` in the response — group IDs are negative numbers (e.g., `-5170296765`).

## Slash Commands

Channels support slash commands. Some are handled locally by the adapter:

- `/start` — Welcome message
- `/help` — List available commands
- `/reset` — Reset your session and start fresh

All other slash commands (e.g., `/compress`, `/summary`) are forwarded to the agent.

## Running

```bash
qwen channel start my-channel
```

The bot runs in the foreground. Press `Ctrl+C` to stop.
