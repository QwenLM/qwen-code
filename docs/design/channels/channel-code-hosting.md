# Code-Hosting Channel Adapters — Design

## Overview

The GitHub polling adapter lets AI agents monitor GitHub for tasks by polling the notifications API and posting agent responses as issue/PR comments. Unlike IM adapters (real-time webhooks/long-poll), this adapter polls on an interval.

## Architecture: Notification as Wake-up Signal

The core insight: platform notifications are **thread-level** and **mutable** — any activity (comment, push, label change) bumps `updated_at`. Notifications cannot be used as a reliable per-comment event stream.

Instead, notifications serve only as a **wake-up signal** ("something happened on this thread"). The adapter then enumerates actual comments via the platform's comments API, using a per-thread watermark to determine which comments are new.

## GitHub: Cursor-Based Comment Window

### Notification/Comment Timestamp Decoupling

A critical timing issue: **notification `updated_at` and comment `updated_at` are decoupled**.

- `notification.updated_at` is bumped by _any_ thread activity (comment, push, label change) and is subject to delivery delay
- `comment.updated_at` reflects when the comment was actually created/edited

These timestamps have no causal relationship. A notification can arrive 16 seconds after the comment that triggered it, and can be bumped again by unrelated activity. Using notification timestamps to gate comment enumeration therefore produces two failure modes:

1. **Duplicate replies** — `PUT /notifications` is async (202 Accepted) with a `last_read_at` cutoff. The bot's reply bumps `updated_at` past the cutoff before the server processes the mark, so the notification is never marked read. The next poll re-fetches it and re-processes the same comments.
2. **Missed replies** — the cursor advances to `max(notification.updated_at)`, which can leap past comments on late-arriving notifications. When those notifications finally arrive, their comments fall below the cursor window and are silently excluded.

### Design

Correctness comes from a **cursor-based comment window**, not from the notification's read status:

Poll cycle:

1. `GET /notifications?since={cursor-1s}` — discover unread threads
2. Save `windowSince = cursor.lastProcessedAt` (the cursor **before** this poll advances it)
3. `markNotificationsAsRead(maxUpdatedAt)` — best-effort global mark (cleans up non-issue notifications)
4. Advance global cursor to `max(notification.updated_at)`
5. Per thread: `listComments(since=windowSince)` — enumerate comments
6. Exclude: bot's own comments; comments with `created_at > maxUpdatedAt` (above window); comments with `created_at <= windowSince` (below window)
7. Process: mention detection → envelope → `handleInbound`

The effective comment window is `(windowSince, maxUpdatedAt]`. Comments processed in a previous poll have `created_at <= windowSince` (the previous poll's `maxUpdatedAt`) and are excluded. This prevents duplicates regardless of whether `PUT /notifications` succeeded. Comment edits do not re-trigger processing — only `created_at` is used for window membership.

The global mark is still called (step 3) to clean up non-issue/PR notifications and reduce the unread list, but it is not load-bearing for dedup.

### Known Limitation: Late Notification Delivery

Because the cursor is global (not per-thread), a notification that arrives in a later poll than its comments' `created_at` can have those comments excluded by the cursor window. This requires notification delivery to be delayed across a poll boundary AND another thread's comments to advance the cursor past them in the interim. In practice this window is narrow (notification delivery typically completes within one poll interval); the user can re-mention to retry.

### Known Limitation: PR Review Comments

`issues.listComments` returns only general conversation comments, not PR review comments (per-line diff comments). An @-mention in a PR review comment is silently dropped. Use a general conversation comment on the PR instead.

### Scenario Behavior

| Scenario                          | Behavior                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| New thread (@bot in comment)      | Appears (unread) → enumerate since cursor → process                                                                           |
| Existing thread, new comment      | Reappears (unread) → enumerate since cursor → old comments excluded by `<= windowSince` → only new                            |
| Non-comment activity (push/label) | Appears → zero new comments in window → skip                                                                                  |
| User marks read on github.com     | Disappears from API → not processed                                                                                           |
| markNotificationsAsRead fails     | Cursor window still prevents duplicates → no impact on correctness                                                            |
| Crash after markRead, before done | Cursor not saved → next startup re-fetches same notifications → crashed batch re-processed, not lost                          |
| Bot replies to a thread           | `updated_at` bumped → notification may stay unread → next poll fetches it → comments excluded by cursor window → no duplicate |
| New issue with @bot in body       | No comments → body contains mention → feed body as trigger (deduped via `dispatchedBodies`)                                   |

## PollingChannelBase

`PollingChannelBase<Cursor>` (in `packages/channels/base/`) extends `ChannelBase` and provides the poll loop infrastructure:

- **Poll loop**: start/stop via `startPollLoop()`/`stopPollLoop()`, called from `connect()`/`disconnect()`
- **Poll interval**: read from channel config `pollInterval` (ms), validated as positive finite number, defaults to 60000
- **Cursor persistence**: JSON cursor saved atomically after each successful `pollOnce()`; loaded on construction (corrupt or unparseable date → fallback to `createInitialCursor()`)
- **Cursor validation**: `validateCursor()` virtual hook — base rejects non-objects and arrays; subclasses add shape checks (e.g. GitHub rejects missing/invalid `lastProcessedAt` date)
- **Backoff**: exponential 2s → 30s on poll errors, reset on success
- **Abortable sleep**: `abortableSleep(ms)` exposed as a protected method — poll interval and error backoff are interruptible via `disconnect()`

Subclasses implement only:

- `pollOnce()` — do the work, mutate `this.cursor`
- `createInitialCursor()` — first-run default value

The `Cursor` generic is any JSON-serializable object. GitHub uses `{ lastProcessedAt: string; dispatchedBodies?: string[] }` (the latter bounds first-contact body dedup to the most recent 500 entries).

## Mention Detection

Body-based, case-insensitive regex. Separate functions for detection (`testBotMention`) and stripping (`stripBotMention`):

- Detection: explicit regex match returning boolean — never inferred from strip-before/after comparison (whitespace differences cause false positives)
- Stripping: removes only `@bot`, preserves all other formatting (no whitespace collapsing)

## Session Scope

Polling adapters use `chat_thread` scope: routing key = `channel:chatId:threadId`. This prevents cross-repo session collision (`repo-a/issue:42` vs `repo-b/issue:42`).

## Error Handling

Delivery is **best-effort**. On `handleInbound` failure, one error comment is posted per thread per poll cycle (then `break` exits the comment loop — prevents N identical error comments); the user re-mentions to retry. Per-notification API errors use `continue` — one failed notification does not block the rest of the batch. Notifications without a `subject.url` (Discussion, SecurityAlert types) are skipped silently.

If the process crashes mid-processing, the cursor is not saved (it is persisted only after `pollOnce()` completes), so the next startup re-fetches the same notifications — but the cursor-based comment window excludes already-processed comments, preventing duplicates.

Duplicate prevention does **not** depend on `PUT /notifications` succeeding. The global mark is best-effort cleanup; the cursor window is the load-bearing dedup mechanism.
