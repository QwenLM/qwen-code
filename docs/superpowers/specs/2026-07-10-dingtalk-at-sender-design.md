# DingTalk At-Sender Replies Design

## Goal

Allow a DingTalk channel to optionally mention the person whose group message
triggered an agent response.

## Configuration

Each DingTalk channel accepts an optional boolean `atSender` setting. It
defaults to `false`.

```json
{
  "channels": {
    "my-dingtalk": {
      "type": "dingtalk",
      "atSender": true
    }
  }
}
```

## Behaviour

When `atSender` is enabled, a normal agent reply to a group message includes
the originating message's `senderStaffId` in DingTalk's Markdown `atUserIds`.
Only the first outbound chunk contains this field, so a long response does not
notify the same person repeatedly.

The adapter sends an ordinary reply without an `at` field when the setting is
disabled, the message is a DM, or DingTalk did not supply a staff ID. Scheduled
and proactive sends, local command responses, and adapter error fallbacks are
also unchanged because they do not belong to a specific inbound agent prompt.

## Correlation

The adapter records each inbound group message's staff ID by its DingTalk
message ID. When `ChannelBase` starts the corresponding prompt, its existing
`onPromptStart(chatId, sessionId, messageId)` hook binds that ID to the session.
The adapter's `onResponseComplete` override retrieves the bound staff ID and
passes it to its own reply sender. Prompt completion clears the session binding.

This correlation avoids deriving the recipient from the latest message in a
chat, which would mention the wrong person when prompts queue or overlap.

## Validation

Unit tests assert that enabled group replies include exactly one `atUserIds`
entry, disabled replies and missing staff IDs omit it, and multi-chunk replies
mention only in the first chunk. The DingTalk adapter test suite, build, and
typecheck validate the local implementation. A manual DingTalk group test
checks that the first reply produces a real mention and notification.
