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
      "instructions": "Optional system instructions for the agent."
    }
  }
}
```

### Options

| Option         | Required | Description                                                                  |
| -------------- | -------- | ---------------------------------------------------------------------------- |
| `type`         | Yes      | Channel type: `telegram` (more coming soon)                                  |
| `token`        | Yes      | Bot token. Supports `$ENV_VAR` syntax to read from environment variables     |
| `senderPolicy` | No       | Who can talk to the bot: `allowlist` (default), `open`, or `pairing`         |
| `allowedUsers` | No       | List of user IDs allowed to use the bot (when `senderPolicy` is `allowlist`) |
| `sessionScope` | No       | How sessions are scoped: `user` (default), `thread`, or `single`             |
| `cwd`          | No       | Working directory for the agent. Defaults to the current directory           |
| `instructions` | No       | Custom instructions prepended to the first message of each session           |

### Sender Policy

Controls who can interact with the bot:

- **`allowlist`** (default) — Only users listed in `allowedUsers` can send messages. Others are silently ignored.
- **`open`** — Anyone can send messages. Use with caution.
- **`pairing`** — (Coming soon) New users go through a pairing flow before they can chat.

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
