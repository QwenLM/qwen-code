# Feishu Webhook Sending

Use a Feishu custom bot to send notifications and task results to its group.
This method needs a webhook URL and, when enabled on the bot, a signing secret.
It does not require an application, a long connection or an inbound server.
For conversations with an agent, use the [Feishu application bot](./feishu).

## Create the bot

1. Add a custom bot in the destination Feishu group.
2. Copy its webhook URL, beginning with
   `https://open.feishu.cn/open-apis/bot/v2/hook/`.
3. Configure the bot's security settings. If signature verification is enabled,
   also copy its signing secret. Keyword and IP restrictions still apply.

The URL contains a credential. Keep it in Channel configuration or an environment
variable, not in a task prompt or delivery target. This integration supports
`open.feishu.cn`; Lark endpoints are not included.

Use the URL exactly as issued by Feishu. Local validation requires one token
path segment containing letters, digits, `-`, `.`, `_` or `~`, with no percent
encoding, query parameters or fragment.

## Configure a Channel

Add a named instance to the workspace's Channel settings:

```json
{
  "channels": {
    "team-notices": {
      "type": "feishu-webhook",
      "webhookUrl": "$FEISHU_WEBHOOK_URL",
      "signingSecret": "$FEISHU_WEBHOOK_SECRET"
    }
  }
}
```

Set these variables in the environment used to start Qwen Code. Omit
`signingSecret` if the bot does not require signing. Use the custom bot's signing
secret, not an application's App Secret.

Run the daemon in that workspace:

```bash
qwen serve --channel team-notices
```

One named instance represents one group. Create additional instances for other
groups. Changing an instance's URL changes the destination for future deliveries
that reference it.

Starting the Channel makes it locally ready to send; it does not send a test
message or verify remote credentials. Stopping cancels in-flight sends. Restart
or reload applies saved configuration changes.

## Explicit API delivery

Notify and explicit prompt/scheduled delivery use the existing Channel target
format. This adapter owns one logical destination, `chat/default`:

```json
{
  "text": "# Daily report\n\nThe checks passed.",
  "delivery": {
    "kind": "channel",
    "target": {
      "channelName": "team-notices",
      "type": "chat",
      "id": "default"
    }
  }
}
```

This is a workspace Notify request body. `default` is an alias for the configured
group, not a Feishu chat ID. Other IDs and user targets are rejected. The endpoint
and signing secret stay in Channel configuration.

Persistent scheduled tasks use the same destination tuple. Delivery retains the
existing best-effort successful-final-result behavior, including current per-run
and manual-trigger restrictions.

## Message formatting and limits

- Sends plain text and Markdown in a static schema 2.0 card. Headings, lists,
  links, fenced code, tables, Chinese and emoji remain valid input. The card has
  no buttons, streaming updates or duplicated preview summary.
- Uses Feishu's Markdown subset; complete GitHub-flavored Markdown compatibility
  is not guaranteed. Tables use separate elements within the same card. Feishu
  documents pagination after five data rows per table.
- Escapes complete `<at ...>` and `</at>` tags with numeric HTML entities so
  task-provided mention markup is sent as literal text. This also applies inside
  code examples. Configurable mentions and recipient lookup are not supported.
  Client rendering and notification behavior should be checked in your group.
- Checks the **complete serialized UTF-8 JSON request**, including escaping,
  card structure and optional signature, against a **20,000-byte local budget**.
  Feishu's custom-bot guide states 20 KB without specifying the exact byte count;
  this conservative local limit is not a measured platform maximum.
- Rejects oversized requests before sending, with an explicit delivery failure.
  The adapter does not silently truncate, split into multiple requests or retry.
  The shared delivery size protection still applies before this platform check.
  Keep reports concise enough for the complete request to fit.

## Failures and transport

Both the HTTP status and Feishu's numeric `code` are checked. Keyword, IP,
signature and rate-limit rejections are observable failures. Errors omit the
webhook URL, secrets, message content and raw provider responses.

Each attempt sends at most one request, with a 15-second timeout. A timeout or
cancellation can leave remote acceptance unknown. The Channel uses the resolved
workspace proxy and existing `NO_PROXY` bypass behavior.

This mode does not receive messages, run inbound webhook tasks or start Channel
loops. It adds no attachments, failure/cancellation alerts, durable retry queue
or generic webhook protocol.

See the official [custom-bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
and [Markdown component documentation](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text?lang=zh-CN)
for platform configuration and rendering requirements.
