# DingTalk Webhook Sending

Use a DingTalk custom robot to post notifications and task results to its group.
This sending mode does not require an application bot, a long connection, a
public callback server or a conversation ID. For conversations with an agent,
use the [DingTalk application bot](./dingtalk) instead.

## Create the robot

1. Add a custom robot in the destination DingTalk group.
2. Copy its webhook URL, beginning with
   `https://oapi.dingtalk.com/robot/send?access_token=...`.
3. Configure the robot's security settings. If signing is enabled, also copy its
   signing secret. Keyword and IP restrictions still apply to every message.

The webhook URL contains a credential. Store it as a secret or environment
reference, not in a scheduled task's prompt or delivery target.

## Configure a Channel

Add a named instance to the workspace's Channel settings:

```json
{
  "channels": {
    "team-notices": {
      "type": "dingtalk-webhook",
      "webhookUrl": "$DINGTALK_WEBHOOK_URL",
      "signingSecret": "$DINGTALK_WEBHOOK_SECRET"
    }
  }
}
```

Set the referenced variables in the environment used to start Qwen Code. Omit
`signingSecret` when the robot does not require signing. This secret is the
custom robot's signing secret, not an application's Client Secret.

Run the daemon in that workspace:

```bash
qwen serve --channel team-notices
```

One named instance represents one configured group. Create additional instances
for other groups. Updating an instance's URL changes the destination for future
deliveries that reference it.

## Use Web Shell

In Channels, choose DingTalk and its webhook sending method. Save the webhook
URL and optional signing secret, then start the Channel. Receiving, pairing and
agent-session settings do not apply to this method.

Use the test-send action on the saved, running Channel to send a real test
notification. A ready/connected status means local sending resources are ready;
it does not verify remote credentials. A successful test means DingTalk accepted
the API request, not that a group member has read the message.

In Scheduled Tasks, choose a persistent task and select this Channel as the
delivery destination. Web Shell fills the configured destination automatically;
no observed contacts or manual user/chat ID are needed. Existing per-run delivery
restrictions remain in effect.

The same controls are available in the shared Web Shell used by
`WebShellWithProviders`, when the host enables Channels and Scheduled Tasks and
provides an ordinary daemon workspace.

## Explicit API delivery

Notify and explicit prompt/scheduled delivery use the existing Channel target
format. This adapter defines `chat/default` as its only logical destination:

```json
{
  "text": "The daily report is ready.",
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

This is a workspace Notify request body. `default` is an adapter-owned alias,
not a DingTalk conversation ID. Other IDs and user targets are rejected; the
adapter never ignores an arbitrary requested destination. The webhook URL and
signing secret stay in Channel configuration.

## Delivery behavior

- Sends plain text. It does not receive messages, run inbound webhook tasks or
  enable Channel loops.
- Checks both HTTP status and DingTalk's business response. Rejected signatures,
  credentials, security rules and rate limits are failures with sanitized errors.
- Does not automatically retry. A timeout can leave remote acceptance unknown.
- Cancels in-flight sending when the Channel stops. Reload uses the updated
  saved configuration.
- Keeps the shared delivery size protection, which marks truncated results.
  The adapter does not add another silent truncation layer; platform rejection
  of oversized text is reported as failure.
- Scheduled delivery retains its existing best-effort successful-final-result
  behavior. This does not introduce failure/cancellation alerts, a durable retry
  queue, attachments or a generic webhook payload contract.

See DingTalk's [sending API](https://open.dingtalk.com/document/orgapp/custom-robots-send-group-messages)
and [security settings](https://open.dingtalk.com/document/orgapp/customize-robot-security-settings)
for platform requirements.
