# Code-Hosting Channel Adapters — Design

[English](channel-code-hosting.md) | [简体中文](channel-code-hosting.zh-CN.md)

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
5. Per thread: `listComments(since=windowSince)` — enumerate comments (from a second earlier when the window reads the cursor's own second, see below)
6. Exclude: bot's own comments; comments with `created_at > maxUpdatedAt` (above window); comments with `created_at < windowSince`, and those of the `windowSince` second that the previous window read, or all of them when the cursor has no record of that second (below window)
7. Process: mention detection → envelope → `handleInbound`

The effective comment window is `(windowSince, maxUpdatedAt]`, plus the comments of the `windowSince` second that the previous window did not read when the cursor records that second (see below). Comments processed in a previous window have `created_at <= windowSince` (that window's `maxUpdatedAt`) and are excluded: those of earlier seconds by the bound, and those of the `windowSince` second by the list of them that the previous window read, saved with the cursor. A comment taken by an earlier poll of the same window (one held over several polls) is kept from a second dispatch by the dedupe ring of taken comments. This prevents duplicates regardless of whether `PUT /notifications` succeeded. Comment edits do not re-trigger processing — only `created_at` is used for window membership. A comment of the `windowSince` second that the previous window did not read is evaluated again on every read until the cursor moves on, so an edit that adds a mention in that time is answered.

The global mark is still called (step 3) to clean up non-issue/PR notifications and reduce the unread list, but it is not load-bearing for dedup.

### The Cursor's Own Second

GitHub stamps comments and notifications to the second, and the cursor is the `updated_at` of the newest notification of the window that advanced it. A notification can arrive after that window was marked read and still carry the cursor's second, naming a comment of that second on a thread the window did not list. Starting the next window after the cursor's second would exclude that comment on every later read.

So when a window is marked read, the cursor saves `boundaryComments`: the keys (node IDs) of the comments created in the new cursor's second that the window read, and the threads whose notification of that second the window listed and did not filter out, at most 500 of each. The next window reads that second again and leaves out only those comments before a lane handles them, so a comment of that second it has not read is processed once, and the ones it read are not taken again. Comments are listed from a second before the cursor, as notifications are, so the second is included whatever GitHub's `since` does at its boundary. A notification stamped with the cursor's second for a thread the window did not list is a late one and can name such a comment, so it is not treated as a stale re-listing while a newer window waits to be marked read: a 5xx reading it holds that window, until the window has read the thread once; after that it is stale again, so a comment of that second that GitHub did not list yet when the thread was read is read only if a later read succeeds. One for a listed thread is treated as a re-listing whose mark-as-read did not apply, and stays stale as before; if it carries a comment posted in that second after the window read the thread, the comment is still read when the thread is read, but a 5xx then does not hold the window for it. While no newer window waits, nothing is marked read, so a 5xx reading it before the window has read the thread spends none of the window's retry budget and is journaled as `failed`: the thread is read again.

Without a record for the cursor (a cursor saved by a version without it, or more than 500 such comments), the window starts after the cursor's second as before, and a notification stamped with that second is a stale re-listing; the first cursor is the start time with milliseconds, which no GitHub timestamp equals. The dedupe ring keeps the keys of comments created in the cursor's second, so a comment of that second taken by a window that stays held is not taken again when the window reads it again. The list is written only when the cursor advances and holds only what the current process read, so two kinds of comment of that second are left to the ring, which keeps them from being taken again (a lane that takes comments one by one journals a `duplicate` skip once per window; the batch of a followed thread leaves them out silently): a late comment taken after the list was written, read again on every poll while its notification stays unread until the cursor moves on, and, after a restart in the middle of a held window, a comment taken before the restart.

### Known Limitation: Late Notification Delivery

Because the cursor is global (not per-thread), a notification that arrives in a later poll than its comments' `created_at` can have those comments excluded by the cursor window. This requires notification delivery to be delayed across a poll boundary AND another thread's comments to advance the cursor past them in the interim. Comments of the cursor's own second are read again when the cursor records that second (see above); comments of earlier seconds are not. In practice this window is narrow (notification delivery typically completes within one poll interval); the user can re-mention to retry.

### Known Limitation: PR Review Comments

`issues.listComments` returns only general conversation comments, not PR review comments (per-line diff comments). An @-mention in a PR review comment is silently dropped. Use a general conversation comment on the PR instead.

### Scenario Behavior

| Scenario                          | Behavior                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| New thread (@bot in comment)      | Appears (unread) → enumerate since cursor → process                                                                           |
| Existing thread, new comment      | Reappears (unread) → enumerate since cursor → old comments excluded below the window → only new                               |
| Late notification, cursor second  | Appears (unread) → enumerate from a second before the cursor → comment the last window did not read → process                 |
| Non-comment activity (push/label) | Appears → zero new comments in window → skip                                                                                  |
| User marks read on github.com     | Disappears from API → not processed                                                                                           |
| markNotificationsAsRead fails     | Cursor window still prevents duplicates → no impact on correctness                                                            |
| Crash after markRead, before done | Cursor not saved → next startup re-fetches same notifications → crashed batch re-processed, not lost                          |
| Bot replies to a thread           | `updated_at` bumped → notification may stay unread → next poll fetches it → comments excluded by cursor window → no duplicate |
| New issue with @bot in body       | No comments → body contains mention → feed body as trigger (deduped via `dispatchedBodies`)                                   |

## PollingChannelBase

`PollingChannelBase<Cursor>` (in `packages/channels/base/`) extends `ChannelBase` and provides the poll loop infrastructure:

- **Poll loop**: start/stop via `startPollLoop()`/`stopPollLoop()`, called from `connect()`/`disconnect()`
- **Poll interval**: read from channel config `pollInterval` (ms), validated as a positive finite number, clamped to a maximum of 86400000 (one day), defaults to 60000. The clamp exists because Node clamps a timeout above its 32-bit range to 1ms, which would turn the loop into a hot loop; values between one day and that limit are clamped rather than replaced, so a previously honoured interval is not silently multiplied
- **Cursor persistence**: JSON cursor saved atomically after each successful `pollOnce()`; loaded on construction (corrupt or unparseable date → fallback to `createInitialCursor()`)
- **Cursor validation**: `validateCursor()` virtual hook — base rejects non-objects and arrays; subclasses add shape checks (e.g. GitHub rejects missing/invalid `lastProcessedAt` date)
- **Backoff**: exponential 2s → 30s on poll errors, reset on success
- **Abortable sleep**: `abortableSleep(ms)` exposed as a protected method — poll interval and error backoff are interruptible via `disconnect()`

Subclasses implement only:

- `pollOnce()` — do the work, mutate `this.cursor`
- `createInitialCursor()` — first-run default value

The `Cursor` generic is any JSON-serializable object. GitHub's cursor holds `lastProcessedAt` and dedupe records such as `dispatchedBodies` (first-contact body dedup, bounded to the most recent 500 entries) and `boundaryComments` (see [The Cursor's Own Second](#the-cursors-own-second)).

## Mention Detection

Body-based, case-insensitive regex. Separate functions for detection (`testBotMention`) and stripping (`stripBotMention`):

- Detection: explicit regex match returning boolean — never inferred from strip-before/after comparison (whitespace differences cause false positives)
- Stripping: removes only `@bot`, preserves all other formatting (no whitespace collapsing)

## Session Scope

Polling adapters use `chat_thread` scope: routing key = `channel:chatId:threadId`. This prevents cross-repo session collision (`repo-a/issue:42` vs `repo-b/issue:42`).

## Error Handling

Delivery is **best-effort**. Each public dispatch is a persisted task: on a `handleInbound` failure the task is run again on later polls, up to three attempts in all (each crash during the last runs it once more), and one error comment is posted when the last attempt fails; the user re-mentions to retry. A failure after which the task runs again posts no error comment, since that comment asks the user to mention the bot again. A failed publication of the final reply is the exception when the reply may already be on GitHub, or waits as a pending delivery: that task is not run again and posts no error comment. A reply that GitHub refused and that could not be queued for retry counts as an ordinary failure. Per-notification API errors use `continue` — one failed notification does not block the rest of the batch. Notifications without a `subject.url` (Discussion, SecurityAlert types) are skipped silently.

If the process crashes mid-processing, the cursor is not saved (it is persisted only after `pollOnce()` completes), so the next startup re-fetches the same notifications — but the cursor-based comment window excludes already-processed comments, preventing duplicates.

Duplicate prevention does **not** depend on `PUT /notifications` succeeding. The global mark is best-effort cleanup; the cursor window is the load-bearing dedup mechanism.
