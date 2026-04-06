# Status Line

> Display custom information beneath the footer using a shell command.

The status line lets you run a shell command whose output is displayed as a persistent line below the footer bar. The command receives structured JSON context via stdin, so it can show session-aware information like the current model, token usage, git branch, or anything else you can script.

```
┌─────────────────────────────────────────────────────────────────┐
│  ? for shortcuts                  🔒 docker | Debug | ◼◼◼◻ 67% │
├─────────────────────────────────────────────────────────────────┤
│  user@host ~/project (main) qwen-3-235b  ctx:34%               │  ← status line
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- [`jq`](https://jqlang.github.io/jq/) is recommended for parsing the JSON input (install via `brew install jq`, `apt install jq`, etc.)
- Simple commands that don't need JSON data (e.g. `git branch --show-current`) work without `jq`

## Quick setup

The easiest way to configure a status line is the `/statusline` command. It launches a setup agent that reads your shell PS1 configuration and generates a matching status line:

```
/statusline
```

You can also give it specific instructions:

```
/statusline show model name and context usage percentage
```

## Manual configuration

Add a `statusLine` object under the `ui` key in `~/.qwen/settings.json`:

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); echo \"$(echo $input | jq -r '.model.id')  ctx:$(echo $input | jq -r '.context_window.last_prompt_token_count')\"",
      "padding": 0
    }
  }
}
```

| Field     | Type        | Required | Description                                                                           |
| --------- | ----------- | -------- | ------------------------------------------------------------------------------------- |
| `type`    | `"command"` | Yes      | Must be `"command"`                                                                   |
| `command` | string      | Yes      | Shell command to execute. Receives JSON via stdin, first line of stdout is displayed. |
| `padding` | number      | No       | Horizontal padding (default: `0`)                                                     |

## JSON input

The command receives a JSON object via stdin with the following fields:

```json
{
  "session_id": "abc-123",
  "cwd": "/home/user/project",
  "model": {
    "id": "qwen-3-235b"
  },
  "context_window": {
    "context_window_size": 131072,
    "last_prompt_token_count": 45000
  },
  "vim": {
    "mode": "INSERT"
  }
}
```

| Field                                    | Type             | Description                                                                        |
| ---------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `session_id`                             | string           | Unique session identifier                                                          |
| `cwd`                                    | string           | Current working directory                                                          |
| `model.id`                               | string           | Current model identifier                                                           |
| `context_window.context_window_size`     | number           | Total context window size                                                          |
| `context_window.last_prompt_token_count` | number           | Tokens used in the last prompt                                                     |
| `vim`                                    | object \| absent | Present only when vim mode is enabled. Contains `mode` (`"INSERT"` or `"NORMAL"`). |

> **Important:** stdin can only be read once. Always store it in a variable first: `input=$(cat)`.

## Examples

### Model and token usage

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); model=$(echo $input | jq -r '.model.id'); tokens=$(echo $input | jq -r '.context_window.last_prompt_token_count'); size=$(echo $input | jq -r '.context_window.context_window_size'); pct=$((tokens * 100 / (size > 0 ? size : 1))); echo \"$model  ctx:${pct}%\""
    }
  }
}
```

Output: `qwen-3-235b  ctx:34%`

### Git branch + directory

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "branch=$(git branch --show-current 2>/dev/null); dir=$(basename \"$PWD\"); echo \"$dir${branch:+ ($branch)}\""
    }
  }
}
```

Output: `my-project (main)`

> Note: `git` and `pwd` run in the workspace directory automatically.

### Script file for complex commands

For longer commands, save a script file at `~/.qwen/statusline-command.sh`:

```bash
#!/bin/bash
input=$(cat)
model=$(echo "$input" | jq -r '.model.id')
tokens=$(echo "$input" | jq -r '.context_window.last_prompt_token_count')
size=$(echo "$input" | jq -r '.context_window.context_window_size')
branch=$(git branch --show-current 2>/dev/null)

parts=()
[ -n "$model" ] && parts+=("$model")
[ -n "$branch" ] && parts+=("($branch)")
if [ "$tokens" -gt 0 ] && [ "$size" -gt 0 ] 2>/dev/null; then
  pct=$((tokens * 100 / size))
  parts+=("ctx:${pct}%")
fi

echo "${parts[*]}"
```

Then reference it in settings:

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "bash ~/.qwen/statusline-command.sh"
    }
  }
}
```

## Behavior

- **Update triggers**: The status line updates when the model changes, a new message is sent (token count changes), or vim mode is toggled. Updates are debounced (300ms).
- **Timeout**: Commands that take longer than 5 seconds are killed. The status line clears on failure.
- **Output**: Only the first line of stdout is used. The text is rendered with dimmed colors and truncated to terminal width.
- **Hot reload**: Changes to `ui.statusLine` in settings take effect immediately — no restart required.
- **Removal**: Delete the `ui.statusLine` key from settings to disable. The status line disappears and the "? for shortcuts" hint returns.

## Troubleshooting

| Problem                 | Cause                  | Fix                                                                                                                                                 |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status line not showing | Config at wrong path   | Must be under `ui.statusLine`, not root-level `statusLine`                                                                                          |
| Empty output            | Command fails silently | Test manually: `echo '{"model":{"id":"test"},"cwd":"/tmp","context_window":{"context_window_size":1,"last_prompt_token_count":0}}' \| your_command` |
| Stale data              | No trigger fired       | Send a message or switch models to trigger an update                                                                                                |
| Command too slow        | Complex script         | Optimize the script or move heavy work to a background cache                                                                                        |
