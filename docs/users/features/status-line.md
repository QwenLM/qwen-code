# Status Line

> Display custom information in the footer.

The status line shows session-aware information — model name, token usage, git branch, and more — in the footer's left section. There are two configuration modes:

- **Preset mode** — pick from built-in data items via an interactive dialog or JSON config. No scripting required.
- **Command mode** — run a shell command that receives structured JSON context via stdin. Full flexibility for custom formatting.

```
Single-line status (default approval mode — 1 row):
┌─────────────────────────────────────────────────────────────────┐
│  user@host ~/project (main) ctx:34%   🔒 docker | Debug | 67%  │  ← status line
└─────────────────────────────────────────────────────────────────┘

Multi-line status (up to 2 lines — 2 rows):
┌─────────────────────────────────────────────────────────────────┐
│  user@host ~/project (main) ctx:34%   🔒 docker | Debug | 67%  │  ← status line 1
│  ████████░░░░░░░░░░ 34% context                                │  ← status line 2
└─────────────────────────────────────────────────────────────────┘

Multi-line status + non-default mode (3 rows max):
┌─────────────────────────────────────────────────────────────────┐
│  user@host ~/project (main) ctx:34%   🔒 docker | Debug | 67%  │  ← status line 1
│  ████████░░░░░░░░░░ 34% context                                │  ← status line 2
│  auto-accept edits (shift + tab to cycle)                       │  ← mode indicator
└─────────────────────────────────────────────────────────────────┘
```

When configured, the status line replaces the default "? for shortcuts" hint. High-priority messages (Ctrl+C/D exit prompts, Esc, vim INSERT mode) temporarily override the status line. The status line text is truncated to fit within the available width.

## Quick setup

The easiest way to configure a status line is the `/statusline` command. It opens an interactive dialog where you can select preset items, toggle theme colors, and see a live preview:

```
/statusline
```

This opens the preset mode configurator. Use arrow keys to navigate, space to toggle items, and enter to confirm. Your selection is saved to settings automatically.

You can also give `/statusline` specific instructions to have it generate a command-mode configuration:

```
/statusline show model name and context usage percentage
```

---

## Preset mode

Preset mode provides a set of built-in data items that you can pick and combine — no shell commands, no `jq`, no scripting. Items are rendered as `item1 | item2 | item3` in a single line.

### Configuration

Add a `statusLine` object under the `ui` key in `~/.qwen/settings.json`:

```json
{
  "ui": {
    "statusLine": {
      "type": "preset",
      "items": [
        "model-with-reasoning",
        "git-branch",
        "context-remaining",
        "current-dir",
        "context-used"
      ],
      "useThemeColors": true
    }
  }
}
```

| Field                  | Type       | Required | Description                                                                                                |
| ---------------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `type`                 | `"preset"` | Yes      | Must be `"preset"`                                                                                         |
| `items`                | string[]   | Yes      | Ordered list of preset item IDs to display (see table below). Items are joined with `\|` as the separator. |
| `useThemeColors`       | boolean    | No       | Apply the active `/theme` color to the status line text. Defaults to `true`.                               |
| `hideContextIndicator` | boolean    | No       | Hide the built-in context usage indicator in the footer right section. Defaults to `false`.                |

### Available preset items

| Item ID                | Default | Description                                                        |
| ---------------------- | ------- | ------------------------------------------------------------------ |
| `model-with-reasoning` | Yes     | Current model name with reasoning level (e.g. `qwen-3-235b high`)  |
| `model`                |         | Current model name without reasoning level                         |
| `git-branch`           | Yes     | Current Git branch name (hidden when not in a git repo)            |
| `context-remaining`    | Yes     | Percentage of context window remaining (e.g. `Context 65.7% left`) |
| `total-input-tokens`   |         | Cumulative input tokens used in session (e.g. `30.0k total in`)    |
| `total-output-tokens`  |         | Cumulative output tokens used in session (e.g. `5.0k total out`)   |
| `current-dir`          | Yes     | Current working directory                                          |
| `project-name`         |         | Project name (basename of working directory)                       |
| `pull-request-number`  |         | Open PR number for the current branch (requires `gh` CLI)          |
| `branch-changes`       |         | Session file change stats (e.g. `+120 -30`)                        |
| `context-used`         | Yes     | Percentage of context window used (e.g. `Context 34.3% used`)      |
| `run-state`            |         | Compact session state (`Ready`, `Working`, or `Confirm`)           |
| `qwen-version`         |         | Qwen Code version (e.g. `v0.14.1`)                                 |
| `context-window-size`  |         | Total context window size (e.g. `131.1k window`)                   |
| `used-tokens`          |         | Current prompt token count (e.g. `45.0k used`)                     |
| `session-id`           |         | Current session identifier                                         |

Items marked **Default** are pre-selected when you first open the `/statusline` dialog.

`total-input-tokens` and `total-output-tokens` are session totals. They add up token usage across turns, so input tokens can grow quickly because each new model request includes the current conversation context again. Use `used-tokens` when you want the current prompt size instead of cumulative session spend.

### Example output

With the default items, the status line looks like:

```
qwen-3-235b high | main | Context 65.7% left | /home/user/project | Context 34.3% used
```

### Customizing via the dialog

Running `/statusline` opens an interactive multi-select dialog:

```
┌ Configure Status Line ────────────────────────────────────────┐
│ Select which items to display in the status line.             │
│                                                               │
│ Type to search                                                │
│ >                                                             │
│                                                               │
│ [x] Use theme colors        Apply colors from the active /theme│
│ ───────────────────────                                       │
│ [x] model-with-reasoning    Current model name with reasoning │
│ [ ] model-only              Current model name without reason │
│ [x] git-branch              Current Git branch when available │
│ [x] context-remaining       Percentage of context remaining   │
│ ...                                                           │
│                                                               │
│ Preview                                                       │
│ qwen-3-235b high | main | Context 65.7% left                 │
│                                                               │
│ Use up/down to navigate, space to select, enter to confirm    │
└───────────────────────────────────────────────────────────────┘
```

- Type to filter items by name or description
- A live preview updates as you toggle items
- Press enter to save the configuration

---

## Command mode

Command mode runs a shell command whose stdout is displayed in the status line. The command receives structured JSON context via stdin for session-aware output.

### Prerequisites

- [`jq`](https://jqlang.github.io/jq/) is recommended for parsing the JSON input (install via `brew install jq`, `apt install jq`, etc.)
- Simple commands that don't need JSON data (e.g. `git branch --show-current`) work without `jq`

### Configuration

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

| Field                  | Type        | Required | Description                                                                                                                       |
| ---------------------- | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `type`                 | `"command"` | Yes      | Must be `"command"`                                                                                                               |
| `command`              | string      | Yes      | Shell command to execute. Receives JSON via stdin, stdout is displayed (up to 2 lines).                                           |
| `refreshInterval`      | number      | No       | Re-run the command every N seconds (minimum 1). Useful for data that changes without an Agent state event (clock, quota, uptime). |
| `respectUserColors`    | boolean     | No       | Preserve ANSI color codes in command output instead of applying dimmed footer styling. Defaults to `false`.                       |
| `hideContextIndicator` | boolean     | No       | Hide the built-in context usage indicator in the footer right section. Defaults to `false`.                                       |

### JSON input

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
  "worktree": {
    "name": "fix-auth",
    "path": "/home/user/project/.qwen/worktrees/fix-auth",
    "branch": "fix-auth",
    "original_cwd": "/home/user/project",
    "original_branch": "main"
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
| `worktree`                            | object \| absent | Present only when inside an active worktree (created by `enter_worktree`).         |
| `worktree.name`                       | string           | Worktree slug name                                                                 |
| `worktree.path`                       | string           | Absolute path to the worktree directory                                            |
| `worktree.branch`                     | string           | Branch checked out in the worktree                                                 |
| `worktree.original_cwd`               | string           | Working directory before entering the worktree                                     |
| `worktree.original_branch`            | string           | Branch that was active before entering the worktree                                |
| `metrics.models.<id>.api`             | object           | Per-model API stats: `total_requests`, `total_errors`, `total_latency_ms`          |
| `metrics.models.<id>.tokens`          | object           | Per-model token usage: `prompt`, `completion`, `total`, `cached`, `thoughts`       |
| `metrics.files`                       | object           | File change stats: `total_lines_added`, `total_lines_removed`                      |
| `vim`                                 | object \| absent | Present only when vim mode is enabled. Contains `mode` (`"INSERT"` or `"NORMAL"`). |

> **Important:** stdin can only be read once. Always store it in a variable first: `input=$(cat)`.

### Examples

#### Model and token usage

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

#### Git branch + directory

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

#### File change stats

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

#### Live clock and git branch

Use `refreshInterval` when the statusline shows data that changes without an Agent event (e.g. the clock, uptime, or rate-limit counters):

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); branch=$(echo \"$input\" | jq -r '.git.branch // \"no-git\"'); echo \"$(date +%H:%M:%S)  ($branch)\"",
      "refreshInterval": 1
    }
  }
}
```

Output (refreshed every second): `14:32:07  (main)`

#### Script file for complex commands

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

**Both modes:**

- **Update triggers**: The status line updates when the model changes, a new message is sent (token count changes), vim mode is toggled, git branch changes, tool calls complete, or file changes occur. Updates are debounced (300ms).
- **Output**: Up to 2 lines. Each line is rendered as a separate row in the footer's left section. Lines that exceed the available width are truncated.
- **Hot reload**: Changes to `ui.statusLine` in settings take effect immediately — no restart required.
- **Removal**: Delete the `ui.statusLine` key from settings to disable. The "? for shortcuts" hint returns.

**Command mode only:**

- **Timeout**: Commands that take longer than 5 seconds are killed. The status line clears on failure.
- **Refresh**: Set `refreshInterval` (seconds) to additionally re-run the command on a timer — useful for data that changes without an Agent event (clock, rate limits, build status).
- **Shell**: Commands run via `/bin/sh` on macOS/Linux. On Windows, `cmd.exe` is used by default — wrap POSIX commands with `bash -c "..."` or point to a bash script (e.g. `bash ~/.qwen/statusline-command.sh`).

**Preset mode only:**

- **No external dependencies**: Preset items are computed internally — no shell commands, no `jq`, no timeouts.
- **Theme integration**: When `useThemeColors` is `true` (default), the status line text uses the active `/theme` color. When `false`, dimmed footer styling is applied.
- **PR lookup**: The `pull-request-number` item runs `gh pr view` in the background (2s timeout). It only triggers when the branch changes, not on every update.

## Troubleshooting

| Problem                     | Cause                          | Fix                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status line not showing     | Config at wrong path           | Must be under `ui.statusLine`, not root-level `statusLine`                                                                                                                                                                                                                                                                                                                                             |
| Empty output (command mode) | Command fails silently         | Test manually: `echo '{"session_id":"test","version":"0.14.1","model":{"display_name":"test"},"context_window":{"context_window_size":0,"used_percentage":0,"remaining_percentage":100,"current_usage":0,"total_input_tokens":0,"total_output_tokens":0},"workspace":{"current_dir":"/tmp"},"metrics":{"models":{},"files":{"total_lines_added":0,"total_lines_removed":0}}}' \| sh -c 'your_command'` |
| Stale data (command mode)   | No trigger fired               | Send a message or switch models to trigger an update — or set `refreshInterval` to re-run the command on a timer                                                                                                                                                                                                                                                                                       |
| Command too slow            | Complex script                 | Optimize the script or move heavy work to a background cache                                                                                                                                                                                                                                                                                                                                           |
| Preset items missing        | Conditional items have no data | `git-branch` is hidden outside git repos; `context-used` is hidden when usage is 0; `branch-changes` is hidden when no files changed. This is expected — items appear once their data is available                                                                                                                                                                                                     |
| PR number not showing       | `gh` CLI not installed         | Install [GitHub CLI](https://cli.github.com/) and authenticate with `gh auth login`. The lookup runs with a 2s timeout                                                                                                                                                                                                                                                                                 |
