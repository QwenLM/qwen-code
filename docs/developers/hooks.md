# Qwen Code Hooks Documentation

## Overview

Qwen Code hooks provide a powerful mechanism for extending and customizing the behavior of the Qwen Code application. Hooks allow users to execute custom scripts or programs at specific points in the application lifecycle, such as before tool execution, after tool execution, at session start/end, and during other key events.

## What are Hooks?

Hooks are user-defined scripts or programs that are automatically executed by Qwen Code at predefined points in the application flow. They allow users to:

- Monitor and audit tool usage
- Enforce security policies
- Inject additional context into conversations
- Customize application behavior based on events
- Integrate with external systems and services
- Modify tool inputs or responses programmatically

## Hook Architecture

The Qwen Code hook system consists of several key components:

1. **Hook Registry**: Stores and manages all configured hooks
2. **Hook Planner**: Determines which hooks should run for each event
3. **Hook Runner**: Executes individual hooks with proper context
4. **Hook Aggregator**: Combines results from multiple hooks
5. **Hook Event Handler**: Coordinates the firing of hooks for events

## Hook Events

The following table lists all available hook events in Qwen Code:

| Event Name           | Description                                 | Use Case                                        |
| -------------------- | ------------------------------------------- | ----------------------------------------------- |
| `PreToolUse`         | Fired before tool execution                 | Permission checking, input validation, logging  |
| `PostToolUse`        | Fired after successful tool execution       | Logging, output processing, monitoring          |
| `PostToolUseFailure` | Fired when tool execution fails             | Error handling, alerting, remediation           |
| `Notification`       | Fired when notifications are sent           | Notification customization, logging             |
| `UserPromptSubmit`   | Fired when user submits a prompt            | Input processing, validation, context injection |
| `SessionStart`       | Fired when a new session starts             | Initialization, context setup                   |
| `Stop`               | Fired before Qwen concludes its response    | Finalization, cleanup                           |
| `SubagentStart`      | Fired when a subagent starts                | Subagent initialization                         |
| `SubagentStop`       | Fired when a subagent stops                 | Subagent finalization                           |
| `PreCompact`         | Fired before conversation compaction        | Pre-compaction processing                       |
| `SessionEnd`         | Fired when a session ends                   | Cleanup, reporting                              |
| `PermissionRequest`  | Fired when permission dialogs are displayed | Permission automation, policy enforcement       |

## Input/Output Rules

### Hook Input Structure

All hooks receive standardized input in JSON format through stdin:

```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "hook_event_name": "string",
  "timestamp": "string"
}
```

Event-specific fields are added based on the hook type. Here are detailed specifications for each hook event:

### Individual Hook Event Details

#### PreToolUse

**Purpose**: Executed before a tool is used to allow for permission checks, input validation, or context injection.

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "PreToolUse",
  "timestamp": "ISO 8601 timestamp",
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
    "permissionDecision": "allow",
    "permissionDecisionReason": "My reason here",
    "updatedInput": {
      "field_to_modify": "new value"
    },
    "additionalContext": "Current environment: production. Proceed with caution."
  }
}
```

#### PostToolUse

**Purpose**: Executed after a tool completes successfully to process results, log outcomes, or inject additional context.

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "PostToolUse",
  "timestamp": "ISO 8601 timestamp",
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

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "PostToolUseFailure",
  "timestamp": "ISO 8601 timestamp",
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

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "UserPromptSubmit",
  "timestamp": "ISO 8601 timestamp",
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

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "SessionStart",
  "timestamp": "ISO 8601 timestamp",
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

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "SessionEnd",
  "timestamp": "ISO 8601 timestamp",
  "reason": "clear | logout | prompt_input_exit | bypass_permissions_disabled | other"
}
```

**Output Options**:

- Standard hook output fields (typically not used for blocking)

#### Stop

**Purpose**: Executed before Qwen concludes its response to provide final feedback or summaries.

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "Stop",
  "timestamp": "ISO 8601 timestamp",
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

#### SubagentStart

**Purpose**: Executed when a subagent (like the Task tool) is started to set up context or permissions.

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "SubagentStart",
  "timestamp": "ISO 8601 timestamp",
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

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "SubagentStop",
  "timestamp": "ISO 8601 timestamp",
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

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "PreCompact",
  "timestamp": "ISO 8601 timestamp",
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

#### Notification

**Purpose**: Executed when notifications are sent to customize or intercept them.

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "Notification",
  "timestamp": "ISO 8601 timestamp",
  "message": "notification message content",
  "title": "notification title (optional)",
  "notification_type": "permission_prompt | idle_prompt | auth_success | elicitation_dialog"
}
```

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

**Input**:

```json
{
  "session_id": "session identifier",
  "transcript_path": "path to session transcript",
  "cwd": "current working directory",
  "hook_event_name": "PermissionRequest",
  "timestamp": "ISO 8601 timestamp",
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

## Hook Configuration

Hooks are configured in Qwen Code settings, typically in `.qwen/settings.json` or user configuration files:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^bash$", // Regex to match tool names
        "sequential": false, // Whether to run hooks sequentially
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.sh",
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

### Matcher Patterns

Matchers allow filtering hooks based on context:

- Tool events (`PreToolUse`, `PostToolUse`, etc.): Match against tool name using regex
- Subagent events: Match against agent type using regex
- Session events: Match against trigger/source using regex

Empty or "\*" matchers apply to all events of that type.

## Hook Execution

### Parallel vs Sequential Execution

- By default, hooks execute in parallel for better performance
- Use `sequential: true` in hook definition to enforce order-dependent execution
- Sequential hooks can modify input for subsequent hooks in the chain

### Security Model

- Hooks run in the user's environment with user privileges
- Project-level hooks require trusted folder status
- Timeouts prevent hanging hooks (default: 60 seconds)

## Example Complete Hook

Here's a complete example of a PreToolUse hook script that logs and potentially blocks dangerous commands:

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
    "decision": "deny",
    "reason": "Potentially dangerous operation detected",
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Dangerous command blocked by security policy"
    }
  }'
  exit 2  # Blocking error
fi

# Allow the operation with a log
echo "INFO: Tool $TOOL_NAME executed safely at $(date)" >> /var/log/qwen-security.log

# Allow with additional context
echo '{
  "decision": "allow",
  "reason": "Operation approved by security checker",
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

## Troubleshooting

- Check application logs for hook execution details
- Verify hook script permissions and executability
- Ensure proper JSON formatting in hook outputs
- Use specific matcher patterns to avoid unintended hook execution

## Limitations

- Currently only supports command-type hooks (shell scripts, executables)
- No built-in UI for managing hooks (configuration via settings files)
- Sequential hooks may significantly impact performance
