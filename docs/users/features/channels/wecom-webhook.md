# WeCom Webhook Sending

Use an internal WeCom group's Message Push webhook (formerly called a group
robot) to send notifications and task results. This needs only the group's
webhook URL, without Bot ID/Secret, application credentials, a long connection
or a public inbound server. For conversations with an agent, use the
[WeCom intelligent robot](./wecom); for a self-built application, see
[WeCom Callback](./wecom-callback).

## Create a group destination

1. Open an internal WeCom group's settings and find Message Push.
2. Create a custom Message Push and copy its webhook URL, beginning with
   `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=`.
3. Check your organization's creation permissions if the entry is unavailable.
   Administrators can restrict which members may create Message Push, and
   owner-managed groups can restrict the entry to the group owner.

External groups are not supported by this setup. The official creation
conditions describe internal-group and administrator permissions; they do not
establish a universal enterprise-certification requirement or exemption.

The URL contains the sending credential. Keep it in Channel configuration or an
environment variable, never in a task prompt or delivery target. Use the URL as
issued by WeCom. Local validation allows exactly one `key` parameter containing
letters, digits, `-`, `.`, `_` or `~`; percent encoding, fragments and
additional parameters are not accepted. There is no separate signing secret.

## Configure a Channel

Configure this integration in [Web Shell](#use-web-shell) or `settings.json` as
shown below.

Add a named instance to the workspace's Channel settings:

```json
{
  "channels": {
    "team-notices": {
      "type": "wecom-webhook",
      "webhookUrl": "$WECOM_WEBHOOK_URL"
    }
  }
}
```

Set `WECOM_WEBHOOK_URL` in the environment used to start Qwen Code, then run
the daemon in that workspace:

```bash
qwen serve --channel team-notices
```

One named instance represents one group. Create additional instances for other
groups. Changing an instance's URL changes future deliveries through it.

Starting makes the Channel locally ready to send. It does not send a test
message or verify the remote credential. Stopping cancels in-flight sends;
restart or reload applies saved configuration changes.

## Use Web Shell

If your build contains the backend support but predates the Web integration,
Channels does not list this method or existing `wecom-webhook` instances. Use
the `settings.json` and `qwen serve --channel` steps above until you upgrade to
a build containing the Web integration.

In Channels, choose WeCom and then Webhook (send only). Select the workspace,
save the webhook URL and start the Channel. No signing secret is needed.
Receiving, pairing and agent-session settings do not apply to this method.
The intelligent-bot method remains under WeCom; WeCom Callback keeps its
separate entry.

In Scheduled Tasks, choose a persistent task session and select this Channel
as the delivery destination. Web Shell fills its configured group automatically;
no observed contacts or manually entered chat ID are needed. Existing per-run
and manual-trigger delivery restrictions remain in effect.

The same controls are available through `WebShellWithProviders` when the host
enables Channels and Scheduled Tasks and supplies a daemon workspace.

## Explicit API delivery

Notify and explicit prompt/scheduled delivery use the existing Channel target.
This adapter owns one logical destination, `chat/default`:

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

This is a workspace Notify request body. `default` names the configured group;
it is not a WeCom chat ID. Other IDs, user targets and threads are rejected.
Tasks store the logical destination; the credential stays in Channel settings.

Persistent scheduled tasks use the same destination. Delivery retains the
existing best-effort successful-final-result behavior, including current
per-run and manual-trigger restrictions.

## Message formatting and limits

- Sends `markdown_v2` with the original text. Its supported subset includes
  headings, lists, links, fenced code and tables; ordinary text, Chinese and
  emoji are valid input. Complete GitHub-flavored Markdown compatibility is
  not guaranteed.
- This format does not support mentions or font-colour markup. The adapter
  sends no mention arrays and does not turn task text into mentions.
  Mention-looking strings such as `<@all>` remain in the body.
- Clients before 4.1.36 (Android before 4.1.38) display the message as plain text.
  Use a current client for Markdown rendering.
- The final **content** is limited to **4096 UTF-8 bytes**, before JSON escaping.
  Chinese and emoji take more bytes than ASCII. This is not a 4096-character
  limit or a limit on the complete JSON request.
- Oversized content fails explicitly before sending. There is no silent adapter
  truncation, automatic splitting or retry. The shared delivery bound still
  applies before the platform-specific check.
- WeCom permits **20 messages per minute per webhook**. Keep scheduled reports
  concise and avoid bursts; throttled deliveries report failure without queuing.

## Failures and transport

Both HTTP status and the numeric WeCom `errcode` are checked. Invalid or
disabled credentials, rejected group destinations and rate limits produce
observable failures. Diagnostics omit the URL, key, message content and raw
provider error text.

Each attempt makes at most one request with a 15-second timeout. API acceptance
is not a read receipt; a timeout or cancellation can leave remote acceptance
unknown. Transport honors the resolved workspace proxy and existing
`NO_PROXY` behavior.

This mode does not receive messages, run inbound webhook tasks or start Channel
loops. It adds no attachments, interactive cards, automatic failure/cancellation
alerts, durable retries or generic webhook protocol.

See the official [Message Push protocol](https://developer.work.weixin.qq.com/document/path/91770)
and [setup guide](https://open.work.weixin.qq.com/help2/pc/14931) for current
platform requirements.
