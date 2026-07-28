# GitHub Notification Reason Dispatch

## Goal

Use GitHub notifications as wake-up signals while preserving the channel's
existing sender and mention gates.

Issue #7807 adds five behaviors:

| Notification        | Behavior                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| `mention`           | Dispatch only new comments that actually mention the bot.                         |
| `review_requested`  | Dispatch PR metadata only when a matching issue event requested this bot.         |
| `assign`            | Dispatch issue or PR metadata only when a matching issue event assigned this bot. |
| `author`, `comment` | Aggregate new comments from allowed senders.                                      |
| Other reasons       | Keep the existing per-comment behavior with trigger metadata.                     |

## Event identity and authorization

GitHub notification IDs identify threads, and `reason` is sticky rather than a
unique event. A notification with `reason: review_requested` may therefore be
returned again after unrelated activity.

For `review_requested` and `assign`, the adapter reads the newest page of issue
events (and the preceding page when the last page is partial) and accepts only
the latest matching direct-user event after the channel's installation floor
that has not already been dispatched. This fixed floor allows delayed
notifications without replaying pre-installation events. A later removal or
unassignment cancels the trigger. Sticky direct reasons also check new comments
for real mentions, so later conversation is not hidden by the old reason. The
event actor becomes the envelope sender, so `senderPolicy` checks the person who
requested the review or assignment instead of the PR or issue author. Team
review requests fail closed because a notification does not prove that the bot
belongs to the requested team.

PR and issue bodies are labeled as untrusted data before they enter the prompt.
Aggregated comments are filtered by sender policy before joining and remain
behind the normal mention gate. Pairing-policy comments stay in per-sender
envelopes so one sender can never authorize another sender's content. The
envelope's `isMentioned` is computed from comment content: it is true when any
shown comment mentions the bot, matching the per-comment lane's behavior.

## Cursor and retries

The cursor keeps three bounded lists and a failure counter:

- `dispatchedBodies` for first-contact issue or PR bodies
- `dispatchedComments` for comment node IDs
- `dispatchedEvents` for issue event node IDs
- `failedAttempts` mapping notification IDs to consecutive failure counts,
  with the maximum value marking terminal notifications

New keys are saved immediately, so a process crash or a later mark-read failure
does not repeat work already accepted by the channel. The lists are trimmed to
the latest 500 keys after a successful poll; they remain untrimmed while a poll
is retrying so a large in-flight batch is not duplicated.

Processing continues after an individual failure so later threads are not
blocked. The adapter marks notifications read through the batch timestamp and
advances `lastProcessedAt` only when the whole batch succeeds; this timestamped
mark avoids swallowing activity that arrives during the poll.

A notification that fails with a permanent GitHub error (a deleted or
transferred subject returning 404/410, or a 403 permission error without
rate-limit headers) is logged and persisted as terminal instead of being
treated as a batch failure. A 403 with `retry-after` or
`x-ratelimit-remaining: 0` is a rate limit and stays retryable.

Transient failures hold the batch open for at-least-once retry, bounded by a
per-notification attempt counter persisted in the cursor. After 5 consecutive
failures across polls, the notification is persisted as terminal: an error
comment is posted once so the user has a visible signal, and the batch
advances. A successful retry clears its failure count.

## Bounds

Comment aggregation includes at most the latest 20 comments and 1,000
characters from each body. PR and issue bodies are capped at 6,000 characters.
These limits bound prompt growth without adding configuration.

## Verification

The package test covers one contract per route plus the failure boundaries:

- real mention gating for `mention` and aggregate routes
- issue-event actor attribution for review and assignment
- sticky reasons without a new matching issue event do not dispatch
- mentions still dispatch under sticky direct reasons
- per-sender aggregate filtering
- per-sender pairing authorization
- persisted comment dedup
- bounded retries, success reset, and persistent terminal failures

Run:

```bash
cd packages/channels/github
npx vitest run src/GithubAdapter.test.ts
```
