# Qwen Code - Claude Code Hooks Integration Specifications

## Overview

This document specifies the hooks integration between Qwen Code and Claude Code, detailing the expected data formats, I/O mechanisms, transcript handling, and other integration components.

## Hook Events and Lifecycle

### Hook Event Types

| Event            | Description                           | Expected I/O                                                     |
| ---------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `PreToolUse`     | Triggered before any tool is executed | Input: tool parameters, transcript; Output: allow/deny decision  |
| `Stop`           | Triggered when main agent stops       | Input: transcript, final message; Output: approve/block decision |
| `SubagentStop`   | Triggered when subagent stops         | Input: transcript, final message; Output: approve/block decision |
| `InputReceived`  | Triggered when input is received      | Input: user input, context; Output: processing feedback          |
| `BeforeResponse` | Triggered before agent responds       | Input: prepared response; Output: allow/modify/block             |
| `AfterResponse`  | Triggered after agent responds        | Input: sent response; Output: logging only                       |
| `SessionStart`   | Triggered when session begins         | Input: session config; Output: initialization                    |
| `AppStartup`     | Triggered when application starts     | Input: app config; Output: initialization                        |
| `AppShutdown`    | Triggered when application shuts down | Input: app state; Output: cleanup                                |

## Data Formats and I/O

### Hook Input Format (stdin JSON)

The hook system passes data to external scripts via stdin in JSON format:

```json
{
  "session_id": "string",
  "hook_event_name": "PreToolUse | Stop | SubagentStop | etc.",
  "tool_name": "string | null",
  "tool_input": {
    "file_path": "string",
    "content": "string",
    "command": "string",
    "...": "additional tool-specific fields"
  } | null,
  "transcript_path": "string | null",
  "cwd": "string",
  "permission_mode": "string"
}
```

### Hook Output Format

Scripts can return results in two formats depending on the event type:

#### PreToolUse Hook Output

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | block",
    "permissionDecisionReason": "string (optional)"
  },
  "systemMessage": "string (optional)"
}
```

#### Stop/SubagentStop Hook Output

```json
{
  "decision": "approve | block",
  "reason": "string (optional)",
  "systemMessage": "string (optional)"
}
```

### Exit Codes

- `0`: Success/allow
- `2`: Blocking error (stops processing)
- Other codes: Non-blocking error

## Transcript Integration

### Transcript Format

Transcripts are stored in JSONL format with each line containing a JSON object:

```json
{
  "type": "user | assistant | tool_call | tool_result | system",
  "message": {
    "content": [{ "type": "text", "text": "content" }],
    "role": "user | assistant"
  },
  "timestamp": "ISO string",
  "turnId": "string"
}
```

### Transcript Path Access

The `transcript_path` field in hook input contains the absolute path to the current session's transcript file. Hooks can read this file to analyze conversation history.

### Message Processing

Hooks can analyze message content including:

- User requests and instructions
- Assistant responses and reasoning
- Tool calls and their results
- System messages and feedback

## Tool Integration

### Supported Tools

| Claude Tool     | Qwen Equivalent     | Hook Integration      |
| --------------- | ------------------- | --------------------- |
| `Write`         | `write_file`        | PreToolUse validation |
| `Edit`          | `replace`           | PreToolUse validation |
| `Bash`          | `run_shell_command` | PreToolUse validation |
| `Read`          | `read_file`         | PreToolUse validation |
| `ReadManyFiles` | `read_many_files`   | PreToolUse validation |
| `Grep`          | `grep_search`       | PreToolUse validation |
| `Glob`          | `glob`              | PreToolUse validation |
| `Ls`            | `ls`                | PreToolUse validation |
| `TodoWrite`     | `todoWrite`         | PreToolUse validation |
| `WebSearch`     | `web_search`        | PreToolUse validation |
| `WebFetch`      | `web_fetch`         | PreToolUse validation |

### Tool Input Validation

For each tool type, hooks receive specific input parameters:

#### Write Operations

```json
{
  "file_path": "string",
  "content": "string"
}
```

#### Edit Operations

```json
{
  "file_path": "string",
  "old_string": "string",
  "new_string": "string"
}
```

#### Bash Operations

```json
{
  "command": "string",
  "description": "string (optional)"
}
```

## Todo List Integration

### Todo Format

Todo lists are stored in JSON format:

```json
{
  "id": "string",
  "content": "string",
  "status": "pending | in_progress | completed",
  "created_at": "ISO string",
  "completed_at": "ISO string | null"
}
```

### Todo Validation

Todos are validated against conversation context to ensure:

- Completed todos actually reflect completed work
- Todo updates match actual progress in conversation
- Work verification before marking tasks complete

### Todo File Location

Todo files are stored at:

```
~/.claude/todos/{session_id}-agent-{session_id}.json
```

## Configuration Format

### hooks.yaml Structure

```yaml
version: '2.0.0'
hooks:
  - event: 'PreToolUse'
    matcher: ['Write', 'Edit', 'Bash'] # Array or single string
    command: 'validator-script-name' # References executable in path
    timeout: 60 # Maximum execution time in seconds
    priority: 10 # Execution priority (lower runs first)
```

### Matcher Patterns

- Single tool: `"Write"`
- Multiple tools: `["Write", "Edit", "Bash"]`
- All tools: `"*"`

### Command Execution

The `command` field specifies an executable that will be invoked with the hook input via stdin.

## Security Model

### Execution Context

- Hooks run with application permissions
- Path validation prevents directory traversal
- Input validation for security
- Session-based execution contexts

### Security Validation

- Transcript path validation
- File path validation for tool operations
- Command injection prevention
- Input sanitization

## Performance Considerations

### Timeouts

- Hook execution timeouts prevent hanging
- Framework timeout must exceed agent timeout
- Default timeouts can be overridden

### Resource Limits

- Maximum hook input size: 10MB
- Token limits for moderator context: 100K tokens
- Message count limits: 100 messages max

## Error Handling

### Fail-Safe Mechanisms

- Hooks default to "allow" if they fail to parse input
- Critical validation hooks fail to "deny" on errors
- Logging of all hook execution for debugging

### Retry Mechanisms

- Failed moderator calls can be retried
- Exponential backoff for API failures
- Circuit breaker patterns for degraded service

## Validator Classes

Several specialized validator classes handle different types of checks:

### MaliciousBehaviorValidator

- Detects attempts to bypass CI/CD or create backdoors
- Runs first in sequence to catch bypass attempts
- Uses LLM moderation for sophisticated detection

### CoreQualityValidator

- Validates code changes against cross-language patterns
- Checks for quality and security issues
- Provides full file context for validation

### ResearchValidator

- Ensures adequate research was performed before changes
- Validates use of documentation and code inspection
- Blocks changes made without proper context

### TodoValidatorHook

- Verifies todos are completed before marking done
- Ensures work matches todo descriptions
- Validates progress against conversation history

### ResponseScanner

- Validates completion markers in final responses
- Checks for proper task completion
- Blocks sessions without proper closure

## Integration Points

### Configuration Loading

- `hooks.yaml` is loaded at application startup
- Validators are registered based on configuration
- Priority ordering determines execution sequence

### Transcript Access

- Hooks receive transcript path via input
- Full conversation context is available for analysis
- Message filtering capabilities for selective processing

### Session Management

- Session IDs link hooks to specific conversations
- Per-session logging for debugging and auditing
- Context isolation between sessions
