# GitLab

This guide covers setting up a Qwen Code channel on GitLab. The GitLab channel polls your Todo list and responds to issues and merge requests as notes (comments).

## Prerequisites

- A GitLab account
- A GitLab personal access token with `api` scope (see below)

## Creating a Token

1. Go to **Preferences → [Access Tokens](https://gitlab.com/-/profile/personal_access_tokens)**
2. Create a new token with the `api` scope
3. Save the token securely

For self-hosted GitLab, set `baseUrl` to your instance URL (e.g., `https://gitlab.example.com`).

## Configuration

Add the channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-gitlab": {
      "type": "gitlab",
      "token": "$GITLAB_TOKEN",
      "groupPolicy": "open",
      "sessionScope": "chat_thread",
      "cwd": "/path/to/your/repo",
      "senderPolicy": "allowlist",
      "allowedUsers": ["your-gitlab-username"],
      "pollInterval": 30000
    }
  }
}
```

Set the token as an environment variable:

```bash
export GITLAB_TOKEN=<your-personal-access-token>
```

Or add it to a `.env` file that gets sourced before running.

### Configuration Options

| Option         | Description                                                                           |
| -------------- | ------------------------------------------------------------------------------------- |
| `token`        | GitLab personal access token. Supports `$ENV_VAR` syntax                              |
| `baseUrl`      | GitLab host URL. Defaults to `https://gitlab.com`. Set to your self-hosted GitLab URL |
| `pollInterval` | Poll interval in milliseconds. Defaults to `60000` (60 seconds)                       |

## Running

```bash
# Start only the GitLab channel
qwen channel start my-gitlab

# Or start all configured channels together
qwen channel start
```

When someone mentions you in an issue or merge request, a todo item appears in your GitLab Todo list. The agent picks it up on the next poll cycle and posts a response as a note on the same issue or merge request. Processed todos are automatically dismissed.

## How It Works

Unlike the messaging-platform channels that receive messages in real time, the GitLab channel **polls** the [Todo Lists API](https://docs.gitlab.com/api/todos/) at a fixed interval. Each todo is converted into a message:

- **`chatId`** — the project path (e.g., `group/subgroup/project`)
- **`threadId`** — the issue or merge request (e.g., `issue:42`, `mr:17`)

With `sessionScope: chat_thread`, each issue or merge request gets its own isolated session. The agent's responses are posted as notes on the corresponding issue or merge request.

The adapter only processes `Issue` and `MergeRequest` todo target types. Todos for commits, pipelines, design management, and other types are skipped.

### Mention Detection

The adapter determines whether the bot was mentioned by checking the todo's `action_name` field. Only `mentioned` and `directly_addressed` actions set `isMentioned` to `true`. Other actions like `assigned`, `review_requested`, or `commented` are received but do not trigger the bot.

With the default `requireMention: true` (inherited from `groupPolicy` group config), the bot only responds to todos with a mention-type action. Set `groups: { "*": { "requireMention": false } }` to respond to all todos regardless of action type.

## Proactive Sends

The agent can proactively post notes on existing issues or merge requests. A `threadId` is required — if it is missing, the adapter logs an error and the message is not sent.

> ⚠️ **Security:** On a **public** project with `senderPolicy: "open"`, any GitLab user who mentions the bot can submit a prompt that drives the agent in your `cwd` — reading code, spending tokens, posting notes, and running tools (subject to the daemon's permission policy). Always use `senderPolicy: "allowlist"` with explicit `allowedUsers` on public projects.

## Tips

- **Use `sessionScope: "chat_thread"`** — this gives each issue or merge request its own session, so conversations stay focused.
- **Restrict access** — use `senderPolicy: "allowlist"` with your GitLab username. The channel processes all your todos, so you want to control who can trigger the agent.
- **Lower `pollInterval` for faster response** — the default 60 seconds is conservative. Set it to `30000` or lower if you want quicker responses and don't mind the extra API calls.
- **Point `cwd` at the repository** — the agent works best when its working directory is the repository the todos are about, so it can read code and understand context.

## Troubleshooting

### Agent doesn't respond to todos

- Check that the token is correct and the environment variable is set
- Verify your username is in `allowedUsers` if using `senderPolicy: "allowlist"`
- Make sure `groupPolicy` is set to `"open"` or `"allowlist"` — the default is `"disabled"`, which drops all notifications because each project is treated as a group chat
- Make sure the todo's `action_name` is `mentioned` or `directly_addressed` — other actions (like `assigned`, `commented`) are received but do not trigger the bot. With the default `requireMention: true`, only mention-type todos are processed
- Check the terminal output for errors

### "unsupported target_type" warning

This means a todo was created for something other than an Issue or MergeRequest (e.g., a commit or pipeline). The adapter skips these — this is expected and harmless.

### "todo has no project" warning

This means the todo's target project was deleted or is inaccessible. The adapter dismisses the todo and moves on — this is harmless.

### Responses are slow

The agent polls at a fixed interval. Lower `pollInterval` for faster response. Complex tasks (reading files, running tools) can also take a minute or more — this is the agent working, not a delay in polling.

### "GitLab channel does not support sendMessage"

This is expected. The GitLab channel only supports `sendThreadMessage` — responses are always posted in the context of an issue or merge request. If you see this error, something is trying to send a message without a thread context.
