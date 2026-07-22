# Code Hosting Channel Adapters

> GitHub, GitLab, and Gitea polling channel adapters for Qwen Code.
>
> User documentation: [GitHub](../../users/features/channels/github.md), [GitLab](../../users/features/channels/gitlab.md), [Gitea](../../users/features/channels/gitea.md).

## Overview

Three new polling-based channel adapters extend the channel system from real-time IM platforms to code hosting platforms. Instead of receiving messages via webhooks or long-poll, these adapters **poll** the platform's notification API at a configurable interval and convert each notification into an inbound message envelope.

| Adapter | Platform API               | Notification unit   | Thread format       |
| ------- | -------------------------- | ------------------- | ------------------- |
| GitHub  | Notifications + Issues/PRs | Notification thread | `issue:42`, `pr:17` |
| GitLab  | Todo list                  | Todo entry          | `issue:42`, `mr:17` |
| Gitea   | Notifications + Issues/PRs | Notification thread | `issue:42`, `pr:17` |

## Architecture

```
                    Poll interval (default 60s)
                    ┌────────────────────────────┐
                    │                            ▼
┌──────────────┐   ┌────────────────┐    ┌──────────────┐
│ GitHub API   │◄──┤                │    │  ChannelBase │
│ GitLab API   │   │  Polling Loop  │    │  (shared)    │
│ Gitea API    │   │                │    │              │
└──────────────┘   │  - fetch       │    │  - senderGate│
                   │  - build       │───►│  - groupGate │
                   │    envelope    │    │  - session   │
                   │  - advance     │    │    router    │
                   │    cursor      │    │  - ACP bridge│
                   └────────────────┘    └──────────────┘
                          │
                          ▼
                   ┌────────────────┐
                   │  Poll Cursor   │
                   │  ~/.qwen/      │
                   │  channels/     │
                   │  {name}-poll-  │
                   │  cursor.txt    │
                   └────────────────┘
```

Unlike IM adapters that override `sendMessage`, polling adapters override `sendThreadMessage` — the thread-aware delivery method. `sendMessage` throws in all three adapters since delivery without a thread target (issue/PR) is not meaningful for code hosting platforms.

## ChatId and ThreadId Design

Polling adapters use a repository-per-chat, issue-per-thread model:

- **`chatId`** — the repository path (`owner/repo` for GitHub/Gitea, `group/project` for GitLab). Pure structural identifier, no platform-specific encoding.
- **`threadId`** — the issue or pull/merge request, prefixed by type: `issue:42`, `pr:17`, `mr:789`.

This differs from IM adapters where `chatId` is a platform-specific chat identifier and `threadId` is optional. For polling adapters, both fields are always present (when the notification target is resolvable) and are structural — they directly map to API endpoints.

## Session Scope: `chat_thread`

A new `SessionScope` value `chat_thread` was introduced for polling adapters. It produces routing keys that include `chatId` to prevent cross-repository session collision:

| Scope         | Routing key format (with threadId)   | Routing key format (no threadId) |
| ------------- | ------------------------------------ | -------------------------------- |
| `user`        | `${channel}:${senderId}:${chatId}`   | same                             |
| `thread`      | `${channel}:${threadId \|\| chatId}` | same                             |
| `chat_thread` | `${channel}:${chatId}:${threadId}`   | `${channel}:${chatId}`           |
| `single`      | `${channel}:__single__`              | same                             |

### Why not reuse `thread` scope?

The original `thread` scope uses `${channel}:${threadId || chatId}`. This works for IM platforms where thread IDs are globally unique (e.g., Feishu `root_id`) or scoped to a single chat (e.g., Telegram forum topics). For polling adapters, thread IDs like `issue:42` are **local to a repository** — `repo-a/issue:42` and `repo-b/issue:42` would collide on the same session key `github:issue:42`.

The `chat_thread` scope includes `chatId` (the repository path) in the key, producing `github:owner/repo:issue:42` — unique across repositories.

### Backward compatibility

The `thread` scope retains its original key format. Existing IM adapters (Telegram, Feishu, WeCom) using `sessionScope: "thread"` are unaffected — their persisted session routes continue to work without migration.

## Polling Loop

Each adapter runs a poll loop in `connect()`:

```
connect()
  ├── resolve bot identity (best-effort, non-fatal)
  ├── start poll loop (background, abortable)
  └── return immediately

poll loop:
  while !aborted:
    try:
      pollNotifications()
      consecutiveErrors = 0
    catch:
      consecutiveErrors++
      backoff (2s → 30s after 3 consecutive errors)
    sleep(pollInterval)
```

### Poll Notifications

1. **Fetch** — call platform API with `since` / `updated_after` parameter derived from cursor (minus 1s buffer for clock skew)
2. **Sort** — by `updated_at` ascending for deterministic processing order
3. **Dedup** — skip entries older than cursor timestamp; skip same-timestamp entries already in `processedIdsAtCursor` set
4. **Build envelope** — extract sender, chatId, threadId, metadata, mention status
5. **Dispatch** — call `handleInbound(envelope)` (inherited from ChannelBase)
6. **Advance cursor** — persist new timestamp + processed ID set
7. **Mark read** — best-effort API call to mark notification as read / dismiss todo

### Cursor Persistence

Poll cursors are persisted to `~/.qwen/channels/{encodedName}-poll-cursor.txt`:

```
2026-07-21T12:00:00Z        ← timestamp (ISO 8601)
1,5,42                      ← processed IDs at this timestamp (comma-separated)
```

The two-line format handles same-timestamp deduplication: when multiple notifications share the same `updated_at`, the ID set tracks which ones have been processed. On cursor advance to a new timestamp, the set resets to contain only the new ID.

**First-start behavior**: when no cursor file exists, the cursor is seeded to the current time (`new Date().toISOString()`) to avoid processing the entire notification history. This means notifications that arrived before the adapter was first started are not processed.

**Atomic writes**: cursor updates use write-to-temp + `renameSync` to prevent corruption from partial writes during crashes.

## Sender Resolution

Polling adapters resolve the sender (the person who triggered the notification) from the platform API:

| Adapter | Strategy                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------- |
| GitHub  | Fetch `latest_comment_url` → comment author; fallback to issue/PR author; fallback to `ghost`   |
| GitLab  | Use `todo.author.username` directly                                                             |
| Gitea   | Fetch `latest_comment_url` → comment author; fallback to issue/PR author; fallback to repo name |

GitHub and Gitea require additional API calls (1–2 per notification) to resolve the sender. In the worst case, a batch of 100 notifications triggers up to 200 additional API calls.

## Metadata

Each adapter attaches structured metadata to the envelope via the `Envelope.metadata` field:

```
Type: PullRequest
Title: Fix login page regression
URL: https://github.com/owner/repo/pull/42
Branch: fix/login-regression
```

Metadata is separated from `text` so that slash command parsing operates on the comment body alone. `ChannelBase.processInbound` appends metadata to the prompt text after command parsing, sanitized via `sanitizePromptText` to prevent prompt injection through attacker-controlled issue titles.

## Mention Detection

| Adapter | isMentioned                                          | isReplyToBot                                              |
| ------- | ---------------------------------------------------- | --------------------------------------------------------- |
| GitHub  | `reason` is `mention` or `team_mention`              | `reason` is `author`                                      |
| GitLab  | `action_name` is `mentioned` or `directly_addressed` | N/A (always false)                                        |
| Gitea   | Regex: `@botUsername` found in comment body          | N/A (always false — `gitea-js` type lacks `reason` field) |

`stripBotMention(text, botUsername)` removes only the bot's own `@mention` from the comment body, preserving third-party mentions as agent context.

## Error Handling

- **handleInbound failure** — reply with error message on the thread, advance cursor (prevents infinite reprocessing)
- **API errors** — exponential backoff (2s → 30s after 3 consecutive failures), polling continues
- **Bot identity unavailable** — degrade gracefully (`botUsername = null`), `isMentioned` becomes conservative (always false for Gitea regex-based detection)
- **Corrupt cursor file** — treated as missing; cursor re-seeds to current time

## Known Limitations (MVP)

- **`latest_comment_url` only fetches one comment** — if multiple comments arrive between polls on the same thread, only the latest is processed. The notification API returns mutable thread state, not individual comment events. A future iteration will use notifications as wake-up signals and enumerate comments via `listComments` since the last processed comment ID.
- **No media processing** — issue/PR body text and comment text are processed, but attached images and files are ignored.
- **No webhook mode** — polling is the only supported mode. Webhook-based delivery (for GitHub Apps, GitLab system hooks) is a potential future enhancement.
