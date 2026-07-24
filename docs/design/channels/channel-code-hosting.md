# Code-Hosting Channel Adapters — Design

## Overview

The GitHub polling adapter lets AI agents monitor GitHub for tasks by polling the notifications API and posting agent responses as issue/PR comments. Unlike IM adapters (real-time webhooks/long-poll), this adapter polls on an interval.

## Architecture: Notification as Wake-up Signal

The core insight: platform notifications are **thread-level** and **mutable** — any activity (comment, push, label change) bumps `updated_at`. Notifications cannot be used as a reliable per-comment event stream.

Instead, notifications serve only as a **wake-up signal** ("something happened on this thread"). The adapter then enumerates actual comments via the platform's comments API, using a per-thread watermark to determine which comments are new.

## GitHub: `last_read_at` Watermark

GitHub provides a server-side per-thread read marker:

- `GET /notifications` returns only `unread=true` threads (default)
- `last_read_at` is set by `markThreadAsRead` to the current time
- Non-comment activity bumps `updated_at` but does NOT change `last_read_at`

Poll cycle:

1. `GET /notifications?since={cursor-1s}` — discover unread threads
2. `markNotificationsAsRead(maxUpdatedAt)` — mark all fetched threads as read
3. Advance global cursor to `max(updated_at)`
4. Per thread: `listComments(since=last_read_at)` — enumerate new comments
5. Filter: bot's own comments
6. Process: mention detection → envelope → `handleInbound`

Marking as read happens **before** processing (best-effort delivery). This is safe because the bot's own replies do not flip notifications back to unread — GitHub only sets `unread=true` for notifications triggered by other users' activity. If the process crashes between steps 2 and 6, the affected comments are lost; the user re-mentions to retry.

Correctness comes from `unread` filtering + `last_read_at` watermark. The global cursor is a performance optimization only (server-side `since` filtering).

### Scenario Behavior

| Scenario                          | Behavior                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| New thread (@bot in comment)      | Appears (unread) → markRead → enumerate since cursor-1s → process                         |
| Existing thread, new comment      | Reappears (unread) → markRead → enumerate since last_read_at → only new comments          |
| Non-comment activity (push/label) | Appears → markRead → zero new comments → skip                                             |
| User marks read on github.com     | Disappears from API → not processed                                                       |
| markNotificationsAsRead fails     | Poll error → backoff → retry entire batch next poll                                       |
| Crash after markRead, before done | Comments lost (best-effort) → user re-mentions to retry                                   |
| Bot replies to a thread           | Notification `updated_at` bumped but stays `unread=false` → not re-fetched → no duplicate |
| New issue with @bot in body       | No comments → body contains mention → feed body as trigger                                |

## PollingChannelBase

`PollingChannelBase<Cursor>` (in `packages/channels/base/`) extends `ChannelBase` and provides the poll loop infrastructure:

- **Poll loop**: start/stop via `startPollLoop()`/`stopPollLoop()`, called from `connect()`/`disconnect()`
- **Poll interval**: read from channel config `pollInterval` (ms), defaults to 60000
- **Cursor persistence**: JSON cursor saved atomically after each successful `pollOnce()`; loaded on construction (corrupt → fallback to `createInitialCursor()`)
- **Backoff**: exponential 2s → 30s on poll errors, reset on success

Subclasses implement only:

- `pollOnce()` — do the work, mutate `this.cursor`
- `createInitialCursor()` — first-run default value

The `Cursor` generic is any JSON-serializable object. GitHub uses `{ lastProcessedAt: string }`.

## Mention Detection

Body-based, case-insensitive regex. Separate functions for detection (`testBotMention`) and stripping (`stripBotMention`):

- Detection: explicit regex match returning boolean — never inferred from strip-before/after comparison (whitespace differences cause false positives)
- Stripping: removes only `@bot`, preserves all other formatting (no whitespace collapsing)

## Session Scope

Polling adapters use `chat_thread` scope: routing key = `channel:chatId:threadId`. This prevents cross-repo session collision (`repo-a/issue:42` vs `repo-b/issue:42`).

## Error Handling

Delivery is **best-effort**: notifications are marked as read before processing. On `handleInbound` failure, an error comment is posted on the thread. The user sees the error and can re-mention to retry. If the process crashes after marking read but before processing completes, the affected comments are lost — again, the user re-mentions to retry. This trades transient loss for duplicate prevention and infinite-loop safety, the correct tradeoff for an autonomous 24/7 agent.
