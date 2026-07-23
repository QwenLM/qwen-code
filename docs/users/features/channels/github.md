# GitHub

This guide covers setting up a Qwen Code channel that monitors GitHub notifications and responds to mentions on issues and pull requests.

## Prerequisites

- A GitHub account (or a dedicated bot account)
- A GitHub Personal Access Token (PAT) with `notifications` and `public_repo` (or `repo`) scopes

## Creating a Token

1. Go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens** (or classic)
2. Generate a token with these permissions:
   - **Notifications**: Read
   - **Issues**: Read and write (to post comments)
   - **Pull requests**: Read and write (to post comments)
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
      "senderPolicy": "allowlist",
      "allowedUsers": ["your-github-username"],
      "sessionScope": "chat_thread",
      "cwd": "/path/to/your/project",
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

### GitHub Enterprise

For GitHub Enterprise Server, set `baseUrl`:

```json
{
  "baseUrl": "https://github.example.com/api/v3"
}
```

## Configuration Options

| Option           | Default                  | Description                                |
| ---------------- | ------------------------ | ------------------------------------------ |
| `token`          | (required)               | GitHub PAT or fine-grained token           |
| `pollInterval`   | `60000`                  | Poll interval in ms (minimum 60000)        |
| `baseUrl`        | `https://api.github.com` | API base URL (for GHE)                     |
| `requireMention` | `true`                   | Only respond when @mentioned               |
| `groupPolicy`    | `"disabled"`             | Must be `"open"` for notifications to flow |
| `senderPolicy`   | `"allowlist"`            | Who can trigger the bot                    |

## ⚠️ Security

On a **public repository**, setting `senderPolicy: "open"` allows **any GitHub user** who @mentions the bot to submit prompts that drive the agent in your `cwd`. This includes reading code, spending tokens, posting comments, and (subject to permission policy) running tools.

Always use `senderPolicy: "allowlist"` with explicit `allowedUsers` on public repos.

## Mention Detection

The adapter detects mentions by scanning the **comment body** for `@bot-username` using a case-insensitive regex. It does NOT rely on GitHub's notification `reason` field, which is a sticky thread-level value that doesn't reflect per-comment mentions.

## How It Works

The adapter uses GitHub's Notifications API as a wake-up signal:

1. **Poll** `GET /notifications` for unread threads
2. **Enumerate** comments via `listComments` using `last_read_at` as the per-thread watermark
3. **Process** each new comment (mention detection, envelope building)
4. **Mark read** via `markThreadAsRead` (advances `last_read_at`)

Non-comment activity (push, label changes) bumps the notification's `updated_at` but does not change `last_read_at`, so re-fetched threads with zero new comments are skipped without triggering the agent.

## Known Limitations

- If a user marks a notification as read on github.com before the bot's poll cycle, the bot will not process it.
- If `markThreadAsRead` fails (network error), the next poll re-enumerates the same comments. An in-memory dedup set prevents duplicate dispatch within the same process, but a restart between failure and re-poll may cause one duplicate reply.
- The bot does not read prior conversation history — only the triggering comment is processed.

## Starting the Channel

```bash
qwen channel start my-github
```
