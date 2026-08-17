# GitHub Notification Reason Dispatch

## Goal

Use `notification.reason` to choose the prompt sent by the GitHub channel
without changing its polling, cursor advancement, retry, or error-reporting
behavior.

| Reason              | Behavior                                                        |
| ------------------- | --------------------------------------------------------------- |
| `mention`           | Send only content that actually mentions the bot.               |
| `review_requested`  | For pull requests, send a review prompt with pull request data. |
| `assign`            | Send a triage prompt with issue data.                           |
| `author`, `comment` | Aggregate the window's new comments into one follow-up prompt.  |
| Other               | Keep per-comment handling and identify the notification reason. |

Review and assignment events use the GitHub event actor as the envelope sender
so the existing sender policy checks the person who initiated the action, not
the issue or pull request author. Aggregation includes only allowed senders and
is limited to the latest 20 comments and 400 characters per comment. Pairing
policy keeps per-comment dispatch so each sender is authorized independently.

The cursor remembers up to 500 dispatched comment and direct-event node IDs.
A fixed installation-time floor lets delayed review and assignment
notifications find their event without replaying pre-installation history.
Notification IDs are not persisted because GitHub reuses them for later
activity on the same thread.

## Verification

The focused adapter test covers each route, direct-trigger metadata, mention
stripping, aggregate authorization, and comment and direct-event deduplication.
