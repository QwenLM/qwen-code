# Session Resume

Qwen Code automatically saves your conversation history, allowing you to resume previous sessions at any time.

## Overview

Sessions are saved automatically as you work. You can resume them either from the command line when starting Qwen Code, or from within an active session using the `/resume` command.

## How Sessions Are Stored

Sessions are stored as JSONL files (one JSON record per line) at:

```
~/.qwen/tmp/<project_hash>/chats/<sessionId>.jsonl
```

Each session captures:

- User messages and assistant responses
- Tool calls and their results
- Metadata: timestamps, git branch, working directory, model used

## Resuming Sessions

### From the Command Line

**Resume most recent session:**

```bash
qwen --continue
```

**Show session picker:**

```bash
qwen --resume
```

**Resume specific session by ID:**

```bash
qwen --resume <sessionId>
```

### From Within the App

Use the `/resume` slash command to open a session picker dialog:

```
/resume
```

### Session Picker Controls

- **Arrow keys** or **j/k**: Navigate between sessions
- **Enter**: Select and resume the highlighted session
- **B**: Toggle branch filter (show only sessions from current git branch)
- **Escape**: Cancel and return to current session

## Session List Display

Each session shows:

- First prompt text (truncated if long)
- Number of messages
- Last modified timestamp
- Git branch name (if available)

Sessions are sorted by last modified time, with most recent first.

## Related Features

- [Welcome Back](./welcome-back.md) - Automatic session context restoration
- [/summary command](../cli/commands.md) - Generate project summaries for future reference
