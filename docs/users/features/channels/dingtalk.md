---
description: "Set up a Qwen Code channel on DingTalk. Connect your AI coding agent to 钉钉 for messaging-based code assistance from any device."
---

# DingTalk (Dingtalk)

This guide covers setting up a Qwen Code channel on DingTalk (钉钉).

## Prerequisites

- A DingTalk organization account
- A DingTalk bot application with AppKey and AppSecret (see below)

## Creating a Bot

1. Go to the [DingTalk Developer Portal](https://open-dev.dingtalk.com)
2. Create a new application (or use an existing one)
3. Under the application, enable the **Robot** capability
4. In Robot settings, enable **Stream Mode** (机器人协议 → Stream 模式)
5. Note the **AppKey** (Client ID) and **AppSecret** (Client Secret) from the application credentials page

### Stream Mode

DingTalk Stream mode uses an outbound WebSocket connection — no public URL or server is needed. The bot connects to DingTalk's servers, which push messages through the WebSocket. This is the simplest deployment model.

## Configuration

Add the channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-dingtalk": {
      "type": "dingtalk",
      "clientId": "$DINGTALK_CLIENT_ID",
      "clientSecret": "$DINGTALK_CLIENT_SECRET",
      "useConnectionManager": true,
      "senderPolicy": "open",
      "sessionScope": "user",
      "cwd": "/path/to/your/project",
      "instructions": "You are a concise coding assistant responding via DingTalk.",
      "groupPolicy": "open",
      "atSender": true,
      "groups": {
        "*": { "requireMention": true }
      }
    }
  }
}
```

Set the credentials as environment variables:

```bash
export DINGTALK_CLIENT_ID=<your-app-key>
export DINGTALK_CLIENT_SECRET=<your-app-secret>
```

Or define them in the `env` section of `settings.json`:

```json
{
  "env": {
    "DINGTALK_CLIENT_ID": "your-app-key",
    "DINGTALK_CLIENT_SECRET": "your-app-secret"
  }
}
```

### Connection Recovery

`useConnectionManager` defaults to `true`. The connection manager monitors the Stream WebSocket and replaces the DingTalk SDK client when the connection stops responding. You should normally leave it enabled.

Set `"useConnectionManager": false` to disable Qwen Code's connection manager and fall back to the SDK's keepalive and automatic reconnect behavior.

## Running

```bash
# Start only the DingTalk channel
qwen channel start my-dingtalk

# Or start all configured channels together
qwen channel start
```

Open DingTalk and send a message to the bot. You should see a 👀 emoji reaction appear while the agent processes, followed by the response.

## Daemon Webhook Delivery

When the channel runs under `qwen serve`, authenticated external Webhook events can trigger unattended agent tasks and deliver the final Markdown response to either a DingTalk user or group. Use the existing Webhook target fields; no separate channel type is required:

```json
{
  "webhooks": {
    "sources": {
      "manual-test": {
        "secretEnv": "QWEN_CHANNEL_DINGTALK_TEST_SECRET",
        "targets": {
          "operator": {
            "chatId": "DINGTALK_USER_ID",
            "senderId": "webhook:manual-test",
            "isGroup": false
          },
          "team": {
            "chatId": "OPEN_CONVERSATION_ID",
            "senderId": "webhook:manual-test",
            "isGroup": true
          }
        }
      }
    }
  }
}
```

Every target must set `isGroup` explicitly. For a direct message, `chatId` is the recipient's DingTalk user ID. For a group message, `chatId` is the group's `openConversationId`. Thread targets and incoming robot Webhook URLs are not supported for proactive delivery. See [Webhook-triggered tasks](./overview#webhook-triggered-tasks) for the complete channel configuration and request format.

## Group Chats

DingTalk bots work in both DM and group conversations. To enable group support:

1. Set `groupPolicy` to `"allowlist"` or `"open"` in your channel config
2. Add the bot to a DingTalk group
3. @mention the bot in the group to trigger a response

By default, the bot requires an @mention in group chats (`requireMention: true`). Set `"requireMention": false` for a specific group to make it respond to all messages. See [Group Chats](./overview#group-chats) for full details.

Set `"atSender": true` to have the bot @mention the member whose group message triggered its response. It is off by default and only applies to agent replies with a DingTalk staff ID. Mentioned replies use plain text so the @ is visible; replies without a mention use Markdown formatting.

### Finding a Group's Conversation ID

DingTalk uses `conversationId` to identify groups. You can find it in the channel service logs when someone sends a message in the group — look for the `conversationId` field in the log output.

## Images and Files

You can send photos and documents to the bot, not just text.

**Photos:** Send an image (screenshot, diagram, etc.) and the agent will analyze it using its vision capabilities. This requires a multimodal model — add `"model": "qwen3.5-plus"` (or another vision-capable model) to your channel config. DingTalk supports sending images directly or as part of rich text messages (mixed text + images).

**Files:** Send a PDF, code file, or any document. The bot downloads it from DingTalk's servers and saves it locally so the agent can read it with its file tools. Audio and video files are also supported. This works with any model.

## Key Differences from Telegram

- **Authentication:** AppKey + AppSecret instead of a static bot token. The SDK manages access token refresh automatically.
- **Connection:** WebSocket stream instead of polling — no public IP or webhook URL needed.
- **Formatting:** Responses use DingTalk's markdown dialect. Markdown tables are passed through to the DingTalk client; long messages are split into chunks at ~3800 characters.
- **Working indicator:** A 👀 emoji reaction is added to the user's message while processing, then removed when the response is sent.
- **Media download:** Two-step process — a `downloadCode` from the message is exchanged for a temporary download URL via DingTalk's API.
- **Groups:** DingTalk uses `isInAtList` for @mention detection instead of parsing message entities.

## Tips

- **Use DingTalk markdown-aware instructions** — DingTalk supports headings, bold text, links, code blocks, and tables. Keep tables compact because narrow screens may scroll horizontally.
- **Restrict access** — In an organization context, `senderPolicy: "open"` may be acceptable. For tighter control, use `"allowlist"` or `"pairing"`. See [DM Pairing](./overview#dm-pairing) for details.
- **Referenced messages** — Quoting (replying to) a user message includes the quoted text as context for the agent. Quoting bot responses is not yet supported.

## Troubleshooting

### Bot doesn't connect

- Verify your AppKey and AppSecret are correct
- Check that the environment variables are set before running `qwen channel start`
- Make sure **Stream Mode** is enabled in the bot's settings on the DingTalk Developer Portal
- Check the terminal output for connection errors

### Bot doesn't respond in groups

- Check that `groupPolicy` is set to `"allowlist"` or `"open"` (default is `"disabled"`)
- Make sure you @mention the bot in the group message
- Verify the bot has been added to the group

### "No sessionWebhook in message"

This means DingTalk didn't include a reply endpoint in the message callback. This can happen if the bot's permissions are misconfigured. Check the bot's settings in the Developer Portal.

### "Sorry, something went wrong processing your message"

This usually means the agent encountered an error. Check the terminal output for details.
