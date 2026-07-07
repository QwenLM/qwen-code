# Channel Webhook Tasks Design

## Summary

Add a channel webhook task path that lets an external event trigger an unattended Qwen turn and proactively send the final response to an authorized chat target.

This is not a raw notification relay. The webhook payload becomes structured event context for Qwen. Qwen summarizes, judges relevance, and writes the message that should be delivered to the group. The existing channel session routing, prompt lifecycle, queueing, and proactive send path remain the core execution model.

## Goals

- Accept authenticated external webhook events for configured channels.
- Run Qwen once per accepted event with an unattended prompt contract.
- Deliver Qwen's final response through the target channel's proactive send implementation.
- Keep target selection explicit and authorized; webhook payloads must not be able to freely choose arbitrary chat IDs.
- Reuse existing channel base behavior where possible, especially `runLoopPrompt()` style unattended execution and `pushProactive()`.

## Non-Goals

- Build a general notification center.
- Add provider-specific GitHub, GitLab, CI, or Aone templates in the first slice.
- Let webhook callers bypass channel sender/group authorization.
- Support interactive permission prompts for webhook-triggered turns.
- Add a new cross-channel outbound transport separate from channel adapters.

## Architecture

Introduce a base-layer concept named `ChannelWebhookTask`.

```ts
interface ChannelWebhookTask {
  channelName: string;
  source: string;
  eventType: string;
  targetRef: string;
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
}
```

`targetRef` is resolved by channel-owned configuration or a persisted binding into a `SessionTarget`. The request body does not directly supply the final `chatId` unless that mode is explicitly configured for trusted internal deployments.

`ChannelBase` gets a method shaped like `runWebhookTask(task, options)`. It should mirror the important behavior of `runLoopPrompt()`:

- verify the channel supports proactive send;
- resolve the authorized target;
- resolve the session with `SessionRouter`;
- queue work per session target;
- create an unattended prompt;
- stream lifecycle events as a normal channel task;
- call `pushProactive(target, response)` with the final assistant response.

The first HTTP entry point should live in the channel host layer, not inside individual adapters. For daemon-managed channels, this is a route mounted by `qwen serve` when webhook support is enabled. The route validates auth, parses the event, finds the running channel, and delegates to `runWebhookTask()`.

## Data Flow

1. External system sends `POST /channels/:channelName/webhooks/:source`.
2. The host validates the webhook secret or signature.
3. The host normalizes the body into `ChannelWebhookTask`.
4. The target resolver maps `targetRef` to a stored channel target.
5. `ChannelBase.runWebhookTask()` creates an unattended prompt.
6. Qwen processes the event and produces the message to send.
7. The channel adapter sends the final response through `pushProactive()`.

## Prompt Contract

Webhook prompts should make the delivery contract explicit:

```text
[External event "<eventType>" from <source>]
You are responding to an external webhook event. No human is present.
Understand the event, decide what matters, and produce the message that should
be sent to the chat. Do not ask follow-up questions. Do not try to send the
message yourself; your final response will be delivered automatically.

Target:
<target metadata>

Event:
<sanitized structured event>
```

The prompt should include bounded, sanitized fields. Large payloads are truncated before reaching the model.

## Target Authorization

The safe default is a configured binding:

```json
{
  "channels": {
    "dingtalk-main": {
      "webhooks": {
        "github-ci": {
          "secretEnv": "QWEN_CHANNEL_GITHUB_CI_SECRET",
          "targets": {
            "default": {
              "chatId": "cid...",
              "senderId": "webhook:github-ci",
              "isGroup": true
            }
          }
        }
      }
    }
  }
}
```

The webhook request selects `targetRef: "default"`. It cannot invent a new chat target. A later slice can add a chat command that binds the current group to a target ref.

## Security

- Require per-source secret or signature validation.
- Reject unsigned webhook routes by default.
- Limit payload size before JSON parsing and limit serialized prompt size after parsing.
- Sanitize source, event type, title, target ref, and payload text before prompt construction.
- Run only in unattended-compatible approval modes. If the channel would require interactive permission, reject the task before prompting.
- Keep delivery target authorization separate from model instructions; prompt injection in the payload must not alter where the response is sent.
- Log only bounded metadata and error summaries, not full secrets or full payloads.

## Error Handling

- Auth failure returns `401`.
- Unknown channel, source, or target ref returns `404`.
- Unsupported proactive send returns `409`.
- Payload too large or malformed returns `400`.
- Agent or delivery failure records a failed lifecycle event and returns `202` if processing is async, or `500` if the MVP keeps the request open until completion.

The MVP should prefer async acceptance: return `202 Accepted` once the event is queued, then finish work in the channel runtime. This avoids webhook provider timeout pressure.

## Testing

Base package tests:

- accepts a webhook task and runs one unattended prompt;
- rejects channels without proactive send;
- resolves only configured target refs;
- serializes tasks for the same session target;
- emits lifecycle started, chunks, completed, failed, and cancelled consistently with loop prompts;
- truncates oversized event fields before prompt construction.

Host route tests:

- rejects missing or invalid secrets;
- rejects unknown channel/source/target;
- returns `202` after queueing a valid task;
- does not pass caller-supplied arbitrary `chatId` through in configured-target mode.

Adapter tests:

- reuse existing proactive-send tests for DingTalk, Feishu, and Telegram;
- add only targeted coverage where a platform has target-specific proactive constraints.

## Rollout

1. Add base `ChannelWebhookTask` types and `runWebhookTask()` with tests.
2. Add daemon-managed route behind explicit configuration.
3. Support one custom JSON source with configured target refs.
4. Document configuration and a curl example.
5. Add provider-specific normalizers only after the generic path is stable.

