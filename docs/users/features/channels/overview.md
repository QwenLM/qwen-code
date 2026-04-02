# Channels

Channels let you interact with a Qwen Code agent from messaging platforms like Telegram, WeChat, or DingTalk, instead of the terminal. You send messages from your phone or desktop chat app, and the agent responds just like it would in the CLI.

## How It Works

When you run `qwen channel start`, Qwen Code:

1. Reads channel configurations from your `settings.json`
2. Spawns a single agent process using the [Agent Client Protocol (ACP)](../../developers/architecture)
3. Connects to each messaging platform and starts listening for messages
4. Routes incoming messages to the agent and sends responses back to the correct chat

All channels share one agent process with isolated sessions per user. Each channel can have its own working directory, model, and instructions.

## Quick Start

1. Set up a bot on your messaging platform (see channel-specific guides: [Telegram](./telegram), [WeChat](./weixin), [DingTalk](./dingtalk))
2. Add the channel configuration to `~/.qwen/settings.json`
3. Run `qwen channel start` to start all channels, or `qwen channel start <name>` for a single channel

Want to connect a platform that isn't built in? See [Plugins](./plugins) to add a custom adapter as an extension.

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

| Option                   | Required | Description                                                                                                                                    |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                   | Yes      | Channel type: `telegram`, `weixin`, `dingtalk`, or a custom type from an extension (see [Plugins](./plugins))                                  |
| `token`                  | Telegram | Bot token. Supports `$ENV_VAR` syntax to read from environment variables. Not needed for WeChat or DingTalk                                    |
| `clientId`               | DingTalk | DingTalk AppKey. Supports `$ENV_VAR` syntax                                                                                                    |
| `clientSecret`           | DingTalk | DingTalk AppSecret. Supports `$ENV_VAR` syntax                                                                                                 |
| `model`                  | No       | Model to use for this channel (e.g., `qwen3.5-plus`). Overrides the default model. Useful for multimodal models that support image input       |
| `senderPolicy`           | No       | Who can talk to the bot: `allowlist` (default), `open`, or `pairing`                                                                           |
| `allowedUsers`           | No       | List of user IDs allowed to use the bot (used by `allowlist` and `pairing` policies)                                                           |
| `sessionScope`           | No       | How sessions are scoped: `user` (default), `thread`, or `single`                                                                               |
| `cwd`                    | No       | Working directory for the agent. Defaults to the current directory                                                                             |
| `instructions`           | No       | Custom instructions prepended to the first message of each session                                                                             |
| `groupPolicy`            | No       | Group chat access: `disabled` (default), `allowlist`, or `open`. See [Group Chats](#group-chats)                                               |
| `groups`                 | No       | Per-group settings. Keys are group chat IDs or `"*"` for defaults. See [Group Chats](#group-chats)                                             |
| `dispatchMode`           | No       | What happens when you send a message while the bot is busy: `steer` (default), `collect`, or `followup`. See [Dispatch Modes](#dispatch-modes) |
| `blockStreaming`         | No       | Progressive response delivery: `on` or `off` (default). See [Block Streaming](#block-streaming)                                                |
| `blockStreamingChunk`    | No       | Chunk size bounds: `{ "minChars": 400, "maxChars": 1000 }`. See [Block Streaming](#block-streaming)                                            |
| `blockStreamingCoalesce` | No       | Idle flush: `{ "idleMs": 1500 }`. See [Block Streaming](#block-streaming)                                                                      |

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

## Media Support

Channels support sending images and files to the agent, not just text.

### Images

Send a photo to the bot and the agent will see it — useful for sharing screenshots, error messages, or diagrams. The image is sent directly to the model as a vision input.

To use image support, configure a multimodal model for the channel:

```json
{
  "channels": {
    "my-channel": {
      "type": "telegram",
      "model": "qwen3.5-plus",
      ...
    }
  }
}
```

### Files

Send a document (PDF, code file, text file, etc.) to the bot. The file is downloaded and saved to a temporary directory, and the agent is told the file path so it can read the contents using its file-reading tools.

Files work with any model — no multimodal support required.

### Platform differences

| Feature  | Telegram                                     | WeChat                           | DingTalk                                      |
| -------- | -------------------------------------------- | -------------------------------- | --------------------------------------------- |
| Images   | Direct download via Bot API                  | CDN download with AES decryption | downloadCode API (two-step)                   |
| Files    | Direct download via Bot API (20MB limit)     | CDN download with AES decryption | downloadCode API (two-step)                   |
| Captions | Photo/file captions included as message text | Not applicable                   | Rich text: mixed text + images in one message |

## Dispatch Modes

Controls what happens when you send a new message while the bot is still processing a previous one.

- **`steer`** (default) — The bot cancels the current request and starts working on your new message. Best for normal chat, where a follow-up usually means you want to correct or redirect the bot.
- **`collect`** — Your new messages are buffered. When the current request finishes, all buffered messages are combined into a single follow-up prompt. Good for async workflows where you want to queue up thoughts.
- **`followup`** — Each message is queued and processed as its own separate turn, in order. Useful for batch workflows where each message is independent.

```json
{
  "channels": {
    "my-channel": {
      "type": "telegram",
      "dispatchMode": "steer",
      ...
    }
  }
}
```

You can also set dispatch mode per group, overriding the channel default:

```json
{
  "groups": {
    "*": { "requireMention": true, "dispatchMode": "steer" },
    "-100123456": { "dispatchMode": "collect" }
  }
}
```

## Block Streaming

By default, the agent works for a while and then sends one large response. With block streaming enabled, the response arrives as multiple shorter messages while the agent is still working — similar to how ChatGPT or Claude show progressive output.

```json
{
  "channels": {
    "my-channel": {
      "type": "telegram",
      "blockStreaming": "on",
      "blockStreamingChunk": { "minChars": 400, "maxChars": 1000 },
      "blockStreamingCoalesce": { "idleMs": 1500 },
      ...
    }
  }
}
```

### How it works

- The agent's response is split into blocks at paragraph boundaries and sent as separate messages
- `minChars` (default 400) — don't send a block until it's at least this long, to avoid spamming tiny messages
- `maxChars` (default 1000) — if a block gets this long without a natural break, send it anyway
- `idleMs` (default 1500) — if the agent pauses (e.g., running a tool), send what's buffered so far
- When the agent finishes, any remaining text is sent immediately

Only `blockStreaming` is required. The chunk and coalesce settings are optional and have sensible defaults.

## Slash Commands

Channels support slash commands. These are handled locally (no agent round-trip):

- `/help` — List available commands
- `/clear` — Clear your session and start fresh (aliases: `/reset`, `/new`)
- `/status` — Show session info and access policy

All other slash commands (e.g., `/compress`, `/summary`) are forwarded to the agent.

These commands work on all channel types (Telegram, WeChat, DingTalk).

## Running

```bash
# Start all configured channels (shared agent process)
qwen channel start

# Start a single channel
qwen channel start my-channel

# Check if the service is running
qwen channel status

# Stop the running service
qwen channel stop
```

The bot runs in the foreground. Press `Ctrl+C` to stop, or use `qwen channel stop` from another terminal.

### Multi-Channel Mode

When you run `qwen channel start` without a name, all channels defined in `settings.json` start together sharing a single agent process. Each channel maintains its own sessions — a Telegram user and a WeChat user get separate conversations, even though they share the same agent.

Each channel uses its own `cwd` from its config, so different channels can work on different projects simultaneously.

### Service Management

The channel service uses a PID file (`~/.qwen/channels/service.pid`) to track the running instance:

- **Duplicate prevention**: Running `qwen channel start` while a service is already running will show an error instead of starting a second instance
- **`qwen channel stop`**: Gracefully stops the running service from another terminal
- **`qwen channel status`**: Shows whether the service is running, its uptime, and session counts per channel

### Crash Recovery

If the agent process crashes unexpectedly, the channel service automatically restarts it and attempts to restore all active sessions. Users can continue their conversations without starting over.

- Sessions are persisted to `~/.qwen/channels/sessions.json` while the service is running
- On crash: the agent restarts within 3 seconds and reloads saved sessions
- After 3 consecutive crashes, the service exits with an error
- On clean shutdown (Ctrl+C or `qwen channel stop`): session data is cleared — the next start is always fresh
