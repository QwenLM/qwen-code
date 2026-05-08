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

To use `senderPolicy: "allowlist"` or `"pairing"`, you need your Telegram user ID (a numeric ID, not your username).

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
      "instructions": "You are a concise coding assistant responding via Telegram. Keep responses short.",
      "businessAutomation": {
        "enabled": false,
        "markRead": false
      },
      "groupPolicy": "disabled",
      "groups": {
        "*": { "requireMention": true }
      }
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
# Start only the Telegram channel
qwen channel start my-telegram

# Or start all configured channels together
qwen channel start
```

Then open your bot in Telegram and send a message. You should see "Working..." appear immediately, followed by the agent's response.

## Chat Automation

Telegram Chat Automation lets a user connect a bot to their profile and allow
it to answer selected private chats on the user's behalf. In Qwen Code this is
available through Telegram Business Bot updates.

### Requirements

1. In BotFather, enable Business Mode for the bot.
2. In Telegram, connect the bot from **Settings > Chat Automation**.
3. Choose which chats the bot can access in the Telegram client.
4. Enable the Qwen Code channel setting:

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
      "businessAutomation": {
        "enabled": true,
        "markRead": false
      }
    }
  }
}
```

When `businessAutomation.enabled` is true, Qwen Code listens for Telegram
`business_connection` and `business_message` updates. Replies to business
messages are sent with Telegram's `business_connection_id`, so they appear from
the connected user account rather than from the bot.

With `senderPolicy: "allowlist"`, put the connected profile owner's Telegram
user ID in `allowedUsers`. Telegram still decides which external chats are
forwarded to the bot based on the user's Chat Automation settings.

`markRead` defaults to false. When set to true, Qwen Code marks incoming
business messages as read only if Telegram granted the bot the
`can_read_messages` business right.

Business connection metadata is stored in
`~/.qwen/channels/<channel-name>-business-connections.json`. Treat this file as
sensitive because connection IDs are used by Telegram to send replies on behalf
of connected accounts.

Qwen Code does not configure Telegram's chat filters. The user chooses those
filters in the Telegram app, and Telegram only sends allowed messages to the
bot.

## Group Chats

To use the bot in Telegram groups:

1. Set `groupPolicy` to `"allowlist"` or `"open"` in your channel config
2. **Disable privacy mode** in BotFather: `/mybots` → select your bot → Bot Settings → Group Privacy → Turn Off
3. Add the bot to a group. If it was already in the group, **remove and re-add it** (Telegram caches privacy settings from when the bot joined)
4. If using `groupPolicy: "allowlist"`, add the group's chat ID to `groups` in your config

By default, the bot requires an @mention or a reply to respond in groups. Set `"requireMention": false` for a specific group to make it respond to all messages (useful for dedicated task groups). See [Group Chats](./overview#group-chats) for full details.

## Images and Files

You can send photos and documents to the bot, not just text.

**Photos:** Send a photo and the agent will analyze it using its vision capabilities. This requires a multimodal model — add `"model": "qwen3.5-plus"` (or another vision-capable model) to your channel config. Photo captions are passed as the message text.

**Documents:** Send a PDF, code file, or any document. The bot downloads it and saves it locally so the agent can read it with its file tools. This works with any model. Telegram's file size limit is 20MB.

## Tips

- **Keep instructions concise-focused** — Telegram has a 4096-character message limit. Adding instructions like "keep responses short" helps the agent stay within bounds.
- **Use `sessionScope: "user"`** — This gives each user their own conversation. Use `/clear` to start fresh.
- **Restrict access** — Use `senderPolicy: "allowlist"` for a fixed set of users, or `"pairing"` to let new users request access with a code you approve via CLI. See [DM Pairing](./overview#dm-pairing) for details.

## Message Formatting

The agent's markdown responses are automatically converted to Telegram-compatible HTML. Code blocks, bold, italic, links, and lists are all supported.

## Troubleshooting

### Bot doesn't respond

- Check that the bot token is correct and the environment variable is set
- Verify your user ID is in `allowedUsers` if using `senderPolicy: "allowlist"`, or that you've been approved if using `"pairing"`
- Check the terminal output for errors

### Bot doesn't respond in groups

- Check that `groupPolicy` is set to `"allowlist"` or `"open"` (default is `"disabled"`)
- If using `"allowlist"`, verify the group's chat ID is in the `groups` config
- Make sure **Group Privacy is turned off** in BotFather — without this, the bot can't see non-command messages in groups
- If you changed privacy mode after adding the bot to a group, **remove and re-add the bot** to the group
- By default, the bot requires an @mention or a reply. Send `@yourbotname hello` to test

### "Sorry, something went wrong processing your message"

This usually means the agent encountered an error. Check the terminal output for details.

### Bot takes a long time to respond

The agent may be running multiple tool calls (reading files, searching, etc.). The "Working..." indicator shows while the agent is processing. Complex tasks can take a minute or more.
