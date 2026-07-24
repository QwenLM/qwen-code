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
2. Per thread: `listComments(since=last_read_at)` — enumerate new comments
3. Filter: bot's own comments
4. Process: mention detection → envelope → `handleInbound`
5. `markNotificationsAsRead` — advances `last_read_at` (global, all fetched threads)
6. Advance global cursor to `max(updated_at)`

Correctness comes from `unread` filtering + `last_read_at` watermark. The global cursor is a performance optimization only (server-side `since` filtering).

### Scenario Behavior

| Scenario                          | Behavior                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| New thread (@bot in comment)      | Appears (unread) → enumerate since cursor-1s → process → markRead                                       |
| Existing thread, new comment      | Reappears (unread) → enumerate since last_read_at → only new comments → markRead                        |
| Non-comment activity (push/label) | Appears → zero new comments → skip → markRead                                                           |
| User marks read on github.com     | Disappears from API → not processed                                                                     |
| markNotificationsAsRead fails     | All threads stay unread, cursor does not advance → entire batch re-enumerated next poll (at-least-once) |
| New issue with @bot in body       | No comments → body contains mention → feed body as trigger                                              |

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

On `handleInbound` failure: post an error comment on the thread + advance cursor. The user sees the error and can re-mention to retry. This trades transient loss for infinite-loop prevention — the correct tradeoff for an autonomous 24/7 agent.
