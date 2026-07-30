# GitHub

This guide covers setting up a Qwen Code channel that monitors GitHub notifications and responds to mentions, review requests, assignments, and followed-thread activity.

## Prerequisites

- A GitHub account for the channel. Use a dedicated bot account when the PAT
  owner also needs to operate the channel.
- A GitHub Personal Access Token (PAT) with `notifications` and `public_repo` (or `repo`) scopes

## Creating a Token

1. Go to **Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Generate a token with these scopes:
   - **notifications** — read notification threads
   - **public_repo** (or **repo** for private repos) — post comments
3. Save the token securely as an environment variable

## Configuration

Add the channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-github": {
      "type": "github",
      "token": "$GITHUB_TOKEN",
      "pollInterval": 60000,
      "reasonFilter": ["mention", "review_requested", "assign"],
      "senderPolicy": "allowlist",
      "allowedUsers": ["operator-github-username"],
      "sessionScope": "chat_thread",
      "cwd": "/path/to/your/project",
      "blockStreaming": "off",
      "groupPolicy": "open",
      "groups": {
        "*": { "requireMention": true }
      }
    }
  }
}
```

Set the token as an environment variable:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

The PAT owner cannot trigger its own channel: GitHub self-activity does not
provide a usable notification, and the adapter intentionally ignores its own
comments to prevent reply loops. If the PAT owner needs to operate the channel,
use a separate bot-owned PAT and put only operator accounts in `allowedUsers`.
Startup rejects an allowlist containing only the PAT owner and warns when the
PAT owner appears alongside other operators.

### GitHub Enterprise

For GitHub Enterprise Server, set `baseUrl`:

```json
{
  "baseUrl": "https://github.example.com/api/v3"
}
```

## Configuration Options

| Option                    | Default                  | Description                                                                                   |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `token`                   | (required)               | Classic PAT with `notifications` scope                                                        |
| `pollInterval`            | `60000`                  | Poll interval in ms                                                                           |
| `baseUrl`                 | `https://api.github.com` | API base URL (for GHE)                                                                        |
| `groupPolicy`             | `"disabled"`             | Must be `"open"` for notifications to flow                                                    |
| `senderPolicy`            | `"allowlist"`            | Who can trigger the bot                                                                       |
| `groups.*.requireMention` | `true`                   | Require @mentions for ordinary comments; directed notification reasons still run              |
| `blockStreaming`          | `"off"`                  | Always forced to `"off"`; intermediate model chunks aren't published; `"on"` is not supported |
| `reasonFilter`            | unset                    | Optional allowlist of GitHub notification reasons to process                                  |

Use `reasonFilter` to drop noisy notification classes such as `ci_activity` or `state_change`. Do not use `reasonFilter: ["mention"]` as a replacement for `groups.*.requireMention`: GitHub's `mention` reason is sticky at the thread level, so real new @mentions can arrive later under `comment`, `subscribed`, `author`, or other reasons and would be skipped.

Valid `reasonFilter` values are `mention`, `review_requested`, `assign`, `author`, `comment`, `ci_activity`, `manual`, `state_change`, `subscribed`, `team_mention`, `security_alert`, `approval_requested`, `invitation`, `member_feature_requested`, and `security_advisory_credit`.

Filtered notifications are still marked read before they are skipped. Removing the filter later will not replay notifications the channel already skipped.

## ⚠️ Security

On a **public repository**, setting `senderPolicy: "open"` allows **any GitHub user** who triggers a supported notification reason to submit prompts that drive the agent in your `cwd`. This includes reading code, spending tokens, posting comments, and (subject to permission policy) running tools.

Always use `senderPolicy: "allowlist"` with explicit `allowedUsers` on public repos.

Allowlist and pairing entries follow the **username**, not the immutable account ID. If an allowlisted user renames their GitHub account, remove the stale entry — GitHub releases the old username for anyone else to claim, and the new holder would inherit the allowlist/pairing authorization.

## Mention Detection

The adapter detects mentions by scanning comment text and first-contact issue or PR bodies for `@bot-username` using a case-insensitive regex. It does not trust `reason: "mention"` alone because that value is sticky at the thread level. Other reasons select review, triage, followed-thread, or fallback prompts.

## How It Works

The adapter uses GitHub's Notifications API as a wake-up signal:

1. **Poll** `GET /notifications` for unread threads
2. **Mark read** via `markNotificationsAsRead` (best-effort cleanup, before processing)
3. **Enumerate** comments via `listComments` within a cursor-based time window
4. **Dispatch** by notification reason: strict mention matching, pull request review, issue triage, followed-thread comment aggregation, or per-comment fallback
5. **First-contact fallback**: a brand-new unread issue/PR body can be processed when no comment was dispatched; mention notifications still require an actual body mention

The comment window is `(previousCursor, currentMaxUpdatedAt]` — comments already eligible in a previous poll cycle are excluded by the cursor, preventing duplicate replies even when the async mark-read has not taken effect. If the process crashes mid-processing, the user can re-mention the bot to retry.

Non-comment activity (push, label changes) bumps the notification's `updated_at` but produces zero new comments in the window, so re-fetched threads are skipped without triggering the agent.

## Response Feedback

For an accepted issue or pull-request comment, the channel adds GitHub's `👀` reaction while the agent is working, then removes it when the run completes, fails, or is cancelled. Both operations are best-effort: a reaction API or permission failure is logged and never prevents the final response.

### Final-only output

The GitHub channel always forces final-only delivery. The adapter sets `blockStreaming` to `"off"`, so intermediate model chunks are never published as separate comments and `blockStreaming: "on"` is not supported.

```json
{
  "blockStreaming": "off"
}
```

## Known Limitations

- **First start skips existing unread notifications.** The cursor initializes to "now" on first launch. Notifications created before the bot starts are not processed unless the thread receives new activity afterwards.
- If a user marks a notification as read on github.com before the bot's poll cycle, the bot will not process it.
- The bot does not read comments before the current polling window; `author` and `comment` notifications may aggregate up to 20 comments from that window.
- Inline PR review comments and review summary bodies are not enumerated; only issue/PR comments are processed.
- Requires a classic PAT with `notifications` scope. Fine-grained PATs do not support the notifications API.

## Starting the Channel

```bash
qwen channel start my-github
```
