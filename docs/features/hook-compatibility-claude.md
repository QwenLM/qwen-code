# Qwen Code - Claude Code Hook Compatibility

## Compatibility Overview

Qwen Code maintains compatibility with Claude Code hook patterns while extending functionality where beneficial. This compatibility allows Claude Code users to reuse their existing hook scripts with minimal changes.

## Hook Event Mapping

Claude Code events are mapped to Qwen Code hook types:

| Claude Code Event | Qwen Code Equivalent                  |
| ----------------- | ------------------------------------- |
| `PreToolUse`      | `tool.before`                         |
| `PostToolUse`     | `tool.after`                          |
| `Stop`            | `session.end`                         |
| `SubagentStop`    | `session.end` (with subagent context) |
| `UserPromptSubmit`| `input.received`                      |
| `BeforeResponse`  | `before.response`                     |
| `AfterResponse`   | `after.response`                      |
| `SessionStart`    | `session.start`                       |
| `AppStartup`      | `app.startup`                         |
| `AppShutdown`     | `app.shutdown`                        |

## Claude-Compatible Hook Configuration

Qwen Code supports Claude-compatible hook configuration through the `claudeHooks` section:

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 10000,
    "claudeHooks": [
      {
        "event": "PreToolUse",
        "matcher": ["Write", "Edit"],
        "command": "./hooks/security.js",
        "timeout": 30,
        "priority": 10,
        "enabled": true
      }
    ]
  }
}
```

### Claude Hook Configuration Options

- `event`: The Claude Code event to hook into
- `matcher`: Optional list of tools to match (applies to tool events)
- `command`: The command or script to execute
- `timeout`: Timeout in seconds
- `priority`: Execution priority (lower numbers execute first)
- `enabled`: Whether the hook is enabled

## Payload Format Compatibility

### Tool Execution Events

**Claude Code Format:**
```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "permission_mode": "string",
  "hook_event_name": "PreToolUse",
  "callId": "string",
  "toolName": "string",
  "args": {}
}
```

**Qwen Code Output (converted Claude format):**
```json
{
  "session_id": "string",
  "hook_event_name": "PreToolUse",
  "timestamp": number,
  "tool_name": "string",
  "tool_input": {},
  "transcript_path": "string"
}
```

### Session Events

**Claude Code Format:**
```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "permission_mode": "string",
  "hook_event_name": "SessionStart"
}
```

**Qwen Code Output (converted Claude format):**
```json
{
  "session_id": "string",
  "hook_event_name": "SessionStart",
  "timestamp": number,
  "transcript_path": "string"
}
```

## Tool Name Mapping

Claude Code tools are mapped to Qwen Code equivalents:

| Claude Code Tool | Qwen Code Equivalent |
| ---------------- | -------------------- |
| `Write`          | `write_file`         |
| `Edit`           | `replace`            |
| `Bash`           | `run_shell_command`  |
| `TodoWrite`      | `todo_write`         |
| `Read`           | `read_file`          |
| `Grep`           | `grep`               |
| `Glob`           | `glob`               |
| `Ls`             | `ls`                 |
| `WebSearch`      | `web_search`         |
| `WebFetch`       | `web_fetch`          |

## Tool Input Format Mapping

Tool input parameters are mapped between the systems:

### Write/Edit Tools
- Claude: `{ file_path: "path", content: "content" }`
- Qwen: `{ file_path: "path", content: "content" }`
- Mapping: Direct field mapping

### Bash/Shell Tools
- Claude: `{ command: "cmd", description: "desc" }`
- Qwen: `{ command: "cmd", description: "desc" }`
- Mapping: Direct field mapping

### Read/File Tools
- Claude: `{ file_path: "path" }`
- Qwen: `{ file_path: "path" }`
- Mapping: Direct field mapping

## Output Format Compatibility

Both systems support identical output formats:

### Exit Code Output
- Exit code 0: Success
- Exit code 2: Blocking error (stops processing)
- Other codes: Non-blocking error

### JSON Output Format
```json
{
  "continue": true, // Whether Claude should continue
  "stopReason": "string", // Message shown when continue is false
  "suppressOutput": true, // Hide stdout from transcript
  "systemMessage": "string" // Optional warning message
}
```

For PreToolUse events with input updates:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|block",
    "permissionDecisionReason": "string",
    "updatedInput": {} // Updated tool input parameters
  },
  "systemMessage": "string" // Optional
}
```

## Script Execution Interface

Both systems pass hook payloads to external scripts via stdin as JSON, maintaining compatibility for Claude Code style hooks.

### Script Requirements
- Scripts receive JSON payload via stdin
- Scripts can return exit codes or JSON responses
- Scripts execute with application permissions
- Security validation prevents directory traversal
