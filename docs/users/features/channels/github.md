---

# GitHub

This guide covers setting up a Qwen Code channel on GitHub. The GitHub channel polls your notifications and responds to issues and pull requests as comments.

## Prerequisites

- A GitHub account
- A GitHub personal access token (see below)

## Creating a Token

1. Go to **Settings → Developer settings → [Personal access tokens → Tokens (classic)](https://github.com/settings/tokens)**
2. Click **Generate new token**
3. Select the `notifications` scope (to read and mark notifications) and the `repo` scope (to read issues/PRs and post comments)
4. Save the token securely

For GitHub Enterprise, set `baseUrl` to your instance's API URL (e.g., `https://github.example.com/api/v3`).

## Configuration

Add the channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-github": {
      "type": "github",
      "token": "$GITHUB_TOKEN",
      "groupPolicy": "open",
      "sessionScope": "thread",
      "cwd": "/path/to/your/repo",
      "senderPolicy": "allowlist",
      "allowedUsers": ["your-github-username"],
      "pollInterval": 30000
    }
  }
}
```

Set the token as an environment variable:

```bash
export GITHUB_TOKEN=<your-personal-access-token>
```

Or add it to a `.env` file that gets sourced before running.

### Configuration Options

| Option         | Description                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `token`        | GitHub personal access token. Supports `$ENV_VAR` syntax                                                            |
| `baseUrl`      | API base URL. Defaults to `https://api.github.com`. Set to your GitHub Enterprise API URL for self-hosted instances |
| `pollInterval` | Poll interval in milliseconds. Defaults to `60000` (60 seconds)                                                     |

## Running

```bash
# Start only the GitHub channel
qwen channel start my-github

# Or start all configured channels together
qwen channel start
```

When someone opens an issue or comments on a pull request where you're mentioned, the agent picks it up on the next poll cycle and posts a response as a comment on the same issue or pull request. Processed notifications are automatically marked as read.

## How It Works

Unlike the messaging-platform channels that receive messages in real time, the GitHub channel **polls** the [Notifications API](https://docs.github.com/en/rest/activity/notifications) at a fixed interval. Each notification is converted into a message:

- **`chatId`** — the repository path (e.g., `octocat/hello-world`)
- **`threadId`** — the issue or pull request (e.g., `issue:42`, `pr:17`)

With `sessionScope: thread`, each issue or pull request gets its own isolated session. The agent's responses are posted as comments on the corresponding issue or pull request.

The adapter responds to: issue comments, pull request review comments, new issues, and new pull requests where you are mentioned.

### Known Limitation (MVP)

The adapter fetches only the `latest_comment_url` from each notification thread. If multiple comments arrive on the same issue or PR between two poll cycles, only the latest comment is processed — intermediate comments are silently dropped. This is acceptable for the current MVP scope where you mention the bot and no new mentions arrive before the agent replies. A future upgrade will treat notifications as wake-up signals and enumerate all new comments per thread.

## Proactive Sends

The agent can proactively create issues or post comments without an inbound notification. Without a `threadId`, a new issue is created. With a `threadId`, a comment is added to the existing issue or pull request.

> ⚠️ **Security:** On a **public** repository with `senderPolicy: "open"`, any GitHub user who mentions the bot can submit a prompt that drives the agent in your `cwd` — reading code, spending tokens, posting comments, and running tools (subject to the daemon's permission policy). Always use `senderPolicy: "allowlist"` with explicit `allowedUsers` on public repos.

## Tips

- **Use `sessionScope: "thread"`** — this gives each issue or pull request its own session, so conversations stay focused.
- **Restrict access** — use `senderPolicy: "allowlist"` with your GitHub username. The channel processes all your notifications, so you want to control who can trigger the agent.
- **Lower `pollInterval` for faster response** — the default 60 seconds is conservative. Set it to `30000` or lower if you want quicker responses and don't mind the extra API calls.
- **Point `cwd` at the repository** — the agent works best when its working directory is the repository the notifications are about, so it can read code and understand context.

## Troubleshooting

### Agent doesn't respond to notifications

- Check that the token is correct and the environment variable is set
- Verify your username is in `allowedUsers` if using `senderPolicy: "allowlist"`
- Make sure `groupPolicy` is set to `"open"` or `"allowlist"` — the default is `"disabled"`, which drops all notifications because each repository is treated as a group chat
- Make sure the notification's `reason` is `mention` or `team_mention` — other reasons (like `assign`, `subscribed`) are received but `isMentioned` is only set for direct mentions
- Check the terminal output for errors

### "could not resolve sender" warning

This means the adapter couldn't determine who wrote the comment or issue. It falls back to using the repository name as the sender. This is usually harmless — check that the GitHub API is accessible and the token has `repo` scope.

### Responses are slow

The agent polls at a fixed interval. Lower `pollInterval` for faster response. Complex tasks (reading files, running tools) can also take a minute or more — this is the agent working, not a delay in polling.

### "GitHub channel does not support sendMessage"

This is expected. The GitHub channel only supports `sendThreadMessage` — responses are always posted in the context of an issue or pull request. If you see this error, something is trying to send a message without a thread context.
