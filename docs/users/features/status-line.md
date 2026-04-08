# Status Line

> Display custom information in the footer using a shell command.

The status line lets you run a shell command whose output is displayed in the footer's left section. The command receives structured JSON context via stdin, so it can show session-aware information like the current model, token usage, git branch, or anything else you can script.

```
With status line (default approval mode — 1 row):
┌─────────────────────────────────────────────────────────────────┐
│  user@host ~/project (main) ctx:34%   🔒 docker | Debug | 67%  │  ← status line
└─────────────────────────────────────────────────────────────────┘

With status line + non-default mode (2 rows):
┌─────────────────────────────────────────────────────────────────┐
│  user@host ~/project (main) ctx:34%   🔒 docker | Debug | 67%  │  ← status line
│  auto-accept edits (shift + tab to cycle)                       │  ← mode indicator
└─────────────────────────────────────────────────────────────────┘
```

When configured, the status line replaces the default "? for shortcuts" hint. High-priority messages (Ctrl+C/D exit prompts, Esc, vim INSERT mode) temporarily override the status line. The status line text is truncated to fit within the available width.

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
      "command": "input=$(cat); model=$(echo \"$input\" | jq -r '.model.display_name'); pct=$(echo \"$input\" | jq -r '.context_window.used_percentage'); echo \"$model  ctx:${pct}%\""
    }
  }
}
```

| Field     | Type        | Required | Description                                                                           |
| --------- | ----------- | -------- | ------------------------------------------------------------------------------------- |
| `type`    | `"command"` | Yes      | Must be `"command"`                                                                   |
| `command` | string      | Yes      | Shell command to execute. Receives JSON via stdin, first line of stdout is displayed. |

## JSON input

The command receives a JSON object via stdin with the following fields:

```json
{
  "session_id": "abc-123",
  "version": "0.14.1",
  "model": {
    "display_name": "qwen-3-235b"
  },
  "context_window": {
    "context_window_size": 131072,
    "used_percentage": 34.3,
    "remaining_percentage": 65.7,
    "current_usage": 45000,
    "total_input_tokens": 30000,
    "total_output_tokens": 5000
  },
  "workspace": {
    "current_dir": "/home/user/project"
  },
  "git": {
    "branch": "main"
  },
  "metrics": {
    "models": {
      "qwen-3-235b": {
        "api": {
          "total_requests": 10,
          "total_errors": 0,
          "total_latency_ms": 5000
        },
        "tokens": {
          "prompt": 30000,
          "completion": 5000,
          "total": 35000,
          "cached": 10000,
          "thoughts": 2000
        }
      }
    },
    "files": {
      "total_lines_added": 120,
      "total_lines_removed": 30
    }
  },
  "vim": {
    "mode": "INSERT"
  }
}
```

| Field                                 | Type             | Description                                                                        |
| ------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `session_id`                          | string           | Unique session identifier                                                          |
| `version`                             | string           | Qwen Code version                                                                  |
| `model.display_name`                  | string           | Current model name                                                                 |
| `context_window.context_window_size`  | number           | Total context window size in tokens                                                |
| `context_window.used_percentage`      | number           | Context window usage as percentage (0–100)                                         |
| `context_window.remaining_percentage` | number           | Context window remaining as percentage (0–100)                                     |
| `context_window.current_usage`        | number           | Token count from the last API call (current context size)                          |
| `context_window.total_input_tokens`   | number           | Total input tokens consumed this session                                           |
| `context_window.total_output_tokens`  | number           | Total output tokens consumed this session                                          |
| `workspace.current_dir`               | string           | Current working directory                                                          |
| `git`                                 | object \| absent | Present only inside a git repository.                                              |
| `git.branch`                          | string           | Current branch name                                                                |
| `metrics.models.<id>.api`             | object           | Per-model API stats: `total_requests`, `total_errors`, `total_latency_ms`          |
| `metrics.models.<id>.tokens`          | object           | Per-model token usage: `prompt`, `completion`, `total`, `cached`, `thoughts`       |
| `metrics.files`                       | object           | File change stats: `total_lines_added`, `total_lines_removed`                      |
| `vim`                                 | object \| absent | Present only when vim mode is enabled. Contains `mode` (`"INSERT"` or `"NORMAL"`). |

> **Important:** stdin can only be read once. Always store it in a variable first: `input=$(cat)`.

## Examples

### Model and token usage

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); model=$(echo \"$input\" | jq -r '.model.display_name'); pct=$(echo \"$input\" | jq -r '.context_window.used_percentage'); echo \"$model  ctx:${pct}%\""
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
      "command": "input=$(cat); branch=$(echo \"$input\" | jq -r '.git.branch // empty'); dir=$(basename \"$(echo \"$input\" | jq -r '.workspace.current_dir')\"); echo \"$dir${branch:+ ($branch)}\""
    }
  }
}
```

Output: `my-project (main)`

> Note: The `git.branch` field is provided directly in the JSON input — no need to shell out to `git`.

### File change stats

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); added=$(echo \"$input\" | jq -r '.metrics.files.total_lines_added'); removed=$(echo \"$input\" | jq -r '.metrics.files.total_lines_removed'); echo \"+$added/-$removed lines\""
    }
  }
}
```

Output: `+120/-30 lines`

### Script file for complex commands

For longer commands, save a script file at `~/.qwen/statusline-command.sh`:

```bash
#!/bin/bash
input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name')
pct=$(echo "$input" | jq -r '.context_window.used_percentage')
branch=$(echo "$input" | jq -r '.git.branch // empty')
added=$(echo "$input" | jq -r '.metrics.files.total_lines_added')
removed=$(echo "$input" | jq -r '.metrics.files.total_lines_removed')

parts=()
[ -n "$model" ] && parts+=("$model")
[ -n "$branch" ] && parts+=("($branch)")
[ "$pct" != "0" ] 2>/dev/null && parts+=("ctx:${pct}%")
([ "$added" -gt 0 ] || [ "$removed" -gt 0 ]) 2>/dev/null && parts+=("+${added}/-${removed}")

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

- **Update triggers**: The status line updates when the model changes, a new message is sent (token count changes), vim mode is toggled, git branch changes, tool calls complete, or file changes occur. Updates are debounced (300ms).
- **Timeout**: Commands that take longer than 5 seconds are killed. The status line clears on failure.
- **Output**: Only the first line of stdout is used. The text is rendered with dimmed colors in the footer's left section and truncated if it exceeds the available width.
- **Hot reload**: Changes to `ui.statusLine` in settings take effect immediately — no restart required.
- **Shell**: Commands run via `/bin/sh` on macOS/Linux. On Windows, `cmd.exe` is used by default — wrap POSIX commands with `bash -c "..."` or point to a bash script (e.g. `bash ~/.qwen/statusline-command.sh`).
- **Removal**: Delete the `ui.statusLine` key from settings to disable. The "? for shortcuts" hint returns.

## Troubleshooting

| Problem                 | Cause                  | Fix                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status line not showing | Config at wrong path   | Must be under `ui.statusLine`, not root-level `statusLine`                                                                                                                                                                                                                                                                                                                                             |
| Empty output            | Command fails silently | Test manually: `echo '{"session_id":"test","version":"0.14.1","model":{"display_name":"test"},"context_window":{"context_window_size":0,"used_percentage":0,"remaining_percentage":100,"current_usage":0,"total_input_tokens":0,"total_output_tokens":0},"workspace":{"current_dir":"/tmp"},"metrics":{"models":{},"files":{"total_lines_added":0,"total_lines_removed":0}}}' \| sh -c 'your_command'` |
| Stale data              | No trigger fired       | Send a message or switch models to trigger an update                                                                                                                                                                                                                                                                                                                                                   |
| Command too slow        | Complex script         | Optimize the script or move heavy work to a background cache                                                                                                                                                                                                                                                                                                                                           |
