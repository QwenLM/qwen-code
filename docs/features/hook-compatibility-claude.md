# Qwen Code - Claude Code Hook Compatibility

## Compatibility Overview

Qwen Code maintains compatibility with Claude Code hook patterns while extending functionality where beneficial. This compatibility allows Claude Code users to reuse their existing hook scripts with minimal changes.

## Hook Event Mapping

Claude Code events are mapped to Qwen Code hook types:

| Claude Code Event  | Qwen Code Equivalent                  |
| ------------------ | ------------------------------------- |
| `PreToolUse`       | `tool.before`                         |
| `PostToolUse`      | `tool.after`                          |
| `Stop`             | `session.end`                         |
| `SubagentStop`     | `session.end` (with subagent context) |
| `UserPromptSubmit` | `input.received`                      |
| `InputReceived`    | `input.received`                      |
| `BeforeResponse`   | `before.response`                     |
| `AfterResponse`    | `after.response`                      |
| `SessionStart`     | `session.start`                       |
| `AppStartup`       | `app.startup`                         |
| `AppShutdown`      | `app.shutdown`                        |
| `Notification`     | `session.notification`                |

## Additional Qwen Code Hook Types

Qwen Code also supports these hook types that may not have direct Claude Code equivalents:

| Qwen Code Hook Type    | Description                                |
| ---------------------- | ------------------------------------------ |
| `output.ready`         | When the output is ready to be processed   |
| `command.before`       | Before a command is executed               |
| `command.after`        | After a command is executed                |
| `model.before_request` | Before a model request is made             |
| `model.after_response` | After a model response is received         |
| `file.before_read`     | Before a file is read                      |
| `file.after_read`      | After a file is read                       |
| `file.before_write`    | Before a file is written                   |
| `file.after_write`     | After a file is written                    |
| `error.occurred`       | When an error occurs                       |
| `error.handled`        | After an error is handled                  |
| `before.compact`       | Before compacting or optimizing operations |

## Complete Claude Hook Event Types

The complete list of Claude-compatible hook events includes:

| Claude Hook Event  | Description                               |
| ------------------ | ----------------------------------------- |
| `PreToolUse`       | Before a tool is executed                 |
| `PostToolUse`      | After a tool is executed                  |
| `Stop`             | When a session is about to end            |
| `SubagentStop`     | When a subagent session is about to end   |
| `UserPromptSubmit` | When user input is submitted              |
| `InputReceived`    | When input is received                    |
| `BeforeResponse`   | Before the assistant generates a response |
| `AfterResponse`    | After the assistant generates a response  |
| `SessionStart`     | When a session starts                     |
| `AppStartup`       | When the application starts               |
| `AppShutdown`      | When the application shuts down           |
| `Notification`     | For notifications during a session        |

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
- `matcher`: Optional list of tools to match (applies to tool events), can be string[] or string
  - When specified as a string array: `["Write", "Edit"]` - matches any of the specified tools
  - When specified as a single string: `"Write"` - matches that specific tool
  - If not specified: the hook applies to all tools for tool-related events
- `command`: The command or script to execute
- `timeout`: Timeout in seconds
- `priority`: Execution priority (lower numbers execute first)
- `enabled`: Whether the hook is enabled

### Hook Execution Behavior

Hooks follow these execution behaviors:

- **Priority System**: Hooks execute in order based on priority, with lower numbers executing first. The default priority is 0 if not specified.
- **Error Handling**: If a hook fails during execution, the error is logged but does not prevent subsequent hooks from executing.
- **Payload Modification**: Hooks can return modified payloads that are passed to subsequent hooks in the chain.
- **Cancellation**: If a cancellation signal is present in the context and becomes aborted, hook execution stops early.
- **Payload Protection**: Before passing to hooks, payloads are deep-cloned to prevent direct mutations from affecting the original.

Qwen Code supports additional hook configuration options beyond Claude compatibility:

```json
{
  "hooks": {
    "enabled": true, // Whether hooks are enabled globally (optional, default: true)
    "timeoutMs": 10000, // Global timeout for all hooks in milliseconds (optional)
    "claudeHooks": [
      // Claude-compatible hooks
      // ... as above
    ],
    "hooks": [
      // Native Qwen Code hooks
      {
        "type": "input.received",
        "scriptPath": "./hooks/custom.js",
        "inlineScript": "return { ...payload, modified: true };",
        "enabled": true,
        "priority": 5,
        "parameters": {
          // Additional parameters for the hook (optional)
          "customOption": "value"
        }
      }
    ]
  }
}
```

- `enabled`: Whether hooks are enabled globally (optional, default: true if not specified)
- `timeoutMs`: Global timeout for all hooks in milliseconds (optional)
- `hooks`: Array of native Qwen Code hook configurations (separate from claudeHooks)
  - `type`: The hook type to register for
  - `scriptPath`: Path to an external script file to execute (optional)
  - `inlineScript`: Inline JavaScript code to execute (optional, can't be used with scriptPath)
  - `enabled`: Whether this specific hook is enabled (optional, default: true)
  - `priority`: Execution priority (lower numbers execute first, default: 0)
  - `parameters`: Additional parameters to pass to the hook (optional)

## Payload Format Compatibility

The basic HookPayload interface in Qwen Code includes:

```typescript
interface HookPayload {
  /** Unique identifier for the hook execution */
  id: string;
  /** Timestamp of when the hook was triggered */
  timestamp: number;
  /** Additional data specific to the hook type */
  [key: string]: unknown;
}
```

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
| `Edit`           | `edit`               |
| `Bash`           | `run_shell_command`  |
| `TodoWrite`      | `todo_write`         |
| `Read`           | `read_file`          |
| `Grep`           | `grep_search`        |
| `Glob`           | `glob`               |
| `Ls`             | `ls`                 |
| `WebSearch`      | `web_search`         |
| `WebFetch`       | `web_fetch`          |
| `Memory`         | `save_memory`        |
| `Task`           | `task`               |
| `ExitPlanMode`   | `exit_plan_mode`     |

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

### Tool Input Format Configuration

Tool input format mappings can be customized via configuration files. Qwen Code looks for these configuration files in the following locations:

1. `config/tool-input-format-mappings.json` (relative to project root)
2. `config/tool-input-format-mappings.json` (relative to core package)
3. `config/tool-input-format-mappings.json` (relative to compiled distribution)

The configuration file format is:

```json
{
  "toolInputFormatMappings": {
    "write_file": {
      "claudeFieldMapping": {
        "file_path": "file_path",
        "content": "content"
      },
      "requiredFields": ["file_path", "content"],
      "claudeFormat": {
        "file_path": "string",
        "content": "string"
      }
    },
    "replace": {
      "claudeFieldMapping": {
        "file_path": "file_path",
        "old_string": "old_string",
        "new_string": "new_string"
      },
      "requiredFields": ["file_path", "old_string", "new_string"],
      "claudeFormat": {
        "file_path": "string",
        "old_string": "string",
        "new_string": "string"
      }
    }
    // Additional tool mappings...
  }
}
```

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
- Script paths are validated to ensure they're within the project directory to prevent unauthorized file access
- When using `scriptPath`, the system checks that the resolved path is within the project directory
- If the relative path starts with `..` or is an absolute path, the hook execution is blocked for security
