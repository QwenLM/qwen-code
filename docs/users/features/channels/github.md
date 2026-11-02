# GitHub

This guide covers setting up a Qwen Code channel that monitors GitHub notifications and responds to mentions, review requests, assignments, and followed-thread activity.

## Prerequisites

- A GitHub account authenticated with the permissions needed to read notifications and post comments
- The [GitHub CLI](https://cli.github.com/) installed on the host running Qwen Code when using local `gh` authentication

Use a dedicated bot account when the authenticated account also needs to operate the channel. GitHub does not generate a usable notification for the account's own activity, and the adapter ignores its own comments to prevent reply loops.

## Authentication

To reuse the GitHub CLI login on the Qwen Code host, authenticate `gh` and explicitly set `useLocalGh: true` in the channel configuration:

```bash
gh auth login
```

Local `gh` authentication is account-wide and may expose notifications from every repository visible to that GitHub account. Enable it only when the workspace operator is trusted to use that account. Otherwise, configure a dedicated PAT.

For GitHub Enterprise Server, authenticate the same host used by `baseUrl`:

```bash
gh auth login --hostname github.example.com
```

You can instead configure a classic personal access token (PAT). An explicit `token` overrides local `gh` authentication. The PAT needs these scopes:

- **notifications** — read notification threads
- **public_repo** (or **repo** for private repos) — post comments

## Configuration

Add the channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-github": {
      "type": "github",
      "useLocalGh": true,
      "pollInterval": 60000,
      "reasonFilter": ["mention", "review_requested", "assign"],
      "operators": ["operator-github-username"],
      "sessionScope": "chat_thread",
      "cwd": "/path/to/your/project",
      "groupPolicy": "open",
      "groups": {
        "*": {
          "requireMention": true,
          "senders": "allowlist",
          "allowedUsers": ["operator-github-username"]
        }
      }
    }
  }
}
```

To override local `gh` authentication with a PAT, add `"token": "$GITHUB_TOKEN"` to the channel and set the environment variable before starting Qwen Code:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

The authenticated account cannot trigger its own channel. If that account needs to operate the channel, authenticate a separate bot account and put their usernames in the group `allowedUsers` and explicit `operators` lists. Startup warns when a group allowlist contains the authenticated account, which cannot trigger tasks; use a different account in the group allowlist.

### GitHub Enterprise

For GitHub Enterprise Server, set `baseUrl`:

```json
{
  "baseUrl": "https://github.example.com/api/v3"
}
```

Local `gh` authentication requires an HTTPS `baseUrl` so the daemon host credential cannot be sent over plaintext HTTP.

## Configuration Options

| Option                    | Default                  | Description                                                                                                                                         |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`                   | unset                    | Optional classic PAT with `notifications` scope; overrides local `gh` authentication                                                                |
| `useLocalGh`              | `false`                  | Explicitly reuse the daemon host's account-wide GitHub CLI authentication                                                                           |
| `pollInterval`            | `60000`                  | Poll interval in ms                                                                                                                                 |
| `baseUrl`                 | `https://api.github.com` | API base URL (for GHE)                                                                                                                              |
| `groupPolicy`             | `"disabled"`             | Must be `"open"`, `"allowlist"` with the repo (`owner/repo`) listed in `groups`, or `"pairing"` with the repo approved for notifications to flow    |
| `groups.*.requireMention` | `true`                   | Require @mentions for ordinary comments; directed notification reasons still run                                                                    |
| `reasonFilter`            | unset                    | Optional allowlist of GitHub notification reasons to process                                                                                        |
| `deliverToBoundSessions`  | `false`                  | Deliver events for PRs bound to a live session into that session as a prompt instead of a channel-owned session (daemon-managed channels only)      |
| `prWatchEvents`           | unset                    | Optional state transitions to watch for bound PRs: `ci_failure`, `merge_conflict`, `head_change`, `state_change`. Requires `deliverToBoundSessions` |

Use `reasonFilter` to drop noisy notification classes such as `ci_activity` or `state_change`. Do not use `reasonFilter: ["mention"]` as a replacement for `groups.*.requireMention`: GitHub's `mention` reason is sticky at the thread level, so real new @mentions can arrive later under `comment`, `subscribed`, `author`, or other reasons and would be skipped.

Valid `reasonFilter` values are `mention`, `review_requested`, `assign`, `author`, `comment`, `ci_activity`, `manual`, `state_change`, `subscribed`, `team_mention`, `security_alert`, `approval_requested`, `invitation`, `member_feature_requested`, and `security_advisory_credit`.

Filtered notifications are marked read only after all accepted work in the poll window completes. Removing the filter later will not replay notifications the channel already skipped.

## ⚠️ Security

On a **public repository**, setting `groups: { "*": { "senders": "open" } }` allows **any GitHub user** who triggers a supported notification reason to submit prompts that drive the agent in your `cwd`. This includes reading code, spending tokens, posting comments, and (subject to permission policy) running tools.

Always use `groups["*"].senders: "allowlist"` with explicit group `allowedUsers` on public repos.

All GitHub traffic is group traffic. Group members default to `open`; set `groups["*"].senders` to `allowlist` and populate its `allowedUsers` to restrict authors. Private policy and user pairing never restrict repository members. Set `operators` explicitly for shared-session management.

Group member allowlists and operator lists follow the **username**, not the immutable account ID. If a listed user renames their GitHub account, remove the stale entry — GitHub releases the old username for anyone else to claim, and the new holder would inherit that authorization.

Note that under `groupPolicy: "pairing"`, access is granted per repository: once a repository is approved, **any GitHub user** can by default drive the bot through that repository's issues and pull requests. All GitHub traffic is group traffic, so `privatePolicy` and the top-level `allowedUsers` do not gate members of an approved repository; set `senders: "allowlist"` with `allowedUsers` on that repository's `groups` entry to narrow it. Approvals are keyed by the repository full name (`owner/repo`), which changes on rename or transfer — revoke stale group approvals after any repository rename, transfer, or deletion.

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

The GitHub channel publishes only completed responses. Intermediate model chunks are never published as separate comments.

If GitHub returns a definite no-write delivery failure, such as a rate-limit
response, the channel stores the final reply in
`~/.qwen/channels/<workspace-scope>/<channel>-<name-hash>-github-pending-deliveries.json`
with private file permissions and retries it on the next channel start. The
corresponding inbound task remains in `reply_pending` state until that delivery
succeeds or reaches a definite terminal failure. Ambiguous delivery failures are
not retried automatically because GitHub may have created the comment.

## PR-Bound Session Delivery

By default every event is handled by a channel-owned session. With
`deliverToBoundSessions: true`, events for a PR that is bound to a live session
(the PR bindings shown in the Web Shell sidebar, registered when a session
creates or reviews a PR) are delivered into that session as a prompt instead,
so the session that follows the PR handles the event with its existing context.

- The injected prompt marks all GitHub content as untrusted event data. The
  session's reply stays in the session; it is **not** published to GitHub
  automatically, and the session may act on GitHub through its own tools.
- Comment sender gates still apply before delivery. When several sessions are
  bound to the same PR, the most recently updated non-archived session wins;
  channel-owned sessions are never candidates.
- When no bound session exists (or it cannot be restored), **comment** events
  fall back to the normal channel path and its public-reply contract. A bound
  session that is dormant after a daemon restart is woken automatically for
  the delivery, so restarts do not divert events into public replies.
  **Watch events (below) are private-only**: with no bound target they are
  logged and retired, never published as PR comments.
- A full prompt queue or a temporarily unavailable session defers the event
  without consuming the retry budget; the deferral is bounded (240 consecutive
  deferrals — ~4 hours at the default 60s poll, and proportionally longer with
  a larger `pollInterval`), and events that exhaust it are retired to a private
  dead-letter log (`github-bound-deadletter.jsonl` in the channel state
  directory) with a stderr alert rather than silently dropped.
- This feature requires a daemon-managed channel; standalone
  `qwen channel start` ignores the setting with a warning.

With `prWatchEvents`, the channel additionally watches bound PRs for state
transitions the Notifications API cannot deliver, inside its existing poll
cycle: `ci_failure` (checks turn red on a head, once per head — including
`startup_failure`), `merge_conflict` (`mergeable_state` becomes `dirty`,
edge-triggered: `dirty → clean → dirty` fires again), `head_change` (new commits
pushed, including a force-push revisit of a recent SHA), and `state_change`
(PR merged or closed; close → reopen → close fires again). Detection is
API-level and spends no model tokens until a transition fires. A quiet PR with
settled CI costs one API call per poll; a PR whose CI is still pending is
re-checked every poll, and settled heads are re-checked every 10 minutes
(GitHub does not advance a PR's `updated_at` on check re-runs, so the periodic
re-check is what catches a re-run turning red). At most 30 bound PRs are
actively polled; CI-active bursts add check-list pages and can exceed the
5 000 calls/hour token budget on large-CI repos — the watch then fails fast on
rate limiting and retries next poll. Transitions are persisted before
delivery, so restarts do not re-fire them.

## Known Limitations

- **First start skips existing unread notifications.** The cursor initializes to "now" on first launch. Notifications created before the bot starts are not processed unless the thread receives new activity afterwards.
- If a user marks a notification as read on github.com before the bot's poll cycle, the bot will not process it.
- The bot does not read comments before the current polling window; `author` and `comment` notifications may aggregate up to 20 comments from that window.
- Inline PR review comments and review summary bodies are not enumerated; only issue/PR comments are processed.
- The selected credential must support the Notifications API. Fine-grained PATs do not support it; use local `gh` authentication or a classic PAT with `notifications` scope.

## Starting the Channel

```bash
qwen channel start my-github
```
