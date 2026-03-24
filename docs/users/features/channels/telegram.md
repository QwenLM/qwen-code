# Telegram

This guide covers setting up a Qwen Code channel on Telegram.

## Prerequisites

- A Telegram account
- A Telegram bot token (see below)

## Creating a Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to choose a name and username
3. BotFather will give you a bot token — save it securely

## Finding Your User ID

To use `senderPolicy: "allowlist"`, you need your Telegram user ID (a numeric ID, not your username).

The easiest way to find it:

1. Search for [@userinfobot](https://t.me/userinfobot) on Telegram
2. Send it any message — it will reply with your user ID

## Configuration

Add the channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-telegram": {
      "type": "telegram",
      "token": "$TELEGRAM_BOT_TOKEN",
      "senderPolicy": "allowlist",
      "allowedUsers": ["YOUR_USER_ID"],
      "sessionScope": "user",
      "cwd": "/path/to/your/project",
      "instructions": "You are a concise coding assistant responding via Telegram. Keep responses short."
    }
  }
}
```

Set the bot token as an environment variable:

```bash
export TELEGRAM_BOT_TOKEN=<your-token-from-botfather>
```

Or add it to a `.env` file that gets sourced before running.

## Running

```bash
qwen channel start my-telegram
```

Then open your bot in Telegram and send a message. You should see "Working..." appear immediately, followed by the agent's response.

## Tips

- **Keep instructions concise-focused** — Telegram has a 4096-character message limit. Adding instructions like "keep responses short" helps the agent stay within bounds.
- **Use `sessionScope: "user"`** — This gives each user their own conversation. Use `/reset` to start fresh.
- **Restrict access** — Use `senderPolicy: "allowlist"` with your user ID to prevent unauthorized access. The bot silently ignores messages from users not on the list.

## Message Formatting

The agent's markdown responses are automatically converted to Telegram-compatible HTML. Code blocks, bold, italic, links, and lists are all supported.

## Troubleshooting

### Bot doesn't respond

- Check that the bot token is correct and the environment variable is set
- Verify your user ID is in `allowedUsers` if using `senderPolicy: "allowlist"`
- Check the terminal output for errors

### "Sorry, something went wrong processing your message"

This usually means the agent encountered an error. Check the terminal output for details.

### Bot takes a long time to respond

The agent may be running multiple tool calls (reading files, searching, etc.). The "Working..." indicator shows while the agent is processing. Complex tasks can take a minute or more.
