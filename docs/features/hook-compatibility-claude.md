# Qwen Code - Claude Code Hook and Tool System Compatibility Specification

## Overview

This document specifies the compatibility between Qwen Code and Claude Code hook and tool systems. Qwen Code has been designed to maintain compatibility with Claude Code patterns while extending functionality where beneficial.

## Transcript Storage

### Claude Code

- Stores conversation transcripts as JSONL files
- Location: `~/.claude/projects/<project_id>/<session_id>.jsonl`
- Contains conversation history with all user and assistant messages

### Qwen Code

- Stores conversation transcripts as JSON files
- Location: `~/.qwen/tmp/<project_hash>/chats/session-<timestamp>-<session_id>.json`
- Contains comprehensive conversation records with:
  - User and assistant messages
  - Tool calls and execution results
  - Token usage statistics
  - Assistant thoughts and reasoning
  - File change snapshots

## Hook System Compatibility

### Hook Event Mapping

| Claude Code Event | Qwen Code Equivalent                  | Status        |
| ----------------- | ------------------------------------- | ------------- |
| `PreToolUse`      | `tool.before`                         | ✅ Compatible |
| `PostToolUse`     | `tool.after`                          | ✅ Compatible |
| `Stop`            | `session.end`                         | ✅ Compatible |
| `SubagentStop`    | `session.end` (with subagent context) | ✅ Compatible |
| `InputReceived`   | `input.received`                      | ✅ Compatible |
| `BeforeResponse`  | `before.response`                     | ✅ Compatible |
| `AfterResponse`   | `after.response`                      | ✅ Compatible |
| `SessionStart`    | `session.start`                       | ✅ Compatible |
| `AppStartup`      | `app.startup`                         | ✅ Compatible |
| `AppShutdown`     | `app.shutdown`                        | ✅ Compatible |

### Hook Payload Compatibility

#### Tool Execution Hooks

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

**Qwen Code Format:**

```json
{
  "id": "tool_before_<callId>",
  "timestamp": number,
  "callId": "string",
  "toolName": "string",
  "args": {}
}
```

#### Session Hooks

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

**Qwen Code Format:**

```json
{
  "id": "session_start_<sessionId>",
  "timestamp": number,
  "sessionId": "string"
}
```

#### Subagent Stop Hook

**Claude Code Format:**

```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "permission_mode": "string",
  "hook_event_name": "SubagentStop",
  "subagent_id": "string",
  "subagent_name": "string"
}
```

**Qwen Code Format:**

```json
{
  "id": "subagent_session_end_<subagentId>",
  "timestamp": number,
  "subagentId": "string",
  "subagentName": "string",
  "terminateReason": "string",
  "summary": {}
}
```

### Hook Output Format Compatibility

Both systems support identical output formats:

#### Exit Code Output

- Exit code 0: Success
- Exit code 2: Blocking error (stops processing)
- Other codes: Non-blocking error

#### JSON Output Format

```json
{
  "continue": true, // Whether Claude should continue
  "stopReason": "string", // Message shown when continue is false
  "suppressOutput": true, // Hide stdout from transcript
  "systemMessage": "string" // Optional warning message
}
```

## Tool Name Mapping

| Claude Code Tool | Qwen Code Equivalent | Status           |
| ---------------- | -------------------- | ---------------- |
| `Write`          | `write_file`         | ✅ Mapped        |
| `Edit`           | `edit`               | ✅ Mapped        |
| `Bash`           | `run_shell_command`  | ✅ Mapped        |
| `TodoWrite`      | `todo_write`         | ✅ Mapped        |
| `Read`           | `read_file`          | ✅ Mapped        |
| `ReadManyFiles`  | `read_many_files`    | ✅ Mapped        |
| `Grep`           | `grep_search`        | ✅ Mapped        |
| `Glob`           | `glob`               | ✅ Mapped        |
| `Ls`             | `ls`                 | ✅ Mapped        |
| `Shell`          | `run_shell_command`  | ✅ Mapped        |
| `WebSearch`      | `web_search`         | ✅ Mapped        |
| `WebFetch`       | `web_fetch`          | ✅ Mapped        |
| `Memory`         | `save_memory`        | ✅ Mapped        |
| `Task`           | `task`               | ✅ Mapped        |
| `ExitPlanMode`   | `exit_plan_mode`     | ✅ Mapped        |
| `NotebookEdit`   | Not implemented      | ⚠️ No equivalent |

## Configuration Format Compatibility

### Claude Code Format (hooks.yaml)

```yaml
version: '1.0.0'
hooks:
  - event: 'PreToolUse'
    matcher: ['Write', 'Edit']
    command: './hooks/security.js'
    timeout: 30
```

### Qwen Code Format (settings.json)

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
        "timeout": 30
      }
    ]
  }
}
```

## Hook Script Interface Compatibility

Both systems pass hook payloads to external scripts via stdin as JSON, maintaining compatibility for Claude Code style hooks.

### Script Requirements

- Scripts receive JSON payload via stdin
- Scripts can return exit codes or JSON responses
- Scripts execute with application permissions
- Security validation prevents directory traversal

## MCP Tool Integration

Both systems support MCP tools with the pattern `mcp__<server>__<tool>`, maintaining compatibility for Claude Code MCP integrations.

## Security Model Compatibility

Both systems implement equivalent security models:

- Scripts execute with application permissions
- Path validation prevents directory traversal
- Input validation for security
- Session-based execution contexts
