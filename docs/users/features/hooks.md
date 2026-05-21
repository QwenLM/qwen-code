# Qwen Code Hooks

## Overview

Qwen Code hooks provide a powerful mechanism for extending and customizing the behavior of the Qwen Code application. Hooks allow users to execute custom scripts or programs at specific points in the application lifecycle, such as before tool execution, after tool execution, at session start/end, and during other key events.

Hooks are enabled by default. You can temporarily disable all hooks by setting `disableAllHooks` to `true` in your settings file (at the top level, alongside `hooks`):

```json
{
  "disableAllHooks": true,
  "hooks": {
    "PreToolUse": [...]
  }
}
```

This disables all hooks without deleting their configurations.

## What are Hooks?

Hooks are user-defined scripts or programs that are automatically executed by Qwen Code at predefined points in the application flow. They allow users to:

- Monitor and audit tool usage
- Enforce security policies
- Inject additional context into conversations
- Customize application behavior based on events
- Integrate with external systems and services
- Modify tool inputs or responses programmatically

## Hook Types

Qwen Code supports four hook executor types:

| Type       | Description                                                                                    |
| :--------- | :--------------------------------------------------------------------------------------------- |
| `command`  | Execute a shell command. Receives JSON via `stdin`, returns results via `stdout`.              |
| `http`     | Send JSON as a `POST` request body to a specified URL. Returns results via HTTP response body. |
| `function` | Directly call a registered JavaScript function (session-level hooks only).                     |
| `prompt`   | Use an LLM to evaluate hook input and return a decision.                                       |

### Command Hooks

Command hooks execute commands via child processes. Input JSON is passed through stdin, and output is returned via stdout.

**Configuration:**

| Field           | Type                     | Required | Description                                 |
| :-------------- | :----------------------- | :------- | :------------------------------------------ |
| `type`          | `"command"`              | Yes      | Hook type                                   |
| `command`       | `string`                 | Yes      | Command to execute                          |
| `name`          | `string`                 | No       | Hook name (for logging)                     |
| `description`   | `string`                 | No       | Hook description                            |
| `timeout`       | `number`                 | No       | Timeout in milliseconds, default 60000      |
| `async`         | `boolean`                | No       | Whether to run asynchronously in background |
| `env`           | `Record<string, string>` | No       | Environment variables                       |
| `shell`         | `"bash" \| "powershell"` | No       | Shell to use                                |
| `statusMessage` | `string`                 | No       | Status message displayed during execution   |

**Example:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "WriteFile",
        "hooks": [
          {
            "type": "command",
            "command": "$QWEN_PROJECT_DIR/.qwen/hooks/security-check.sh",
            "name": "security-check",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

### HTTP Hooks

HTTP hooks send hook input as POST requests to specified URLs. They support URL whitelists, DNS-level SSRF protection, environment variable interpolation, and other security features.

**Configuration:**

| Field            | Type                     | Required | Description                                               |
| :--------------- | :----------------------- | :------- | :-------------------------------------------------------- |
| `type`           | `"http"`                 | Yes      | Hook type                                                 |
| `url`            | `string`                 | Yes      | Target URL                                                |
| `headers`        | `Record<string, string>` | No       | Request headers (supports env var interpolation)          |
| `allowedEnvVars` | `string[]`               | No       | Whitelist of environment variables allowed in URL/headers |
| `timeout`        | `number`                 | No       | Timeout in seconds, default 600                           |
| `name`           | `string`                 | No       | Hook name (for logging)                                   |
| `statusMessage`  | `string`                 | No       | Status message displayed during execution                 |
| `once`           | `boolean`                | No       | Execute only once per event per session (HTTP hooks only) |

**Security Features:**

- **URL Whitelist**: Configure allowed URL patterns via `allowedUrls`
- **SSRF Protection**: Blocks private IPs (10.x.x.x, 172.16-31.x.x, 192.168.x.x, etc.) but allows loopback addresses (127.0.0.1, ::1)
- **DNS Validation**: Validates domain resolution before requests to prevent DNS rebinding attacks
- **Environment Variable Interpolation**: `${VAR}` syntax, only allows variables in `allowedEnvVars` whitelist

**Example:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:8080/hooks/pre-tool-use",
            "headers": {
              "Authorization": "Bearer ${HOOK_API_KEY}"
            },
            "allowedEnvVars": ["HOOK_API_KEY"],
            "timeout": 10,
            "name": "remote-security-check"
          }
        ]
      }
    ]
  }
}
```

### Function Hooks

Function hooks directly call registered JavaScript/TypeScript functions. They are used internally by the Skill system and are not currently exposed as a public API for end users.

**Note**: For most use cases, use **command hooks** or **HTTP hooks** instead, which can be configured in settings files.

### Prompt Hooks

Prompt hooks use an LLM to evaluate hook input and return a decision. This is useful for making intelligent decisions based on context, such as determining whether to allow or block an operation.

**How it works:**

1. The hook input JSON is injected into your prompt using the `$ARGUMENTS` placeholder
2. The prompt is sent to an LLM (default: your current model)
3. The LLM returns a JSON response with the decision
4. Qwen Code processes the decision and continues or blocks execution accordingly

**Configuration:**

| Field           | Type       | Required | Description                                         |
| :-------------- | :--------- | :------- | :-------------------------------------------------- |
| `type`          | `"prompt"` | Yes      | Hook type                                           |
| `prompt`        | `string`   | Yes      | Prompt sent to LLM. Use `$ARGUMENTS` for hook input |
| `model`         | `string`   | No       | Model to use (defaults to your current model)       |
| `timeout`       | `number`   | No       | Timeout in seconds, default 30                      |
| `name`          | `string`   | No       | Hook name (for logging)                             |
| `description`   | `string`   | No       | Hook description                                    |
| `statusMessage` | `string`   | No       | Status message displayed during execution           |

**Response Format:**

The LLM must return JSON with the following structure:

```json
{
  "ok": true,
  "reason": "Explanation of the decision",
  "additionalContext": "Optional context to inject into the conversation"
}
```

| Field               | Description                                                                |
| :------------------ | :------------------------------------------------------------------------- |
| `ok`                | `true` to allow/continue, `false` to block/stop                            |
| `reason`            | Required when `ok` is `false`. Shown to the model to explain the block     |
| `additionalContext` | Optional. Additional context to inject into the conversation when allowing |

**Supported Events:**

Prompt hooks can be used with most hook events, including:

- `PreToolUse` - Evaluate whether to allow a tool call
- `PostToolUse` - Evaluate tool results and potentially inject context
- `Stop` - Determine whether to continue or stop
- `SubagentStop` - Evaluate subagent results
- `UserPromptSubmit` - Evaluate or enrich user prompts

**Example: Stop Hook**

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "You are evaluating whether Qwen Code should stop working. Context: $ARGUMENTS\n\nAnalyze the conversation and determine if:\n1. All user-requested tasks are complete\n2. Any errors need to be addressed\n3. Follow-up work is needed\n\nRespond with JSON: {\"ok\": true} to allow stopping, or {\"ok\": false, \"reason\": \"your explanation\"} to continue working.",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

When `ok` is `false`, Qwen Code will continue working and use the `reason` as context for the next response.

**Example: PreToolUse Hook**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate this tool call for security concerns. Tool input: $ARGUMENTS\n\nCheck for:\n- Dangerous commands (rm -rf, curl | sh, etc.)\n- Unauthorized access attempts\n- Data exfiltration patterns\n\nRespond with {\"ok\": true} if safe, or {\"ok\": false, \"reason\": \"concern\"} if blocked.",
            "model": "sonnet",
            "timeout": 30,
            "name": "security-evaluator"
          }
        ]
      }
    ]
  }
}
```

## Hook Events

Hooks fire at specific points during a Qwen Code session. Different events support different matchers to filter trigger conditions.

| Event                | Triggered When                            | Matcher Target                                            |
| :------------------- | :---------------------------------------- | :-------------------------------------------------------- |
| `PreToolUse`         | Before tool execution                     | Tool name (`WriteFile`, `ReadFile`, `Bash`, etc.)         |
| `PostToolUse`        | After successful tool execution           | Tool name                                                 |
| `PostToolUseFailure` | After tool execution fails                | Tool name                                                 |
| `UserPromptSubmit`   | After user submits prompt                 | None (always fires)                                       |
| `SessionStart`       | When session starts or resumes            | Source (`startup`, `resume`, `clear`, `compact`)          |
| `SessionEnd`         | When session ends                         | Reason (`clear`, `logout`, `prompt_input_exit`, etc.)     |
| `Stop`               | When Claude prepares to conclude response | None (always fires)                                       |
| `SubagentStart`      | When subagent starts                      | Agent type (`Bash`, `Explorer`, `Plan`, etc.)             |
| `SubagentStop`       | When subagent stops                       | Agent type                                                |
| `PreCompact`         | Before conversation compaction            | Trigger (`manual`, `auto`)                                |
| `Notification`       | When notifications are sent               | Type (`permission_prompt`, `idle_prompt`, `auth_success`) |
| `PermissionRequest`  | When permission dialog is shown           | Tool name                                                 |
| `TodoCreated`        | When a new todo item is created           | None (always fires)                                       |
| `TodoCompleted`      | When a todo item is marked as completed   | None (always fires)                                       |

### Matcher Patterns

`matcher` is a regular expression used to filter trigger conditions.

| Event Type          | Events                                                                 | Matcher Support | Matcher Target                                           |
| :------------------ | :--------------------------------------------------------------------- | :-------------- | :------------------------------------------------------- |
| Tool Events         | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest` | ✅ Regex        | Tool name: `WriteFile`, `ReadFile`, `Bash`, etc.         |
| Subagent Events     | `SubagentStart`, `SubagentStop`                                        | ✅ Regex        | Agent type: `Bash`, `Explorer`, etc.                     |
| Session Events      | `SessionStart`                                                         | ✅ Regex        | Source: `startup`, `resume`, `clear`, `compact`          |
| Session Events      | `SessionEnd`                                                           | ✅ Regex        | Reason: `clear`, `logout`, `prompt_input_exit`, etc.     |
| Notification Events | `Notification`                                                         | ✅ Exact match  | Type: `permission_prompt`, `idle_prompt`, `auth_success` |
| Compact Events      | `PreCompact`                                                           | ✅ Exact match  | Trigger: `manual`, `auto`                                |
| Todo Events         | `TodoCreated`, `TodoCompleted`                                         | ❌ No           | N/A                                                      |
| Prompt Events       | `UserPromptSubmit`                                                     | ❌ No           | N/A                                                      |
| Stop Events         | `Stop`                                                                 | ❌ No           | N/A                                                      |

**Matcher Syntax:**

- Empty string `""` or `"*"` matches all events of that type
- Standard regex syntax supported (e.g., `^Bash$`, `Read.*`, `(WriteFile|Edit)`)

**Examples:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'bash check' >> /tmp/hooks.log"
          }
        ]
      },
      {
        "matcher": "Write.*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'write check' >> /tmp/hooks.log"
          }
        ]
      },
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "echo 'all tools' >> /tmp/hooks.log" }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "^(Bash|Explorer)$",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'subagent check' >> /tmp/hooks.log"
          }
        ]
      }
    ]
  }
}
```

## Input/Output Rules

### Hook Input Structure

All hooks receive standardized input in JSON format through stdin (command) or POST body (http).

**Common Fields:**

```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "hook_event_name": "string",
  "timestamp": "string"
}
```

Event-specific fields are added based on the hook type. When running in a subagent, `agent_id` and `agent_type` are additionally included.

### Hook Output Structure

Hook output is returned via `stdout` (command) or HTTP response body (http) as JSON.

**Exit Code Behavior (Command Hooks):**

| Exit Code | Behavior                                                                              |
| :-------- | :------------------------------------------------------------------------------------ |
| `0`       | Success. Parse JSON in `stdout` to control behavior.                                  |
| `2`       | **Blocking error**. Ignores `stdout`, passes `stderr` as error feedback to the model. |
| Other     | Non-blocking error. `stderr` only shown in debug mode, execution continues.           |

**Output Structure:**

Hook output supports three categories of fields:

1. **Common Fields**: `continue`, `stopReason`, `suppressOutput`, `systemMessage`
2. **Top-level Decision**: `decision`, `reason` (used by some events)
3. **Event-specific Control**: `hookSpecificOutput` (must include `hookEventName`)

```json
{
  "continue": true,
  "decision": "allow",
  "reason": "Operation approved",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Additional context information"
  }
}
```

### Individual Hook Event Details

#### PreToolUse

**Purpose**: Executed before a tool is used to allow for permission checks, input validation, or context injection.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | yolo",
  "tool_name": "name of the tool being executed",
  "tool_input": "object containing the tool's input parameters",
  "tool_use_id": "unique identifier for this tool use instance"
}
```

**Output Options**:

- `hookSpecificOutput.permissionDecision`: "allow", "deny", or "ask" (REQUIRED)
- `hookSpecificOutput.permissionDecisionReason`: explanation for the decision (REQUIRED)
- `hookSpecificOutput.updatedInput`: modified tool input parameters to use instead of original
- `hookSpecificOutput.additionalContext`: additional context information

**Note**: While standard hook output fields like `decision` and `reason` are technically supported by the underlying class, the official interface expects the `hookSpecificOutput` with `permissionDecision` and `permissionDecisionReason`.

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Security policy blocks database writes",
    "additionalContext": "Current environment: production. Proceed with caution."
  }
}
```

#### PostToolUse

**Purpose**: Executed after a tool completes successfully to process results, log outcomes, or inject additional context.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | yolo",
  "tool_name": "name of the tool that was executed",
  "tool_input": "object containing the tool's input parameters",
  "tool_response": "object containing the tool's response",
  "tool_use_id": "unique identifier for this tool use instance"
}
```

**Output Options**:

- `decision`: "allow", "deny", "block" (defaults to "allow" if not specified)
- `reason`: reason for the decision
- `hookSpecificOutput.additionalContext`: additional information to be included

**Example Output**:

```json
{
  "decision": "allow",
  "reason": "Tool executed successfully",
  "hookSpecificOutput": {
    "additionalContext": "File modification recorded in audit log"
  }
}
```

#### PostToolUseFailure

**Purpose**: Executed when a tool execution fails to handle errors, send alerts, or record failures.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | yolo",
  "tool_use_id": "unique identifier for the tool use",
  "tool_name": "name of the tool that failed",
  "tool_input": "object containing the tool's input parameters",
  "error": "error message describing the failure",
  "is_interrupt": "boolean indicating if failure was due to user interruption (optional)"
}
```

**Output Options**:

- `hookSpecificOutput.additionalContext`: error handling information
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Error: File not found. Failure logged in monitoring system."
  }
}
```

#### UserPromptSubmit

**Purpose**: Executed when the user submits a prompt to modify, validate, or enrich the input.

**Event-specific fields**:

```json
{
  "prompt": "the user's submitted prompt text"
}
```

**Output Options**:

- `decision`: "allow", "deny", "block", or "ask"
- `reason`: human-readable explanation for the decision
- `hookSpecificOutput.additionalContext`: additional context to append to the prompt (optional)

**Note**: Since UserPromptSubmitOutput extends HookOutput, all standard fields are available but only additionalContext in hookSpecificOutput is specifically defined for this event.

**Example Output**:

```json
{
  "decision": "allow",
  "reason": "Prompt reviewed and approved",
  "hookSpecificOutput": {
    "additionalContext": "Remember to follow company coding standards."
  }
}
```

#### SessionStart

**Purpose**: Executed when a new session starts to perform initialization tasks.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | yolo",
  "source": "startup | resume | clear | compact",
  "model": "the model being used",
  "agent_type": "the type of agent if applicable (optional)"
}
```

**Output Options**:

- `hookSpecificOutput.additionalContext`: context to be available in the session
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Session started with security policies enabled."
  }
}
```

#### SessionEnd

**Purpose**: Executed when a session ends to perform cleanup tasks.

**Event-specific fields**:

```json
{
  "reason": "clear | logout | prompt_input_exit | bypass_permissions_disabled | other"
}
```

**Output Options**:

- Standard hook output fields (typically not used for blocking)

#### Stop

**Purpose**: Executed before Qwen concludes its response to provide final feedback or summaries.

**Event-specific fields**:

```json
{
  "stop_hook_active": "boolean indicating if stop hook is active",
  "last_assistant_message": "the last message from the assistant"
}
```

**Output Options**:

- `decision`: "allow", "deny", "block", or "ask"
- `reason`: human-readable explanation for the decision
- `stopReason`: feedback to include in the stop response
- `continue`: set to false to stop execution
- `hookSpecificOutput.additionalContext`: additional context information

**Note**: Since StopOutput extends HookOutput, all standard fields are available but the stopReason field is particularly relevant for this event.

**Example Output**:

```json
{
  "decision": "block",
  "reason": "Must be provided when Qwen Code is blocked from stopping"
}
```

#### StopFailure

**Purpose**: Executed when the turn ends due to an API error (instead of Stop). This is a **fire-and-forget** event - hook output and exit codes are ignored.

**Event-specific fields**:

```json
{
  "error": "rate_limit | authentication_failed | billing_error | invalid_request | server_error | max_output_tokens | unknown",
  "error_details": "detailed error message (optional)",
  "last_assistant_message": "the last message from the assistant before the error (optional)"
}
```

**Matcher**: Matches against the `error` field. For example, `"matcher": "rate_limit"` will only trigger for rate limit errors.

**Output Options**:

- **None** - StopFailure is fire-and-forget. All hook output and exit codes are ignored.

**Exit Code Handling**:

| Exit Code | Behavior                  |
| --------- | ------------------------- |
| Any       | Ignored (fire-and-forget) |

**Example Configuration**:

```json
{
  "hooks": {
    "StopFailure": [
      {
        "matcher": "rate_limit",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/rate-limit-alert.sh",
            "name": "rate-limit-alerter"
          }
        ]
      }
    ]
  }
}
```

**Use Cases**:

- Rate limit monitoring and alerting
- Authentication failure logging
- Billing error notifications
- Error statistics collection

#### SubagentStart

**Purpose**: Executed when a subagent (like the Task tool) is started to set up context or permissions.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | yolo",
  "agent_id": "identifier for the subagent",
  "agent_type": "type of agent (Bash, Explorer, Plan, Custom, etc.)"
}
```

**Output Options**:

- `hookSpecificOutput.additionalContext`: initial context for the subagent
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Subagent initialized with restricted permissions."
  }
}
```

#### SubagentStop

**Purpose**: Executed when a subagent finishes to perform finalization tasks.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | yolo",
  "stop_hook_active": "boolean indicating if stop hook is active",
  "agent_id": "identifier for the subagent",
  "agent_type": "type of agent",
  "agent_transcript_path": "path to the subagent's transcript",
  "last_assistant_message": "the last message from the subagent"
}
```

**Output Options**:

- `decision`: "allow", "deny", "block", or "ask"
- `reason`: human-readable explanation for the decision

**Example Output**:

```json
{
  "decision": "block",
  "reason": "Must be provided when Qwen Code is blocked from stopping"
}
```

#### PreCompact

**Purpose**: Executed before conversation compaction to prepare or log the compaction.

**Event-specific fields**:

```json
{
  "trigger": "manual | auto",
  "custom_instructions": "custom instructions currently set"
}
```

**Output Options**:

- `hookSpecificOutput.additionalContext`: context to include before compaction
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Compacting conversation to maintain optimal context window."
  }
}
```

#### PostCompact

**Purpose**: Executed after conversation compaction completes to archive summaries or track usage.

**Event-specific fields**:

```json
{
  "trigger": "manual | auto",
  "compact_summary": "the summary generated by the compaction process"
}
```

**Matcher**: Matches against the `trigger` field. For example, `"matcher": "manual"` will only trigger for manual compaction via `/compact` command.

**Output Options**:

- `hookSpecificOutput.additionalContext`: additional context (for logging only)
- Standard hook output fields (for logging only)

**Note**: PostCompact is **not** in the official decision mode supported events list. The `decision` field and other control fields do not produce any control effects - they are only used for logging purposes.

**Exit Code Handling**:

| Exit Code | Behavior                                                  |
| --------- | --------------------------------------------------------- |
| 0         | Success - stdout shown to user in verbose mode            |
| Other     | Non-blocking error - stderr shown to user in verbose mode |

**Example Configuration**:

```json
{
  "hooks": {
    "PostCompact": [
      {
        "matcher": "manual",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/save-compact-summary.sh",
            "name": "save-summary"
          }
        ]
      }
    ]
  }
}
```

**Use Cases**:

- Summary archiving to files or databases
- Usage statistics tracking
- Context change monitoring
- Audit logging for compaction operations

#### Notification

**Purpose**: Executed when notifications are sent to customize or intercept them.

**Event-specific fields**:

```json
{
  "message": "notification message content",
  "title": "notification title (optional)",
  "notification_type": "permission_prompt | idle_prompt | auth_success"
}
```

> **Note**: `elicitation_dialog` type is defined but not currently implemented.

**Output Options**:

- `hookSpecificOutput.additionalContext`: additional information to include
- Standard hook output fields

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "additionalContext": "Notification processed by monitoring system."
  }
}
```

#### PermissionRequest

**Purpose**: Executed when permission dialogs are displayed to automate decisions or update permissions.

**Event-specific fields**:

```json
{
  "permission_mode": "default | plan | auto_edit | yolo",
  "tool_name": "name of the tool requesting permission",
  "tool_input": "object containing the tool's input parameters",
  "permission_suggestions": "array of suggested permissions (optional)"
}
```

**Output Options**:

- `hookSpecificOutput.decision`: structured object with permission decision details:
  - `behavior`: "allow" or "deny"
  - `updatedInput`: modified tool input (optional)
  - `updatedPermissions`: modified permissions (optional)
  - `message`: message to show to user (optional)
  - `interrupt`: whether to interrupt the workflow (optional)

**Example Output**:

```json
{
  "hookSpecificOutput": {
    "decision": {
      "behavior": "allow",
      "message": "Permission granted based on security policy",
      "interrupt": false
    }
  }
}
```

#### TodoCreated

**Purpose**: Executed when a new todo item is created via the `todo_write` tool. Allows validation, logging, or blocking of todo creation.

Todo hooks run in two phases:

- `validation`: runs before persistence. Use this phase for validation only; returning `block` or `deny` prevents the write.
- `postWrite`: runs after persistence. Use this phase for side effects such as logging or syncing; `block` or `deny` is ignored in this phase.

**Event-specific fields**:

```json
{
  "todo_id": "unique identifier for the todo item",
  "todo_content": "content/description of the todo item",
  "todo_status": "pending | in_progress | completed",
  "all_todos": "array of all todo items in the current list",
  "phase": "validation | postWrite"
}
```

**Output Options**:

- `decision`: "allow", "block", or "deny"
- `reason`: human-readable explanation for the decision (required when blocking)

**Blocking Behavior**:

During the `validation` phase, when `decision` is `block` or `deny` (exit code 2), todo creation is prevented. The todo list remains unchanged, and the reason is provided as feedback to the model.

During the `postWrite` phase, the todo has already been persisted. Hooks may still return output, but `block` / `deny` does not undo the write and should not be used for validation.

**Example Output (Allow)**:

```json
{
  "decision": "allow",
  "reason": "Todo content validated successfully"
}
```

**Example Output (Block)**:

```json
{
  "decision": "block",
  "reason": "Todo content too short. Minimum 5 characters required."
}
```

**Example Hook Script**:

```bash
#!/bin/bash
# ~/.qwen/hooks/todo-validator.sh
# Validates todo content before creation

INPUT=$(cat)
CONTENT=$(echo "$INPUT" | jq -r '.todo_content')

# Check minimum length
if [ ${#CONTENT} -lt 5 ]; then
  echo '{"decision": "block", "reason": "Todo content must be at least 5 characters"}'
  exit 2
fi

# Block test-related todos
if [[ "$CONTENT" =~ "test" ]]; then
  echo '{"decision": "block", "reason": "Test todos are not allowed in production"}'
  exit 2
fi

echo '{"decision": "allow"}'
exit 0
```

**Example Configuration**:

```json
{
  "hooks": {
    "TodoCreated": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.qwen/hooks/todo-validator.sh",
            "name": "todo-validator",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

#### TodoCompleted

**Purpose**: Executed when a todo item is marked as completed. Allows validation, logging, or blocking of todo completion.

Todo hooks run in two phases:

- `validation`: runs before persistence. Use this phase for validation only; returning `block` or `deny` prevents the write.
- `postWrite`: runs after persistence. Use this phase for side effects such as logging or syncing; `block` or `deny` is ignored in this phase.

**Event-specific fields**:

```json
{
  "todo_id": "unique identifier for the todo item",
  "todo_content": "content/description of the todo item",
  "previous_status": "pending | in_progress (status before completion)",
  "all_todos": "array of all todo items in the current list",
  "phase": "validation | postWrite"
}
```

**Output Options**:

- `decision`: "allow", "block", or "deny"
- `reason`: human-readable explanation for the decision (required when blocking)

**Blocking Behavior**:

During the `validation` phase, when `decision` is `block` or `deny` (exit code 2), todo completion is prevented. The todo item remains in its previous status, and the reason is provided as feedback to the model.

During the `postWrite` phase, the todo has already been persisted. Hooks may still return output, but `block` / `deny` does not undo the write and should not be used for validation.

**Example Output (Allow)**:

```json
{
  "decision": "allow",
  "reason": "Todo completion approved"
}
```

**Example Output (Block)**:

```json
{
  "decision": "block",
  "reason": "Cannot complete this todo until dependent tasks are finished."
}
```

**Example Hook Script**:

```bash
#!/bin/bash
# ~/.qwen/hooks/todo-completion-validator.sh
# Validates todo completion conditions

INPUT=$(cat)
TODO_ID=$(echo "$INPUT" | jq -r '.todo_id')
ALL_TODOS=$(echo "$INPUT" | jq -r '.all_todos')

# Check if there are incomplete dependent todos (example logic)
INCOMPLETE_COUNT=$(echo "$ALL_TODOS" | jq '[.[] | select(.status != "completed")] | length')

if [ "$INCOMPLETE_COUNT" -gt 5 ]; then
  echo '{"decision": "block", "reason": "Too many incomplete todos. Complete other tasks first."}'
  exit 2
fi

echo '{"decision": "allow"}'
exit 0
```

**Example Configuration**:

```json
{
  "hooks": {
    "TodoCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.qwen/hooks/todo-completion-validator.sh",
            "name": "completion-validator",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

**Use Cases**:

- **Logging**: Track todo creation and completion for audit or analytics
- **Validation**: Enforce content quality standards (minimum length, required keywords)
- **Workflow Control**: Block completion until prerequisites are met
- **Integration**: Sync todos with external task management systems (Jira, Trello, etc.)

## Hook Configuration

Hooks are configured in Qwen Code settings, typically in `.qwen/settings.json` or user configuration files:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "sequential": false,
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/security-check.sh",
            "name": "security-check",
            "description": "Run security checks before tool execution",
            "timeout": 30000
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Session started'",
            "name": "session-init"
          }
        ]
      }
    ]
  }
}
```

## Hook Execution

### Parallel vs Sequential Execution

- By default, hooks execute in parallel for better performance
- Use `sequential: true` in hook definition to enforce order-dependent execution
- Sequential hooks can modify input for subsequent hooks in the chain

### Async Hooks

Only `command` type supports asynchronous execution. Setting `"async": true` runs the hook in the background without blocking the main flow.

**Features:**

- Cannot return decision control (operation has already occurred)
- Results are injected in the next conversation turn via `systemMessage` or `additionalContext`
- Suitable for auditing, logging, background testing, etc.

**Example:**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "WriteFile|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "$QWEN_PROJECT_DIR/.qwen/hooks/run-tests-async.sh",
            "async": true,
            "timeout": 300000
          }
        ]
      }
    ]
  }
}
```

```bash
#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.js ]]; then exit 0; fi
RESULT=$(npm test 2>&1)
if [ $? -eq 0 ]; then
  echo "{\"systemMessage\": \"Tests passed after editing $FILE_PATH\"}"
else
  echo "{\"systemMessage\": \"Tests failed: $RESULT\"}"
fi
```

### Security Model

- Hooks run in the user's environment with user privileges
- Project-level hooks require trusted folder status
- Timeouts prevent hanging hooks (default: 60 seconds)

## Best Practices

### Example 1: Security Validation Hook

A PreToolUse hook that logs and potentially blocks dangerous commands:

**security_check.sh**

```bash
#!/bin/bash

# Read input from stdin
INPUT=$(cat)

# Parse the input to extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input')

# Check for potentially dangerous operations
if echo "$TOOL_INPUT" | grep -qiE "(rm.*-rf|mv.*\/|chmod.*777)"; then
  echo '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Security policy blocks dangerous command"
    }
  }'
  exit 2  # Blocking error
fi

# Log the operation
echo "INFO: Tool $TOOL_NAME executed safely at $(date)" >> /var/log/qwen-security.log

# Allow with additional context
echo '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Security check passed",
    "additionalContext": "Command approved by security policy"
  }
}'
exit 0
```

Configure in `.qwen/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${SECURITY_CHECK_SCRIPT}",
            "name": "security-checker",
            "description": "Security validation for bash commands",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

### Example 2: HTTP Audit Hook

A PostToolUse HTTP hook that sends all tool execution records to a remote audit service:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "https://audit.example.com/api/tool-execution",
            "headers": {
              "Authorization": "Bearer ${AUDIT_API_TOKEN}",
              "Content-Type": "application/json"
            },
            "allowedEnvVars": ["AUDIT_API_TOKEN"],
            "timeout": 10,
            "name": "audit-logger"
          }
        ]
      }
    ]
  }
}
```

### Example 3: User Prompt Validation Hook

A UserPromptSubmit hook that validates user prompts for sensitive information and provides context for long prompts:

**prompt_validator.py**

```python
import json
import sys
import re

# Load input from stdin
try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
    exit(1)

user_prompt = input_data.get("prompt", "")

# Sensitive words list
sensitive_words = ["password", "secret", "token", "api_key"]

# Check for sensitive information
for word in sensitive_words:
    if re.search(rf"\b{word}\b", user_prompt.lower()):
        # Block prompts containing sensitive information
        output = {
            "decision": "block",
            "reason": f"Prompt contains sensitive information '{word}'. Please remove sensitive content and resubmit.",
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit"
            }
        }
        print(json.dumps(output))
        exit(0)

# Check prompt length and add warning context if too long
if len(user_prompt) > 1000:
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "Note: User submitted a long prompt. Please read carefully and ensure all requirements are understood."
        }
    }
    print(json.dumps(output))
    exit(0)

# No processing needed for normal cases
exit(0)
```

## Troubleshooting

- Check application logs for hook execution details
- Verify hook script permissions and executability
- Ensure proper JSON formatting in hook outputs
- Use specific matcher patterns to avoid unintended hook execution
- Use `--debug` mode to see detailed hook matching and execution information
- Temporarily disable all hooks: add `"disableAllHooks": true` in settings
