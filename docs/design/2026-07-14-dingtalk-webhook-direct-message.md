# DingTalk Webhook Direct-Message Delivery

## Status

Approved for implementation. Tracks
[QwenLM/qwen-code#6883](https://github.com/QwenLM/qwen-code/issues/6883).

## Context

Daemon-managed channels can accept authenticated external webhook events, run
them as unattended agent tasks, and proactively deliver the final response to a
configured chat target. DingTalk currently supports this delivery only for
groups: a target must set `isGroup: true`, and the adapter sends Markdown
through the group-message API.

This prevents webhook sources such as CI systems and operational monitors from
notifying one responsible DingTalk user without involving a group.

## Goals

- Deliver daemon webhook task results to DingTalk direct-message targets.
- Preserve existing DingTalk group webhook delivery behavior.
- Reuse the existing target schema, token cache, Markdown formatting, chunking,
  retry, and delivery-error behavior.
- Keep the implementation inside the existing DingTalk adapter.

## Non-goals

- Native DingTalk cards or card callbacks.
- Streaming card updates, buttons, feedback, or task cancellation from DingTalk.
- Multiple recipients in one target.
- Threaded DingTalk targets.
- A new channel type or daemon webhook protocol.

## Target configuration

No new configuration fields are required. The existing webhook target fields
have the following DingTalk-specific meaning:

| `isGroup` | `chatId` meaning                    | Delivery API                  |
| --------- | ----------------------------------- | ----------------------------- |
| `true`    | DingTalk group `openConversationId` | `robot/groupMessages/send`    |
| `false`   | DingTalk user ID                    | `robot/oToMessages/batchSend` |

`senderId` remains the synthetic identity used to route the webhook task to an
agent session. It is not the DingTalk recipient ID.

Example:

```json
{
  "webhooks": {
    "sources": {
      "github-ci": {
        "secretEnv": "QWEN_CHANNEL_GITHUB_CI_SECRET",
        "targets": {
          "operator": {
            "chatId": "DINGTALK_USER_ID",
            "senderId": "webhook:github-ci",
            "isGroup": false
          },
          "team": {
            "chatId": "OPEN_CONVERSATION_ID",
            "senderId": "webhook:github-ci",
            "isGroup": true
          }
        }
      }
    }
  }
}
```

Targets must explicitly set `isGroup`. The adapter continues to reject targets
with an empty `chatId`, a `threadId`, a missing `isGroup`, or a webhook URL in
place of a stable target ID.

## Delivery flow

The daemon route, worker IPC, and shared channel runtime remain unchanged:

```text
POST /channels/:channelName/webhooks/:source
  -> daemon authenticates and validates the event
  -> channel worker runs the unattended agent task
  -> ChannelBase calls DingtalkChannel.pushProactive()
  -> adapter selects the DingTalk API from target.isGroup
  -> DingTalk receives Markdown
```

For group targets, the adapter keeps the current request body:

```json
{
  "robotCode": "CLIENT_ID",
  "openConversationId": "OPEN_CONVERSATION_ID",
  "msgKey": "sampleMarkdown",
  "msgParam": "{...}"
}
```

For direct-message targets, it sends the same Markdown template through the
one-to-one API:

```json
{
  "robotCode": "CLIENT_ID",
  "userIds": ["DINGTALK_USER_ID"],
  "msgKey": "sampleMarkdown",
  "msgParam": "{...}"
}
```

Both paths use the existing access-token cache, refresh one minute before token
expiry, retry once after HTTP 401, and apply the same Markdown normalization and
chunking limits. A multi-chunk delivery stops at the first failed chunk.

## Error handling

- Invalid targets fail webhook-task validation before the agent runs.
- Token acquisition failures remain delivery failures and are logged without
  exposing credentials.
- HTTP 401 clears the cached token and retries the current chunk once.
- Other unsuccessful HTTP responses stop delivery and surface a sanitized API
  detail in the channel-worker log.
- A daemon response of `202 {"accepted": true}` continues to mean only that the
  worker accepted the task, not that DingTalk delivery succeeded.

No Markdown fallback is necessary because Markdown is the only delivery format
in this scope.

## Testing

### Unit tests

- Accept explicit group and direct-message proactive targets.
- Reject missing `isGroup`, empty IDs, webhook URLs, and threaded targets.
- Preserve the existing group endpoint and `openConversationId` request body.
- Use the one-to-one endpoint and `userIds` request body for direct messages.
- Reuse a cached token across group and direct-message sends.
- Refresh the token and retry once after HTTP 401.
- Apply chunking and first-failure termination to direct-message delivery.

### Local end-to-end verification

Create a plan under `.qwen/e2e-tests/` and first run the globally installed
`qwen` CLI to capture the current rejection of a direct-message webhook target.
After implementation:

1. Configure one direct-message target and one group target.
2. Start `qwen serve` with the DingTalk channel enabled.
3. Use `curl` to post one event for each `targetRef`.
4. Confirm both requests return `202`.
5. Confirm the channel worker completes both tasks.
6. Confirm the expected Markdown reaches the selected DingTalk user and group.

If live credentials or recipients are unavailable, the unit tests remain the
automated delivery proof and the missing live step is reported explicitly.

## Documentation

Update the channel webhook documentation to show both DingTalk target forms and
state that direct-message `chatId` values are DingTalk user IDs.

## Compatibility

The change is additive. Existing group targets keep the same configuration,
validation, endpoint, payload, formatting, and retry behavior. No configuration
migration is required.
