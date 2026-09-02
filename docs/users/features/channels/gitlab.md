# GitLab

This guide covers setting up a Qwen Code channel that monitors GitLab todos and responds to mentions on issues and merge requests.

## Prerequisites

- A GitLab account (or a dedicated bot account)
- A GitLab Personal Access Token with `read_api` and `api` scopes

## Creating a Token

1. Go to **Preferences → Access Tokens**
2. Create a token with these scopes:
   - **read_api** — read todos and project data
   - **api** — post notes (comments) on issues/MRs
3. Save the token securely as an environment variable

## Configuration

Add the channel to `~/.qwen/settings.json`:

```json
{
  "channels": {
    "my-gitlab": {
      "type": "gitlab",
      "token": "$GITLAB_TOKEN",
      "pollInterval": 60000,
      "senderPolicy": "open",
      "sessionScope": "chat_thread",
      "cwd": "/path/to/your/project",
      "groupPolicy": "open",
      "action_prompt_template": {
        "mentioned": "Project: %project% | URL: %project_url% | Author: %author% | Type: %target_type% | IID: %iid% | Title: %title% | Description: %description% | TodoID: %todo_id%"
      }
    }
  }
}
```

Set the token as an environment variable:

```bash
export GITLAB_TOKEN="glpat-your_token_here"
```

### Self-hosted GitLab

For self-hosted instances, set `baseUrl`:

```json
{
  "baseUrl": "https://gitlab.example.com"
}
```

## Configuration Options

| Option                   | Default                   | Description                                                |
| ------------------------ | ------------------------- | ---------------------------------------------------------- |
| `token`                  | (required)                | PAT with `read_api` + `api` scopes                         |
| `pollInterval`           | `60000`                   | Poll interval in ms                                        |
| `baseUrl`                | `https://gitlab.com`      | GitLab instance URL                                        |
| `action_prompt_template` | (required for processing) | Maps GitLab action names to metadata templates             |
| `groupPolicy`            | `"disabled"`              | Must be `"open"`, or `"allowlist"` with the project listed |
| `senderPolicy`           | `"allowlist"`             | Who can trigger the bot                                    |

## action_prompt_template

This field controls which todo actions are processed and how metadata is rendered. Only actions with a configured template are dispatched; all others are skipped and marked done.

```json
{
  "action_prompt_template": {
    "mentioned": "Project: %project% | Author: %author% | Title: %title%"
  }
}
```

The `directly_addressed` action (comment starting with `@bot`) automatically falls back to the `mentioned` template if not explicitly configured.

### Available Action Keys

| Key                   | Trigger                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `mentioned`           | Someone @mentions the bot in a comment or description (not at the start) |
| `directly_addressed`  | A comment **starts with** `@bot` (falls back to `mentioned` template)    |
| `assigned`            | Someone assigns the bot to an issue/MR                                   |
| `review_requested`    | Someone requests the bot as a reviewer on an MR                          |
| `approval_required`   | An MR requires the bot's approval (approval rules)                       |
| `marked`              | Someone marks the bot's comment/issue/MR (star)                          |
| `build_failed`        | A CI/CD pipeline fails on the bot's branch/MR                            |
| `unmergeable`         | An MR the bot is involved with becomes unmergeable (conflicts)           |
| `merge_train_removed` | An MR is removed from the merge train                                    |

Only keys present in `action_prompt_template` are processed. Unconfigured actions are skipped and marked done silently.

### Template Variables

| Variable        | Value                             |
| --------------- | --------------------------------- |
| `%project%`     | Project path (e.g., `owner/repo`) |
| `%project_url%` | Full project URL                  |
| `%author%`      | Todo author username              |
| `%target_type%` | `Issue` or `MergeRequest`         |
| `%iid%`         | Issue/MR internal ID              |
| `%title%`       | Issue/MR title                    |
| `%description%` | Issue/MR description body         |
| `%todo_id%`     | GitLab todo ID                    |
| `%%`            | Literal `%` (escape)              |

Unknown variables are preserved as-is in the output.

### Prompt Assembly

The template renders into `envelope.metadata` (structured context). The triggering text (`todo.body` or description) goes into `envelope.text` (primary prompt). The base class assembles the final prompt sent to the agent:

```
[alice] please fix this bug

Project: owner/repo | URL: https://gitlab.com/owner/repo | Author: alice | Type: Issue | IID: 42 | Title: Test Issue | Description: ... | TodoID: 100
```

- Line 1: `[sender]` prefix + `envelope.text` (with `@bot` stripped)
- Line 3: `envelope.metadata` (rendered template, sanitized)

You do **not** need a `%body%` variable — the comment/description text is always the primary prompt content, and the template provides supplementary context below it.

## ⚠️ Security

On a **public project**, setting `senderPolicy: "open"` allows **any GitLab user** who @mentions the bot to submit prompts that drive the agent in your `cwd`.

Always use `senderPolicy: "allowlist"` with explicit `allowedUsers` on public projects.

## Mention Detection

The adapter always sets `isMentioned = true` on dispatched envelopes, because GitLab has already determined the mention when creating the todo. The `action_prompt_template` config is the real event filter — only actions with a configured template are processed. The `@bot` mention is stripped from the message text before dispatch via `stripBotMention`.

### ⚠️ groupPolicy Must Be "open" or "allowlist"

`groupPolicy` must be set to `"open"`, or `"allowlist"` with the project explicitly listed, for todos to be processed. The default value `"disabled"` drops all mentions: todos are marked done and the cursor advances, but no dispatch occurs. A rejection is logged (`preflight rejected reason=group_disabled`) but the todo is still consumed. If your bot is not responding to mentions, check that `groupPolicy` is not `"disabled"`.

## How It Works

The adapter uses GitLab's Todos API as the message source:

1. **Poll** `GET /todos?state=pending` for new todos
2. **First-poll drain**: if the cursor has never been initialized (`initialized: false`), all pending todos are marked done without dispatch and the cursor advances to the max todo ID. This prevents a backlog flood on first start.
3. **Clean up stale todos**: todos with `id <= cursor` are marked done (best-effort) to prevent them from being re-fetched on every poll
4. **Filter** by `id > cursor` and configured `action_prompt_template`
5. **Detect mention type** via `target_url` anchor:
   - `#note_123` present → comment mention → text is `todo.body` (the comment)
   - No anchor → description mention → text is the issue/MR description
6. **Dispatch** the envelope through `handleInbound` (requires `groupPolicy: "open"` or `"allowlist"` with the project listed)
7. **Advance cursor** and **mark todo done** (best-effort)

The cursor (`lastProcessedId`) advances regardless of dispatch success or failure. Failed dispatches post a ⚠️ error comment on the issue/MR and are not retried — the user can re-mention the bot to trigger a new todo.

## Response Feedback

For an accepted comment mention (note with `#note_` anchor), the channel adds a 👀 award emoji to the note while the agent is working, then removes it when the run completes, fails, or is cancelled. Both operations are best-effort: an award emoji API or permission failure is logged and never prevents the final response.

Description mentions (no `#note_` anchor) do not receive an award emoji because there is no specific note to react to.

## Known Limitations

- **First start skips existing pending todos.** The cursor initializes to `{ lastProcessedId: 0, initialized: false }` on first launch. On the first poll cycle, all pre-existing pending todos are marked done without dispatch (the `initialized` flag gates this one-time drain), preventing a backlog flood.
- The bot does not read prior conversation history — only the triggering content is processed.
- **Confidential (internal) notes:** If someone @mentions the bot in a confidential note, the todo body contains that internal text and the agent will process it. The bot's reply is always posted as a **public** note, potentially exposing internal discussion. GitLab's todo API does not expose note visibility, so the adapter cannot filter this. Avoid @mentioning the bot in confidential notes.
- Requires `read_api` + `api` PAT scopes. Group-level or project-level tokens work if they have these scopes.
- Todos for Epics, Designs, and Alerts are skipped (only Issues and MRs are processed).

## Starting the Channel

```bash
qwen channel start my-gitlab
```
