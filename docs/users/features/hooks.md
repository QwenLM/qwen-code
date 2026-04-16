# Qwen Code Hooks Documentation

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

## Hook Architecture

The Qwen Code hook system consists of several key components:

1. **Hook Registry**: Stores and manages all configured hooks
2. **Hook Planner**: Determines which hooks should run for each event
3. **Hook Runner**: Executes individual hooks with proper context
4. **Hook Aggregator**: Combines results from multiple hooks
5. **Hook Event Handler**: Coordinates the firing of hooks for events

## Hook Events

Hooks fire at specific points during a Qwen Code session. When an event fires and a matcher matches, Qwen Code passes JSON context about the event to your hook handler. For command hooks, input arrives on stdin. Your handler can inspect the input, take action, and optionally return a decision. Some events fire once per session, while others fire repeatedly inside the agentic loop.

<div align="center">
<img src="https://img.alicdn.com/imgextra/i4/O1CN01sYWUTh1RDJl7Lz2ne_!!6000000002077-2-tps-812-1212.png" alt="Hook Lifecycle Diagram" width="400"/>
</div>

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

All hooks receive standardized input in JSON format through stdin. Common fields included in every hook event:

```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "hook_event_name": "string",
  "timestamp": "string"
}
```

Event-specific fields are added based on the hook type. Below are the event-specific fields for each hook event:

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

Matchers allow filtering hooks based on context. Not all hook events support matchers:

| Event Type          | Events                                                                 | Matcher Support | Matcher Target (Values)                                                                |
| ------------------- | ---------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| Tool Events         | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest` | ✅ Yes (regex)  | Tool name: `bash`, `read_file`, `write_file`, `edit`, `glob`, `grep_search`, etc.      |
| Subagent Events     | `SubagentStart`, `SubagentStop`                                        | ✅ Yes (regex)  | Agent type: `Bash`, `Explorer`, etc.                                                   |
| Session Events      | `SessionStart`                                                         | ✅ Yes (regex)  | Source: `startup`, `resume`, `clear`, `compact`                                        |
| Session Events      | `SessionEnd`                                                           | ✅ Yes (regex)  | Reason: `clear`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other` |
| Notification Events | `Notification`                                                         | ✅ Yes (exact)  | Type: `permission_prompt`, `idle_prompt`, `auth_success`                               |
| Compact Events      | `PreCompact`                                                           | ✅ Yes (exact)  | Trigger: `manual`, `auto`                                                              |
| Prompt Events       | `UserPromptSubmit`                                                     | ❌ No           | N/A                                                                                    |
| Stop Events         | `Stop`                                                                 | ❌ No           | N/A                                                                                    |

**Matcher Syntax**:

- Regex pattern matched against the target field
- Empty string `""` or `"*"` matches all events of that type
- Standard regex syntax supported (e.g., `^bash$`, `read.*`, `(bash|run_shell_command)`)

**Examples**:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^bash$",           // Only match bash tool
        "hooks": [...]
      },
      {
        "matcher": "read.*",           // Match read_file, read_multiple_files, etc.
        "hooks": [...]
      },
      {
        "matcher": "",                 // Match all tools (same as "*" or omitting matcher)
        "hooks": [...]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "^(Bash|Explorer)$", // Only match Bash and Explorer agents
        "hooks": [...]
      }
    ],
    "SessionStart": [
      {
        "matcher": "^(startup|resume)$", // Only match startup and resume sources
        "hooks": [...]
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

### Security Model

- Hooks run in the user's environment with user privileges
- Project-level hooks require trusted folder status
- Timeouts prevent hanging hooks (default: 60 seconds)

### Exit Codes

Hook scripts communicate their result through exit codes:

| Exit Code | Meaning            | Behavior                                        |
| --------- | ------------------ | ----------------------------------------------- |
| `0`       | Success            | stdout/stderr not shown                         |
| `2`       | Blocking error     | Show stderr to model and block tool call        |
| Other     | Non-blocking error | Show stderr to user only but continue tool call |

**Examples**:

```bash
#!/bin/bash

# Success (exit 0 is default, can be omitted)
echo '{"decision": "allow"}'
exit 0

# Blocking error - prevents operation
echo "Dangerous operation blocked by security policy" >&2
exit 2
```

> **Note**: If no exit code is specified, the script defaults to `0` (success).

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

### Example 2: User Prompt Validation Hook

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

## Prompt Hooks

In addition to command hooks, Qwen Code supports **prompt hooks** that use an LLM to evaluate conditions and make decisions. Prompt hooks are particularly useful for complex security checks, content moderation, and intelligent decision-making that requires natural language understanding.

### How Prompt Hooks Work

Prompt hooks send the hook context to an LLM with a custom prompt template. The LLM evaluates the input and returns a structured JSON response indicating whether to allow or block the operation.

### Prompt Hook Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "hooks": [
          {
            "type": "prompt",
            "name": "security-check",
            "prompt": "Check if the following command is dangerous:\n\n$ARGUMENTS\n\nIf the command contains dangerous operations (rm -rf, format, system-critical operations), return {\"ok\": false, \"reason\": \"dangerous operation\"}\nOtherwise return {\"ok\": true}",
            "model": "qwen-turbo",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

### Configuration Fields

| Field     | Type   | Description                                                           |
| --------- | ------ | --------------------------------------------------------------------- |
| `type`    | string | Must be `"prompt"`                                                    |
| `prompt`  | string | LLM prompt template. Use `$ARGUMENTS` placeholder for hook input JSON |
| `model`   | string | Optional. Model to use (defaults to fast model)                       |
| `name`    | string | Optional. Hook name for identification                                |
| `timeout` | number | Optional. Timeout in milliseconds (default: 30000)                    |

### Response Format

Prompt hooks must return valid JSON with the following structure:

```json
// Allow operation
{"ok": true}

// Block operation with reason
{"ok": false, "reason": "Reason for blocking"}
```

> **Important**: Only `ok` (required) and `reason` (optional) fields are allowed. Additional fields will cause validation errors.

### Complete Examples

#### Example 1: File Write Protection

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file",
        "hooks": [
          {
            "type": "prompt",
            "name": "file-write-guard",
            "prompt": "Check the file write operation:\n$ARGUMENTS\n\nBlock if writing to:\n1. System files (/etc/, /usr/)\n2. User home directory config files\n3. Files with sensitive names\n\nReturn JSON: {\"ok\": true} or {\"ok\": false, \"reason\": \"...\"}",
            "model": "qwen-turbo"
          }
        ]
      }
    ]
  }
}
```

#### Example 2: Network Request Audit

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "web_fetch|web_search",
        "hooks": [
          {
            "type": "prompt",
            "name": "network-auditor",
            "prompt": "Audit the network request:\n$ARGUMENTS\n\nCheck:\n1. Is the URL trusted?\n2. Does it contain malicious domains?\n3. Does it comply with company policy?\n\nReturn: {\"ok\": true/false, \"reason\": \"...\"}",
            "timeout": 15000
          }
        ]
      }
    ]
  }
}
```

#### Example 3: Sensitive Information Filter (UserPromptSubmit)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "prompt",
            "name": "sensitive-info-filter",
            "prompt": "Check if user input contains sensitive information:\n\n$ARGUMENTS\n\nSensitive information includes:\n- API keys, passwords\n- ID numbers, phone numbers\n- Credit card numbers\n- Personal privacy information\n\nIf detected, return: {\"ok\": false, \"reason\": \"Contains sensitive information: [type]\"}\nOtherwise return: {\"ok\": true}",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

### Debugging Prompt Hooks

#### Enable Debug Logging

```bash
# View prompt hook logs
DEBUG=qwen:prompt_hook npm start

# View all hook-related logs
DEBUG=TRUSTED_HOOKS,PROMPT_HOOK npm start
```

#### Test Hook Response Format

Create a test script to verify hook behavior:

```bash
cat > test-hook.sh << 'EOF'
#!/bin/bash
# Simulate hook input
echo '{
  "tool_name": "bash",
  "command": "rm -rf /tmp/test",
  "cwd": "/Users/test"
}' | node -e "
const input = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
console.log('Received input:', JSON.stringify(input, null, 2));

// Simulate LLM response
const response = { ok: false, reason: 'Dangerous operation detected' };
console.log('Expected response:', JSON.stringify(response));
"
EOF

chmod +x test-hook.sh
./test-hook.sh
```

### Performance Optimization

1. **Use Fast Models**: For simple checks, use `qwen-turbo` instead of larger models

2. **Precise Matchers**: Reduce unnecessary hook triggers with specific patterns

```json
{
  "matcher": "^bash$"
}
```

3. **Set Appropriate Timeouts**: Don't wait too long for LLM responses

```json
{
  "timeout": 10000
}
```

### Common Issues

#### Q: Hook response format errors?

A: Ensure your JSON response contains only `ok` and optional `reason`:

```json
// ✅ Valid
{"ok": true}
{"ok": false, "reason": "Reason"}

// ❌ Invalid (extra fields)
{"ok": true, "extra": "field"}
```

#### Q: Hook not triggering?

A:

1. Check if the project folder is trusted (project hooks require trust)
2. Verify the matcher pattern matches the tool name
3. Enable debug logging to see what's happening

#### Q: Hook executing too slowly?

A:

1. Use a faster model (`qwen-turbo`)
2. Reduce prompt length
3. Lower the timeout value
4. Use more precise matchers

## Troubleshooting

- Check application logs for hook execution details
- Verify hook script permissions and executability
- Ensure proper JSON formatting in hook outputs
- Use specific matcher patterns to avoid unintended hook execution
