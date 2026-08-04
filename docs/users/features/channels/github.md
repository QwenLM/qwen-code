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

Filtered notifications are marked read only after all accepted work in the poll window completes. Removing the filter later will not replay notifications the channel already skipped.

## ⚠️ Security

On a **public repository**, setting `senderPolicy: "open"` allows **any GitHub user** who triggers a supported notification reason to submit prompts that drive the agent in your `cwd`. This includes reading code, spending tokens, posting comments, and (subject to permission policy) running tools.

Always use `senderPolicy: "allowlist"` with explicit `allowedUsers` on public repos.

Allowlist and pairing entries follow the **username**, not the immutable account ID. If an allowlisted user renames their GitHub account, remove the stale entry — GitHub releases the old username for anyone else to claim, and the new holder would inherit the allowlist/pairing authorization.

## Mention Detection

The adapter detects mentions by scanning comment text and first-contact issue or PR bodies for `@bot-username` using a case-insensitive regex. It does not trust `reason: "mention"` alone because that value is sticky at the thread level. Other reasons select review, triage, followed-thread, or fallback prompts.

## How It Works

The adapter uses GitHub's Notifications API as a wake-up signal:

1. **Poll** `GET /notifications` for unread threads
2. **Enumerate** comments via `listComments` within a cursor-based time window
3. **Persist accepted work** before dispatch, including the source envelope and deduplication keys
4. **Dispatch** by notification reason: strict mention matching, pull request review, issue triage, followed-thread comment aggregation, or per-comment fallback
5. **Commit the poll window** only after accepted work completes: mark notifications read and advance the cursor
6. **First-contact fallback**: a brand-new unread issue/PR body can be processed when no comment was dispatched; mention notifications still require an actual body mention

The comment window is `(previousCursor, currentMaxUpdatedAt]`. Accepted, running, and failed tasks are stored under `~/.qwen/channels/<workspace-scope>/` with private file permissions. On restart, the channel recovers those tasks before polling GitHub again. Failed tasks are attempted up to three times, then become terminal; cancelled tasks are terminal and are not rerun. A task whose final reply was already posted, suppressed, or queued for definite no-write retry is not rerun.

The notification cursor does not advance while recoverable tasks remain, or when inbound task state cannot be read or written. This prevents a crash or agent failure from losing an accepted comment and preserves the deduplication keys needed to avoid a second dispatch from the notification feed.

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

If GitHub returns a definite no-write delivery failure, such as a rate-limit
response, the channel stores the final reply in
`~/.qwen/channels/<workspace-scope>/<channel>-<name-hash>-github-pending-deliveries.json`
with private file permissions and retries it on the next channel start. The
corresponding inbound task remains in `reply_pending` state until that delivery
succeeds or reaches a definite terminal failure. Ambiguous delivery failures are
not retried automatically because GitHub may have created the comment.

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
